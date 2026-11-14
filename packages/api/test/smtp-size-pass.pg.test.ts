import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, lte, sql } from "drizzle-orm";
import { accounts, mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { StaticKeyProvider } from "@trafficflow/core";
import {
  learnMissingSmtpSizes, stampProbe, SMTP_SIZE_BATCH, SMTP_SIZE_RETRY_SILENT_MS,
  type ProbeTarget,
} from "../src/smtp-size.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * ══ THE `SIZE` BACK-FILL PASS, ON REAL POSTGRES ═══════════════════════════════════════════════
 *
 * The behaviour of this pass is pinned in `smtp-size-pass.test.ts`, which runs on PGlite. This file
 * exists because that was not enough, and the way it was not enough is worth writing down exactly:
 *
 * THE FIRST PRODUCTION RUN OF THE PASS ANSWERED `503 smtp_size_pass_failed`, with
 * `errorClass: "TypeError"` and `errorCode: "ERR_INVALID_ARG_TYPE"`, while every in-process test
 * was green. The cause is a driver boundary, not logic: a value interpolated into a raw `sql`
 * fragment has no COLUMN to be mapped by, so drizzle passes the JS object to the driver as-is, and
 * postgres-js's bind path calls `Buffer.byteLength` on it — which throws for a `Date`
 * (*"The \"string\" argument must be of type string or an instance of Buffer or ArrayBuffer.
 * Received an instance of Date"*). **PGlite accepts the same Date silently**, which is why 25 green
 * cases said nothing about it, and why the selection's backoff comparison and the write's
 * credential predicate both go through typed `lte`/`eq` now.
 *
 * So the question this file asks is narrower than the other file's and cannot be asked there: DOES
 * EVERY STATEMENT THIS PASS ISSUES SURVIVE THE REAL DRIVER? The dial is still injected — nothing
 * here opens a socket to anybody's submission server — because the driver is the subject, not SMTP.
 *
 * Mutation that proves it bites: put either timestamp back inside a `sql` template
 * (`sql`${mailboxes.smtpSizeProbedAt} <= ${silentCutoff}``) and every case here fails with that
 * TypeError while the PGlite file stays entirely green.
 */
const AVAILABLE = await realPgAvailable();
const FIXED_NOW = new Date("2026-08-22T12:00:00.000Z");

/** Only what the pass reads. It touches `db`, `keyProvider`, `oauth` and `logger` and nothing else. */
function depsOn(db: OwnedDb["db"], oauth?: ApiDeps["oauth"]): ApiDeps {
  return {
    db,
    keyProvider: StaticKeyProvider.fromSecret(Buffer.alloc(32, 7)),
    now: () => FIXED_NOW,
    ...(oauth ? { oauth } : {}),
  } as unknown as ApiDeps;
}

describe.skipIf(!AVAILABLE)("the SIZE back-fill's statements against real Postgres", () => {
  let owned: OwnedDb;
  let db: OwnedDb["db"];

  /**
   * THE SECOND CONNECTION — the concurrent writer, and it has to be a second CONNECTION rather than
   * a second statement: a write issued on `db` would be in the same session, so its effect would be
   * visible to the guarded update by construction and the case would prove nothing about
   * concurrency. Each statement here is its own transaction on its own pool, so by the time
   * `stampProbe` runs the other writer has genuinely committed and is visible only through MVCC.
   */
  let otherConn: OwnedDb;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
    db = owned.db;
    otherConn = makeOwnedDb(PG_TEST_URL);
  }, 180_000);

  afterAll(async () => {
    await owned?.close().catch(() => { /* already down */ });
    await otherConn?.close().catch(() => { /* already down */ });
  });

  /** The guard the pass captures BEFORE its dial, read from the row the same way it reads it. */
  async function guardFor(mailboxId: string): Promise<ProbeTarget> {
    const [row] = await db.select().from(mailboxCredentials)
      .where(and(eq(mailboxCredentials.mailboxId, mailboxId), eq(mailboxCredentials.transport, "imap")))
      .limit(1);
    return {
      creds: { host: "smtp.office365.com", port: 587, secure: false, auth: {} },
      credentialsTransport: "imap",
      credentialsGuard: { kind: "meta", meta: row!.meta, updatedAt: row!.updatedAt },
    };
  }

  /**
   * One mailbox with an imap + smtp credential row, so the fleet-wide selection has at least one row
   * this file put there. The address ends in `.test` (RFC 2606 §2), which is what keeps
   * `mailbox-smtp-max-size.pg.test.ts`'s database-global "no production-shaped row carries a
   * backfilled value" assertion true while the pass writes real announcements here.
   */
  async function seed(opts: {
    announced?: number | null;
    probedAt?: Date;
    probeCode?: string;
    oauth?: boolean;
  } = {}): Promise<string> {
    const [acct] = await db.insert(accounts).values({ name: `size-pass-${randomUUID().slice(0, 8)}` }).returning();
    const kp = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
    const [mb] = await db.insert(mailboxes).values({
      accountId: acct!.id,
      provider: opts.oauth ? "microsoft" : "imap",
      address: `size-pass-${randomUUID()}@x.test`,
      status: "connected",
      smtpMaxSizeBytes: opts.announced ?? null,
      ...(opts.probedAt ? { smtpSizeProbedAt: opts.probedAt } : {}),
      ...(opts.probeCode ? { smtpSizeProbeCode: opts.probeCode } : {}),
    }).returning();
    const imap = await kp.encrypt(opts.oauth ? "a-refresh-token" : "imap-pass");
    await db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap",
      secretEnc: imap.ciphertext, keyVersion: imap.keyVersion,
      meta: opts.oauth
        ? {
            host: "outlook.office365.com", port: 993, secure: true, user: "o@x.test",
            authType: "oauth2", provider: "microsoft", tenant: "common",
          }
        : { host: "imap.x.test", port: 993, secure: true, user: "u@x.test" },
      updatedAt: FIXED_NOW,
    });
    if (!opts.oauth) {
      const smtp = await kp.encrypt("smtp-pass");
      await db.insert(mailboxCredentials).values({
        mailboxId: mb!.id, accountId: mb!.accountId, transport: "smtp",
        secretEnc: smtp.ciphertext, keyVersion: smtp.keyVersion,
        meta: { host: "smtp.x.test", port: 587, secure: false, user: "u@x.test" },
        updatedAt: new Date(FIXED_NOW.getTime() + 1000),
      });
    }
    return mb!.id;
  }

  /**
   * THE SELECTION AND THE WRITE, RUN FOR REAL — and asserted WITHOUT depending on which rows the
   * batch happened to draw.
   *
   * This database is shared with every other `*.pg.test.ts`, so the fleet-wide selection sees a great many
   * due fixture rows, and a specific seeded mailbox is not reachable in one bounded batch.
   * That is why the cases below assert on the PASS rather than on one row: the question is whether
   * the statements survive the driver, and every one of them is issued on every run.
   */
  it("RETURNS instead of throwing, and the batch's UPDATEs land — the regression, as an outcome", async () => {
    // Seeded rather than assumed: on a FOCUSED run against a fresh database there is nothing due
    // otherwise, and `considered: 0` would make every assertion below vacuous.
    await seed();
    const res = await learnMissingSmtpSizes(depsOn(db), {
      dial: async () => ({ maxMessageBytes: null }),
      now: () => FIXED_NOW,
    });

    // Before the fix this threw `TypeError [ERR_INVALID_ARG_TYPE]` out of postgres-js's bind path,
    // so "it returned at all" IS the assertion. The counts then prove both statements executed: the
    // SELECT reached rows, and each of them was stamped by an UPDATE carrying the credential guard.
    expect(res.considered).toBeGreaterThan(0);
    // `stamped`, not `silent`: which OUTCOME the batch's rows produce depends on which fixtures the
    // shared database happens to hold (many carry no credential row at all, which is a `skipped` and
    // a `no_credentials` stamp). What every outcome shares is that the row is remembered, so this is
    // the counter that proves the UPDATE statement — the one carrying the credential guard — ran.
    expect(res.stamped).toBeGreaterThan(0);
  }, 120_000);

  it("the backoff comparison runs on a STAMPED row — the second pass reads what the first wrote", async () => {
    // The first pass leaves stamps behind, so the second one evaluates
    // `smtp_size_probed_at <= $cutoff` against real rows rather than only the `IS NULL` arm. Both
    // passes returning is the whole claim; a raw-`sql` Date fails the first and the second alike.
    //
    // ONE MORE ROW THAN A BATCH IS SEEDED HERE, and that is what makes the case independent of what
    // else is in the database. A shared instance has thousands of due fixtures and a FOCUSED run
    // against a fresh one has none, so asserting "the second pass still found work" is only
    // decidable if this file put more work there than one batch can take.
    for (let i = 0; i < SMTP_SIZE_BATCH + 1; i += 1) await seed();

    const first = await learnMissingSmtpSizes(depsOn(db), {
      dial: async () => ({ maxMessageBytes: null }), now: () => FIXED_NOW,
    });
    const second = await learnMissingSmtpSizes(depsOn(db), {
      dial: async () => ({ maxMessageBytes: null }), now: () => FIXED_NOW,
    });
    expect(first.considered).toBe(SMTP_SIZE_BATCH);
    expect(first.stamped).toBeGreaterThan(0);
    expect(second.considered).toBeGreaterThan(0);
    // And no row is drawn twice inside one pass, so a second pass can only reach OTHER rows: the
    // stamped set grows rather than being rewritten.
    const stamped = await db.execute(sql`
      select count(*)::int as n from mailboxes where smtp_size_probed_at is not null`);
    expect((stamped as unknown as Array<{ n: number }>)[0]!.n)
      .toBeGreaterThanOrEqual(first.stamped + second.stamped);
  }, 120_000);

  it("a `timestamptz <= $1` comparison built with `lte` binds a Date the driver accepts", async () => {
    // The selection's own predicate, isolated. `lte` on a typed column maps the value through that
    // column's `mapToDriverValue`; the same Date inside a `sql` template reaches postgres-js
    // unmapped and throws. This is the statement shape, asserted without the pass around it.
    const cutoff = new Date(FIXED_NOW.getTime() - SMTP_SIZE_RETRY_SILENT_MS);
    const rows = await db.select({ id: mailboxes.id }).from(mailboxes)
      .where(lte(mailboxes.smtpSizeProbedAt, cutoff)).limit(1);
    expect(Array.isArray(rows)).toBe(true);
  }, 60_000);

  it("a `jsonb = $1` predicate built with `eq` binds a META OBJECT the driver accepts", async () => {
    // The SHAPE the oauth branch's guard uses, isolated for the same reason, and the newer risk of
    // the two: a whole jsonb object as a bound parameter. Compared against the value read back out
    // of the column, so this pins the round trip too — `jsonb = jsonb` is key-order-insensitive,
    // which is what makes the comparison meaningful rather than textual.
    //
    // It is a claim about the PREDICATE, not about the pass's wiring, and the distinction is worth
    // stating because a mutation inside the pass's oauth branch does NOT turn this red: the
    // fleet-wide batch draws from a great many fixture rows and will not reach a seeded oauth mailbox.
    // The wiring is pinned in the PGlite file (the rotation pair); what cannot be asked there is
    // whether the driver accepts the parameter at all, which is this case.
    const id = await seed({ oauth: true });
    const [cred] = await db.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, id)).limit(1);
    const again = await db.select({ id: mailboxCredentials.mailboxId }).from(mailboxCredentials)
      .where(and(
        eq(mailboxCredentials.mailboxId, id),
        eq(mailboxCredentials.meta, cred!.meta),
      ));
    expect(again).toHaveLength(1);

    // …and a DIFFERENT meta must not match, or the guard would be satisfied by any row.
    const other = await db.select({ id: mailboxCredentials.mailboxId }).from(mailboxCredentials)
      .where(and(
        eq(mailboxCredentials.mailboxId, id),
        eq(mailboxCredentials.meta, { host: "elsewhere.x.test" }),
      ));
    expect(other).toHaveLength(0);
  }, 60_000);

  /**
   * ══ THE CREDENTIAL GUARD, AGAINST A GENUINELY CONCURRENT COMMIT ═══════════════════════════
   *
   * The PGlite file pins the WIRING of this guard — which outcome stamps and which does not — by
   * awaiting a credential write inside the injected dial. That is a serialized simulation on an
   * in-process driver, and the property that actually decides the production behaviour is not
   * serialized: a real writer commits on ANOTHER CONNECTION, and what this statement matches
   * depends on the snapshot it takes when it runs.
   *
   * So this drives the production write itself — `stampProbe`, exported for exactly this — with a
   * SECOND CONNECTION POOL playing the concurrent writer and a real commit between the capture and
   * the update. The two cases are the two writers that touch a credential row without
   * changing what the mailbox sends through:
   *
   *  · a KEK REWRAP re-encrypts the same refresh token: `secret_enc` + `key_version` move,
   *    `updated_at` does not — the stamp MUST still land, or a key rotation costs every oauth
   *    mailbox a probe slot;
   *  · a TOKEN ROTATION moves `updated_at` — the `token_unavailable` stamp must NOT land, or a
   *    replacement token waits out a week over a failure that was about the token it replaced.
   *
   * Mutation: key the conjunct back on `secret_enc` and the rewrap case goes red here, on real
   * Postgres, with the row unstamped.
   */
  it("a concurrently COMMITTED KEK rewrap does not stop the token-failure stamp", async () => {
    const id = await seed({ oauth: true });
    const target = await guardFor(id);

    // Another connection, another transaction, committed before the guarded write runs.
    await otherConn.db.update(mailboxCredentials)
      .set({ secretEnc: "rewrapped-envelope", keyVersion: 2 })
      .where(and(eq(mailboxCredentials.mailboxId, id), eq(mailboxCredentials.transport, "imap")));

    const wrote = await stampProbe(depsOn(db), id, "token_unavailable", target, FIXED_NOW);
    expect(wrote, "a pure re-encryption blocked the stamp").toBe(true);
    const [after] = await db.select({ code: mailboxes.smtpSizeProbeCode })
      .from(mailboxes).where(eq(mailboxes.id, id)).limit(1);
    expect(after?.code).toBe("token_unavailable");
  }, 60_000);

  it("a concurrently COMMITTED token rotation DOES stop it", async () => {
    const id = await seed({ oauth: true });
    const target = await guardFor(id);

    // `rotateMailboxOAuthSecret`'s shape, from the other connection: the secret AND the stamp.
    await otherConn.db.update(mailboxCredentials)
      .set({ secretEnc: "rotated-envelope", keyVersion: 2, updatedAt: new Date() })
      .where(and(eq(mailboxCredentials.mailboxId, id), eq(mailboxCredentials.transport, "imap")));

    const wrote = await stampProbe(depsOn(db), id, "token_unavailable", target, FIXED_NOW);
    expect(wrote, "a stamp landed against a credential the pass never tried").toBe(false);
    const [after] = await db.select({
      at: mailboxes.smtpSizeProbedAt, code: mailboxes.smtpSizeProbeCode,
    }).from(mailboxes).where(eq(mailboxes.id, id)).limit(1);
    expect(after).toMatchObject({ at: null, code: null });
  }, 60_000);

  it("…and the SAME rotation does not stop a LEARNED write — the asymmetry, on real Postgres", async () => {
    // The other half of the rule, so the pair above cannot be read as "any credential write blocks
    // the row". A learned ceiling is a fact about the SERVER, and the probe's own refresh moves the
    // same timestamp, so `learned` is guarded on `meta` alone and must survive this.
    const id = await seed({ oauth: true });
    const target = await guardFor(id);

    await otherConn.db.update(mailboxCredentials)
      .set({ secretEnc: "rotated-envelope", keyVersion: 2, updatedAt: new Date() })
      .where(and(eq(mailboxCredentials.mailboxId, id), eq(mailboxCredentials.transport, "imap")));

    const wrote = await stampProbe(depsOn(db), id, "learned", target, FIXED_NOW, 157_286_400);
    expect(wrote, "the probe's own rotation discarded a learned ceiling").toBe(true);
    const [after] = await db.select({
      size: mailboxes.smtpMaxSizeBytes, code: mailboxes.smtpSizeProbeCode,
    }).from(mailboxes).where(eq(mailboxes.id, id)).limit(1);
    expect(after).toMatchObject({ size: 157_286_400, code: "learned" });
  }, 60_000);

  it("NEVER THROWS — the pass returns counts even when every dial fails", async () => {
    // The regression as an outcome. The production failure was not a wrong number, it was a
    // TypeError out of the driver before anything was dialled, so the assertion that catches it is
    // simply that the pass RETURNS.
    await seed();
    const res = await learnMissingSmtpSizes(depsOn(db), {
      dial: async () => { throw Object.assign(new Error("refused"), { code: "ECONNECTION" }); },
      now: () => FIXED_NOW,
    });
    expect(res).toMatchObject({ considered: expect.any(Number), stamped: expect.any(Number) });
    expect(res.considered).toBeGreaterThan(0);
  }, 120_000);
});
