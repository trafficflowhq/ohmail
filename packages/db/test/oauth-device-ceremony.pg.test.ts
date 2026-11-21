import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { eq } from "drizzle-orm";
import { runMigrations } from "../src/migrate.js";
import { schema, accounts } from "../src/schema.js";
import { mailboxOauthCeremonies, mailboxOauthDeviceCeremonies } from "../src/schema-cloud.js";
import {
  deviceCeremonyKey, createDeviceCeremony, readDeviceCeremony, leaseDeviceCeremonyPoll,
  type DeviceCeremonyScope,
  noteDeviceCeremonySlowDown, claimDeviceCeremony, pruneDeviceCeremonies,
  DEVICE_CEREMONY_RETENTION_MS,
  createOAuthCeremony, consumeOAuthCeremony,
} from "../src/oauth-ceremony.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * CLOUD 0027 — THE DEVICE CEREMONY'S TWO DIRECTIONS, PINNED, ON REAL POSTGRES.
 *
 * The device flow adds a NON-CONSUMING read to a store whose whole security property was that a
 * ceremony is spent by the request that reads it. Both halves of that have to hold at once, and
 * PGlite can prove neither:
 *
 *  · **THE POLL MUST NOT CONSUME.** A ceremony read N times is live on the Nth. A consuming read
 *    passes a happy-path test and breaks the second poll, which is where the flow lives.
 *  · **THE CLAIM MUST STILL BE SINGLE-USE**, under real concurrency — N callers, exactly one
 *    winner — and so must the redirect flow's own consume, which this change must not weaken.
 *  · **THE POLL LEASE MUST BE ATOMIC.** `last_polled_at + interval <= now` sits in the UPDATE's own
 *    predicate so two concurrent polls serialize on the row and only one reaches Microsoft. A
 *    read-then-write version of that check has a window exactly the width of a round trip to
 *    Microsoft — which is precisely the window two browser tabs occupy — and it passes identically
 *    on a single-connection engine.
 *
 * CLAUDE.md: *"PGlite green means nothing for transactional code."* Three production bugs were
 * invisible to it. So the decisive cases run here, on :5433, over SEPARATE CONNECTIONS.
 *
 * ── AND THE REDIRECT ARM IS RE-ASSERTED IN THIS FILE, DELIBERATELY ────────────────────────
 *
 * `oauth-ceremony.pg.test.ts` already proves the redirect flow's consume-once. It is proved AGAIN at
 * the end of this file, beside the device arm, because the risk this change introduces is not that
 * either property is wrong today — it is that a later reader, holding one module with two
 * disciplines in it, makes them one. A test that shows both laws in one place is what makes that
 * diff obviously wrong instead of plausibly tidy.
 */
const PG_UP = await realPgAvailable();

const sqlA = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");

/**
 * EIGHT SEPARATE CLIENTS, each `max: 1` — and this is the difference between a concurrency test and
 * a test that looks like one.
 *
 * `Promise.all` over eight queries through ONE pooled `postgres()` client does NOT put eight
 * backends on the row: postgres-js PIPELINES them, so the server executes them in order on a single
 * connection. Measured on this repository's redirect-flow guard by mutating its consume into a
 * `SELECT … then UPDATE` — it stayed GREEN, because the eight SELECTs never overlapped. One client
 * per caller is the shape that makes the mutation fail as it must.
 */
const RACERS = 8;
const racerClients = Array.from({ length: RACERS }, () => postgres(PG_TEST_URL, { max: 1, onnotice: () => {} }));
const racers = racerClients.map((c) => brandDialect(drizzle(c, { schema }), "pg"));

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => {
  await sqlA.end({ timeout: 5 });
  await Promise.all(racerClients.map((c) => c.end({ timeout: 5 })));
});

const NOW = new Date("2026-09-01T12:00:00.000Z");
const GRANT_TTL_MS = 900_000;

async function seedAccount(): Promise<string> {
  const [a] = await dbA.insert(accounts).values({ name: `dev-${randomUUID().slice(0, 8)}` }).returning();
  return a!.id;
}

async function seedDevice(
  accountId: string,
  over: { createdAt?: Date; expiresAt?: Date; intervalMs?: number } = {},
): Promise<DeviceCeremonyScope> {
  const state = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const scope = { state, accountId, sessionId: randomUUID() };
  const createdAt = over.createdAt ?? NOW;
  await createDeviceCeremony(dbA, {
    ...scope,
    provider: "microsoft",
    deviceCodeEnc: "enc:device-code",
    deviceCodeKeyVersion: 1,
    userCode: "ABCD-EFGH",
    verificationUri: "https://microsoft.com/devicelogin",
    pollIntervalMs: over.intervalMs ?? 5_000,
    grantExpiresAt: over.expiresAt ?? new Date(createdAt.getTime() + GRANT_TTL_MS),
    now: createdAt,
  });
  return scope;
}

const rowOf = async (scope: DeviceCeremonyScope) => {
  const [row] = await dbA.select().from(mailboxOauthDeviceCeremonies)
    .where(eq(mailboxOauthDeviceCeremonies.state, deviceCeremonyKey(scope)));
  return row;
};

describe.skipIf(!PG_UP)("cloud 0027 — DIRECTION ONE: the poll READS WITHOUT CONSUMING", () => {
  it("only reads a ceremony within its account and session", async () => {
    const accountId = await seedAccount();
    const owner = { ...await seedDevice(accountId), now: NOW };
    const anotherAccount = { ...owner, accountId: await seedAccount() };
    const anotherSession = { ...owner, sessionId: randomUUID() };

    expect((await readDeviceCeremony(dbA, owner)).outcome).toBe("ok");
    expect((await readDeviceCeremony(dbA, anotherAccount)).outcome).toBe("unknown");
    expect((await readDeviceCeremony(dbA, anotherSession)).outcome).toBe("unknown");
  });

  it("a hundred reads leave the ceremony live, and consumed_at NULL throughout", async () => {
    /*
     * Many rather than three, because the real number is every read of a ceremony: fifteen
     * minutes at a five-second interval. If anything about the read is destructive or wears out, the
     * ordinary case is the one that hits it.
     *
     * MUTATION: make `readDeviceCeremony` an `UPDATE … SET consumed_at = now RETURNING` and this
     * goes red on the second iteration.
     */
    const accountId = await seedAccount();
    const scope = await seedDevice(accountId);

    for (let i = 0; i < 100; i++) {
      const r = await readDeviceCeremony(dbA, { ...scope, now: NOW });
      expect(r.outcome, `read ${i}`).toBe("ok");
      expect(r.outcome === "ok" && r.row.accountId).toBe(accountId);
      expect((await rowOf(scope))!.consumedAt, `read ${i} must not consume`).toBeNull();
    }
  });

  it("EIGHT CONCURRENT reads all succeed — a read has no single winner", async () => {
    // The mirror image of the claim's property, and worth asserting separately: a reader that
    // accidentally became a claimer would show up here as seven losers, which is exactly what the
    // claim test below demands and exactly what a poll must not do.
    const accountId = await seedAccount();
    const scope = await seedDevice(accountId);

    const outcomes = await Promise.all(racers.map((db) => readDeviceCeremony(db, { ...scope, now: NOW })));
    expect(outcomes.filter((o) => o.outcome === "ok")).toHaveLength(RACERS);
    expect((await rowOf(scope))!.consumedAt).toBeNull();
  });

  it("a read past the grant's own deadline is EXPIRED, still without consuming", async () => {
    // Expiry is a VERDICT from the read and a CLAIM from the caller — the read itself stays pure, so
    // the caller decides whether this is the moment to spend the ceremony. Keeping the write out of
    // the read is what lets the same function serve the pending path and the terminal one.
    const accountId = await seedAccount();
    const scope = await seedDevice(accountId);
    const late = new Date(NOW.getTime() + GRANT_TTL_MS + 1_000);

    const r = await readDeviceCeremony(dbA, { ...scope, now: late });
    expect(r.outcome).toBe("expired");
    expect((await rowOf(scope))!.consumedAt).toBeNull();
  });

  it("a `slow_down` write moves the interval and NOTHING else", async () => {
    const accountId = await seedAccount();
    const scope = await seedDevice(accountId);
    const before = (await rowOf(scope))!;

    await noteDeviceCeremonySlowDown(dbA, { ...scope, stepMs: 5_000, ceilingMs: 60_000 });

    const after = (await rowOf(scope))!;
    expect(after.pollIntervalMs).toBe(10_000);   // the start plus one slow_down step
    // A `slow_down` is an instruction to keep going more slowly, not a terminal verdict.
    expect(after.consumedAt).toBeNull();
    // …and it touches none of the ceremony's identity or its credential.
    expect(after.deviceCodeEnc).toBe(before.deviceCodeEnc);
    expect(after.grantExpiresAt.toISOString()).toBe(before.grantExpiresAt.toISOString());
    expect(after.userCode).toBe(before.userCode);
  });
});

describe.skipIf(!PG_UP)("cloud 0027 — DIRECTION TWO: the TERMINAL claim is single-use under real concurrency", () => {
  it("eight concurrent claims of one ceremony yield exactly one winner", async () => {
    /*
     * The property that stops two polls both storing a mailbox. Same statement shape as the redirect
     * flow's consume — `UPDATE … WHERE state = $1 AND consumed_at IS NULL RETURNING` — so Postgres
     * serializes the eight on the row lock and seven re-evaluate the predicate against the committed
     * value.
     *
     * MUTATION: rewrite `claimDeviceCeremony` as a SELECT followed by an UPDATE and
     * `winners.length === 1` goes to 2+ here. It stays green on PGlite, which is why this file
     * exists.
     */
    const accountId = await seedAccount();
    const scope = await seedDevice(accountId);

    const outcomes = await Promise.all(racers.map((db) => claimDeviceCeremony(db, { ...scope, now: NOW })));

    const winners = outcomes.filter((o) => o.outcome === "ok");
    expect(winners, "exactly one caller may spend a device ceremony").toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === "unknown")).toHaveLength(RACERS - 1);
    expect(winners[0]!.outcome === "ok" && winners[0]!.row.accountId).toBe(accountId);
    // Stamped ONCE, and datable — a replay attempt is worth being able to date.
    expect((await rowOf(scope))!.consumedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("a claimed ceremony is invisible to the READ — spent and never-issued are one answer", async () => {
    // Distinguishing them would be an oracle for whether a given 256-bit value was ever issued.
    const accountId = await seedAccount();
    const scope = await seedDevice(accountId);
    expect((await claimDeviceCeremony(dbA, { ...scope, now: NOW })).outcome).toBe("ok");

    expect((await readDeviceCeremony(dbA, { ...scope, now: NOW })).outcome).toBe("unknown");
    expect((await claimDeviceCeremony(dbA, { ...scope, now: NOW })).outcome).toBe("unknown");
    expect((await readDeviceCeremony(dbA, { ...scope, state: "never-issued".padEnd(43, "x"), now: NOW })).outcome)
      .toBe("unknown");
    // …and an empty state never matches a row, whatever the column holds.
    expect((await readDeviceCeremony(dbA, { ...scope, state: "", now: NOW })).outcome).toBe("unknown");
    expect((await claimDeviceCeremony(dbA, { ...scope, state: "", now: NOW })).outcome).toBe("unknown");
  });
});

describe.skipIf(!PG_UP)("cloud 0027 — the POLL LEASE is atomic, which is the shared client id's protection", () => {
  it("eight concurrent polls of one ceremony take the slot ONCE", async () => {
    /*
     * THE CASE PGlite CANNOT SEE, and the one that matters most in practice: two browser tabs on one
     * ceremony, or a client that fires again before the first answer lands. The predicate
     * `last_polled_at IS NULL OR last_polled_at + interval <= now` is inside the UPDATE, so eight
     * concurrent callers serialize and exactly one is allowed to spend a request on Microsoft.
     *
     * The application being throttled is SHARED by every install using the public registration, so
     * "seven extra requests" is not a local inefficiency — it is a throttle other people's servers
     * feel, arriving as an unexplained failure somewhere else entirely.
     *
     * MUTATION: read the row, compare in JS, then UPDATE — and this goes to 8 winners here while
     * staying at 1 on PGlite.
     */
    const accountId = await seedAccount();
    const scope = await seedDevice(accountId);

    const outcomes = await Promise.all(racers.map((db) => leaseDeviceCeremonyPoll(db, { ...scope, now: NOW })));
    expect(outcomes.filter((o) => o.outcome === "ok"), "one poll slot per interval").toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === "denied")).toHaveLength(RACERS - 1);
    // The lease is a WRITE, but never a claim: `consumed_at` is not in its `SET`.
    expect((await rowOf(scope))!.consumedAt).toBeNull();
    expect((await rowOf(scope))!.lastPolledAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("the fence opens exactly at the interval, and moves when a slow_down widens it", async () => {
    const accountId = await seedAccount();
    const scope = await seedDevice(accountId);

    expect((await leaseDeviceCeremonyPoll(dbA, { ...scope, now: NOW })).outcome).toBe("ok");
    // One millisecond early is early. The boundary is asserted on both sides because an off-by-one
    // here is either a permanent stall or no fence at all.
    const early = new Date(NOW.getTime() + 4_999);
    expect((await leaseDeviceCeremonyPoll(dbA, { ...scope, now: early })).outcome).toBe("denied");
    const due = new Date(NOW.getTime() + 5_000);
    expect((await leaseDeviceCeremonyPoll(dbA, { ...scope, now: due })).outcome).toBe("ok");

    // Now Microsoft asks for more room. The row's OWN interval is what the predicate reads, so the
    // widened value fences the next poll without the caller having to remember it.
    // Three steps from the first interval gets to the widened one, applied in SQL rather than assigned.
    for (let i = 0; i < 3; i++) await noteDeviceCeremonySlowDown(dbA, { ...scope, stepMs: 5_000, ceilingMs: 60_000 });
    const oldInterval = new Date(due.getTime() + 5_000);
    expect((await leaseDeviceCeremonyPoll(dbA, { ...scope, now: oldInterval })).outcome).toBe("denied");
    const newInterval = new Date(due.getTime() + 20_000);
    expect((await leaseDeviceCeremonyPoll(dbA, { ...scope, now: newInterval })).outcome).toBe("ok");
  });

  it("CONCURRENT slow_downs each add their step — no increment is lost", async () => {
    /*
     * FOUND BY REVIEW, and the losing case is ordinary rather than exotic: two polls one interval
     * apart, the first still waiting on Microsoft, both read 5 000, both are told `slow_down`. With
     * the interval COMPUTED IN THE CALLER and assigned, both write the same widened value — two instructions to slow
     * down produce one five-second increase, and the next poll is permitted earlier than Microsoft's
     * cumulative answers require, against a client id shared with every other install.
     *
     * `LEAST(poll_interval_ms + step, ceiling)` inside the UPDATE makes it read-modify-write in one
     * statement, so Postgres serializes the eight and each one increments the previous committed
     * value.
     *
     * MUTATION: go back to `.set({ pollIntervalMs: <computed> })` and this reads one step, not two.
     */
    const accountId = await seedAccount();
    const scope = await seedDevice(accountId);   // starts at the default interval

    const results = await Promise.all(
      racers.map((db) => noteDeviceCeremonySlowDown(db, { ...scope, stepMs: 5_000, ceilingMs: 60_000 })),
    );
    expect(results.every((r) => r !== null)).toBe(true);
    // The start plus two steps, under the ceiling.
    expect((await rowOf(scope))!.pollIntervalMs).toBe(45_000);
    // …and each caller was told what the row held after ITS OWN increment, so the route reports a
    // real value rather than its own guess. Eight distinct values, no duplicates.
    expect(new Set(results.map((r) => r!.pollIntervalMs)).size).toBe(RACERS);
  });

  it("the ceiling holds — a ceremony cannot be slowed past the bound", async () => {
    // A grant lives about fifteen minutes; an unbounded interval would strand one that had been
    // approved. The cap is applied in the same statement as the increment.
    const accountId = await seedAccount();
    const scope = await seedDevice(accountId, { intervalMs: 58_000 });
    await noteDeviceCeremonySlowDown(dbA, { ...scope, stepMs: 5_000, ceilingMs: 60_000 });
    expect((await rowOf(scope))!.pollIntervalMs).toBe(60_000);
    await noteDeviceCeremonySlowDown(dbA, { ...scope, stepMs: 5_000, ceilingMs: 60_000 });
    expect((await rowOf(scope))!.pollIntervalMs).toBe(60_000);
  });

  it("a CLAIMED ceremony can no longer be leased — no poll after a terminal verdict", async () => {
    const accountId = await seedAccount();
    const scope = await seedDevice(accountId);
    await claimDeviceCeremony(dbA, { ...scope, now: NOW });
    expect((await leaseDeviceCeremonyPoll(dbA, { ...scope, now: NOW })).outcome).toBe("denied");
  });
});

describe.skipIf(!PG_UP)("cloud 0027 — the prune, and the redirect arm it must not have weakened", () => {
  it("drops device ceremonies past retention and leaves live ones, consumed or not", async () => {
    const accountId = await seedAccount();
    const stale = await seedDevice(accountId, {
      createdAt: new Date(NOW.getTime() - DEVICE_CEREMONY_RETENTION_MS - 1_000),
    });
    const fresh = await seedDevice(accountId, { createdAt: NOW });

    await pruneDeviceCeremonies(dbA, { now: NOW });

    const left = await dbA.select().from(mailboxOauthDeviceCeremonies)
      .where(eq(mailboxOauthDeviceCeremonies.accountId, accountId));
    expect(left.map((r) => r.state)).toEqual([deviceCeremonyKey(fresh)]);
    expect(left.map((r) => r.state)).not.toContain(deviceCeremonyKey(stale));
    // The pruned row was never consumed — an abandoned ceremony (somebody closed the tab without
    // approving) is exactly half this prune's input, which is why the predicate is the age and not
    // `consumed_at IS NOT NULL`.
  });

  it("the prune does NOT touch the redirect flow's table, and vice versa", async () => {
    // Two tables, two prunes, and the blast radius of each is asserted rather than assumed: a
    // predicate written against the wrong table would delete live consent ceremonies on a server
    // whose operator had simply opened the connect screen.
    const accountId = await seedAccount();
    const redirectState = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    await createOAuthCeremony(dbA, {
      state: redirectState, accountId, provider: "microsoft",
      codeVerifierEnc: "enc:verifier", codeVerifierKeyVersion: 1, returnTo: "/", now: NOW,
    });
    const deviceState = await seedDevice(accountId, {
      createdAt: new Date(NOW.getTime() - DEVICE_CEREMONY_RETENTION_MS - 1_000),
    });

    await pruneDeviceCeremonies(dbA, { now: NOW });

    const [survivor] = await dbA.select().from(mailboxOauthCeremonies)
      .where(eq(mailboxOauthCeremonies.state, redirectState));
    expect(survivor, "the redirect ceremony is another table's business").toBeDefined();
    expect(await rowOf(deviceState)).toBeUndefined();
  });

  it("the REDIRECT flow's consume-once still holds, unchanged, beside the new read", async () => {
    /*
     * THE OTHER DIRECTION, PINNED HERE ON PURPOSE.
     *
     * The risk this slice introduces is not that either discipline is wrong today. It is that one
     * module now holds two of them, and a later reader may make them one — a `readDeviceCeremony`
     * generalised to "read any ceremony", reached from the redirect callback, would silently remove
     * the entire replay defence of the consent flow while every device test stayed green.
     *
     * So the redirect flow's property is asserted in this file too, beside its opposite: eight
     * concurrent consumes, exactly one winner, and the non-consuming read has no equivalent for that
     * table at all — the only reader of `mailbox_oauth_ceremonies` is the consume.
     */
    const accountId = await seedAccount();
    const state = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    await createOAuthCeremony(dbA, {
      state, accountId, provider: "microsoft",
      codeVerifierEnc: "enc:verifier", codeVerifierKeyVersion: 1, returnTo: "/", now: NOW,
    });

    const outcomes = await Promise.all(racers.map((db) => consumeOAuthCeremony(db, { state, now: NOW })));
    expect(outcomes.filter((o) => o.outcome === "ok"), "the redirect arm is still consume-once")
      .toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === "unknown")).toHaveLength(RACERS - 1);
    expect((await dbA.select().from(mailboxOauthCeremonies)
      .where(eq(mailboxOauthCeremonies.state, state)))[0]!.consumedAt?.toISOString())
      .toBe(NOW.toISOString());
  });
});
