import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { eq } from "drizzle-orm";
import { runMigrations } from "../src/migrate.js";
import { schema, accounts } from "../src/schema.js";
import { mailboxOauthCeremonies, oauthProviderConfig, staffUsers } from "../src/schema-cloud.js";
import {
  consumeOAuthCeremony, createOAuthCeremony, pruneOAuthCeremonies,
  OAUTH_CEREMONY_TTL_MS, OAUTH_CEREMONY_RETENTION_MS,
} from "../src/oauth-ceremony.js";
import { readOAuthProviderConfig, writeOAuthProviderConfig } from "../src/oauth-config.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * CLOUD 0009 — THE ONE THING PGlite CANNOT SEE: two browsers redeeming ONE authorization code.
 *
 * `consumeOAuthCeremony` is a single statement —
 * `UPDATE … SET consumed_at = now WHERE state = $1 AND consumed_at IS NULL RETURNING …` — and the
 * claim it makes is that N concurrent callers produce exactly ONE winner. A `SELECT … then UPDATE`
 * implementation makes the same claim and is wrong, and **PGlite cannot tell them apart**: it is a
 * single in-process connection, so there is nothing to interleave and the read-then-write version
 * passes there identically. This repository has spent three production bugs on precisely that
 * blindness (CLAUDE.md: *"PGlite green means nothing for transactional code"*).
 *
 * So the decisive case runs here, on :5433, over SEPARATE CONNECTIONS, and the mutation that proves
 * it is a real guard is stated in the test: rewrite the consume as a read-then-write and the
 * `winners.length === 1` assertion goes to 2+ under `Promise.all`.
 *
 * The second half of the file is the CONFIG STORE's partial-write property, which is also not a
 * PGlite question but is here because it belongs to the same migration: an absent field must LEAVE
 * WHATEVER IS STORED ALONE. That is what makes the console's write-only secret field work, and
 * getting it backwards turns "the operator toggled a switch" into "the operator erased the
 * registration" — the identical defect `upsertCredOn` fixed for `mailbox_credentials.meta`.
 */
const PG_UP = await realPgAvailable();

const sqlA = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");

/**
 * EIGHT SEPARATE CLIENTS, each `max: 1` — and this is not belt-and-braces, it is the difference
 * between a concurrency test and a test that looks like one.
 *
 * `Promise.all` over eight queries issued through ONE pooled `postgres()` client does NOT put eight
 * backends on the row: postgres-js PIPELINES them, so the server executes them in order on a single
 * connection. Measured on 2026-08-10 by mutating {@link consumeOAuthCeremony} into the
 * `SELECT … then UPDATE` form this file exists to refuse — and it stayed GREEN, because the eight
 * SELECTs never overlapped. That is the "guard whose exit code comes from the harness rather than
 * from reality" failure, in the one test written specifically to avoid it.
 *
 * One client per caller, `max: 1`, is the shape `imap-admission.at2.pg.test.ts` and
 * `change-log.concurrency.pg.test.ts` already use, and with it the mutation fails as it must.
 */
const RACERS = 8;
const racerClients = Array.from({ length: RACERS }, () => postgres(PG_TEST_URL, { max: 1, onnotice: () => {} }));
const racers = racerClients.map((c) => brandDialect(drizzle(c, { schema }), "pg"));

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => {
  await sqlA.end({ timeout: 5 });
  await Promise.all(racerClients.map((c) => c.end({ timeout: 5 })));
});

const NOW = new Date("2026-08-10T12:00:00.000Z");

async function seedAccount(): Promise<string> {
  const [a] = await dbA.insert(accounts).values({ name: `oauth-${randomUUID().slice(0, 8)}` }).returning();
  return a!.id;
}

async function seedCeremony(accountId: string, createdAt: Date = NOW): Promise<string> {
  const state = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  await createOAuthCeremony(dbA, {
    state,
    accountId,
    provider: "microsoft",
    codeVerifierEnc: "enc:verifier",
    codeVerifierKeyVersion: 1,
    returnTo: "/mailbox",
    now: createdAt,
  });
  return state;
}

describe.skipIf(!PG_UP)("cloud 0009 — the ceremony is consumed EXACTLY ONCE under real concurrency", () => {
  it("eight concurrent consumes of one state yield exactly one winner", async () => {
    const accountId = await seedAccount();
    const state = await seedCeremony(accountId);

    /*
     * EIGHT DISTINCT CLIENTS — see {@link racers}. Eight rather than two because the failure this is
     * about is a lost update and a two-way race can be won by luck; and distinct clients rather than
     * one pool because postgres-js pipelines a pool's queries onto one connection, which makes a
     * read-then-write implementation pass. Both facts were established by mutation, not by reading.
     */
    const outcomes = await Promise.all(racers.map((db) => consumeOAuthCeremony(db, { state, now: NOW })));

    const winners = outcomes.filter((o) => o.outcome === "ok");
    expect(winners, "exactly one caller may spend a ceremony").toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === "unknown")).toHaveLength(RACERS - 1);
    expect(winners[0]!.outcome === "ok" && winners[0]!.row.accountId).toBe(accountId);

    // The row is stamped ONCE. `consumed_at` is a timestamp rather than a boolean precisely so a
    // replay attempt is datable, and the stamp must be the winner's.
    const [row] = await dbA.select().from(mailboxOauthCeremonies)
      .where(eq(mailboxOauthCeremonies.state, state));
    expect(row!.consumedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("a state that never existed and a state already spent are the SAME answer", async () => {
    const accountId = await seedAccount();
    const state = await seedCeremony(accountId);
    expect((await consumeOAuthCeremony(dbA, { state, now: NOW })).outcome).toBe("ok");
    // Both `unknown` — distinguishing them would make the callback an oracle for whether a given
    // 256-bit value was ever issued.
    expect((await consumeOAuthCeremony(dbA, { state, now: NOW })).outcome).toBe("unknown");
    expect((await consumeOAuthCeremony(dbA, { state: "never-issued-".padEnd(43, "x"), now: NOW })).outcome)
      .toBe("unknown");
    // …and an empty state never matches a row, whatever the column holds.
    expect((await consumeOAuthCeremony(dbA, { state: "", now: NOW })).outcome).toBe("unknown");
  });

  it("an EXPIRED ceremony is a distinct answer, and it is still consumed", async () => {
    const accountId = await seedAccount();
    const old = new Date(NOW.getTime() - OAUTH_CEREMONY_TTL_MS - 1_000);
    const state = await seedCeremony(accountId, old);

    const first = await consumeOAuthCeremony(dbA, { state, now: NOW });
    // NOT `unknown`. The TTL is judged on the RETURNED row rather than inside the UPDATE, because a
    // `created_at > now - ttl` predicate would collapse "that took too long" into "that link is not
    // valid" and only one of those two is actionable.
    expect(first.outcome).toBe("expired");
    expect(first.outcome === "expired" && first.row.returnTo).toBe("/mailbox");
    // The aged-out row is DEAD FOR GOOD, not dead until the clock is nudged.
    expect((await consumeOAuthCeremony(dbA, { state, now: NOW })).outcome).toBe("unknown");
  });

  it("the prune drops rows past retention and leaves live ones — including UNCONSUMED ones", async () => {
    const accountId = await seedAccount();
    const stale = await seedCeremony(accountId, new Date(NOW.getTime() - OAUTH_CEREMONY_RETENTION_MS - 1_000));
    const fresh = await seedCeremony(accountId, NOW);

    await pruneOAuthCeremonies(dbA, { now: NOW });

    const left = await dbA.select().from(mailboxOauthCeremonies)
      .where(eq(mailboxOauthCeremonies.accountId, accountId));
    expect(left.map((r) => r.state)).toEqual([fresh]);
    expect(left.map((r) => r.state)).not.toContain(stale);
    // The pruned row was never consumed — an abandoned ceremony (somebody closed the consent tab) is
    // exactly half the prune's input, which is why the predicate is not `consumed_at IS NOT NULL`.
  });
});

describe.skipIf(!PG_UP)("cloud 0009 — the registration store's partial write", () => {
  it("an ABSENT field leaves the stored value alone; only an explicit null clears the secret", async () => {
    const [staff] = await dbA.insert(staffUsers)
      .values({ email: `ops-${randomUUID().slice(0, 8)}@ohmail.app`, passwordHash: "seeded-row-password-hash" })
      .returning({ id: staffUsers.id });
    // The store is a SINGLETON per provider, so this test owns the one `microsoft` row for the run.
    await dbA.delete(oauthProviderConfig).where(eq(oauthProviderConfig.provider, "microsoft"));

    await writeOAuthProviderConfig(dbA, {
      clientId: "client-1",
      tenant: "common",
      redirectUris: ["https://ohmail.app/api/mailboxes/oauth/microsoft/callback"],
      clientSecret: { ciphertext: "enc:secret-1", keyVersion: 3 },
      enabled: true,
      updatedBy: staff!.id,
      note: "first save",
      now: NOW,
    });

    // A SAVE THAT ONLY FLIPS THE SWITCH. This is the console's real second request, and the failure
    // it must not have is erasing everything it did not mention.
    const later = new Date(NOW.getTime() + 60_000);
    await writeOAuthProviderConfig(dbA, { enabled: false, updatedBy: staff!.id, note: "paused", now: later });

    const after = await readOAuthProviderConfig(dbA, "microsoft");
    expect(after!.enabled).toBe(false);
    expect(after!.clientId).toBe("client-1");
    expect(after!.tenant).toBe("common");
    expect(after!.redirectUris).toEqual(["https://ohmail.app/api/mailboxes/oauth/microsoft/callback"]);
    // THE SECRET SURVIVED. The form's secret field is write-only, so it submits nothing unless
    // somebody typed a new value; an `undefined` that cleared the column would silently take the
    // whole fleet's token refresh down at the next hour boundary.
    expect(after!.clientSecretEnc).toBe("enc:secret-1");
    expect(after!.clientSecretKeyVersion).toBe(3);
    expect(after!.updatedAt.toISOString()).toBe(later.toISOString());
    expect(after!.note).toBe("paused");

    // An EXPLICIT null is the one way to clear it — and it clears BOTH columns, which is what the
    // migration's `oauth_provider_config_secret_sealed_together` CHECK requires. A writer that
    // nulled only the ciphertext would raise 23514 here rather than storing an undecryptable half.
    await writeOAuthProviderConfig(dbA, { clientSecret: null, updatedBy: staff!.id, note: "cleared", now: later });
    const cleared = await readOAuthProviderConfig(dbA, "microsoft");
    expect(cleared!.clientSecretEnc).toBeNull();
    expect(cleared!.clientSecretKeyVersion).toBeNull();
  });

  it("the sealed-together CHECK is real — a half-written secret is refused by the database", async () => {
    // Asserted directly against the constraint rather than through the writer, because the writer is
    // what the constraint exists to backstop. A guard nobody has watched fail is not evidence.
    await dbA.delete(oauthProviderConfig).where(eq(oauthProviderConfig.provider, "half"));
    await expect(
      dbA.insert(oauthProviderConfig).values({
        provider: "half",
        clientSecretEnc: "enc:orphan",
        // …and no key version, so the envelope can never be opened.
      }),
    ).rejects.toThrow(/oauth_provider_config_secret_sealed_together|violates check constraint/i);
  });
});
