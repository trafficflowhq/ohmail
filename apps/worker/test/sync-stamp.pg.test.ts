import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq, sql as dsql } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, mailboxes } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { evaluateAlerts } from "@trafficflow/db/cloud";
import { stampMailboxSync, stampMailboxSyncNow, stampInitialImportComplete } from "../src/mailboxes.js";
import { readSource } from "./_start-function.js";

/**
 * `mailboxes.last_sync_at` HAD THREE READERS AND NO WRITER.
 *
 * Found by connecting a REAL IMAP mailbox to production: the worker synced it, created the
 * `ohmail/*` tree on the real server and the Screener moved a message into
 * `ohmail/Screener` — and `GET /mailboxes` still answered `lastSyncAt: null`, because nothing
 * in the codebase ever wrote the column.
 *
 * The cosmetic half is the (i) panel saying "not synced yet" forever. The half these tests
 * are about is operational: `evaluateAlerts`'s sync-lag rule measures
 * `coalesce(last_sync_at, created_at)` against a 15-minute threshold, so a permanently NULL
 * column means every mailbox is judged by its CREATION time. A perfectly healthy mailbox
 * crosses the threshold a quarter of an hour after it is connected and stays over it for the
 * rest of its life — the alert that exists to notice a dead worker instead fires for
 * everybody, forever, and gets muted. That is strictly worse than having no alert.
 *
 * ── WHY `.pg.test.ts` AND NOT THE UNIT SUITE ────────────────────────────────────────────
 *
 * Because `alerts.pg.test.ts` exists for a reason its own header spells out: the sync-lag
 * predicate compares a raw `coalesce(...)` fragment against a timestamp, PGlite binds a JS
 * `Date` happily, and postgres-js does not — the unit suite was green while every production
 * alert pass died. Any new assertion about this rule has to run through the real driver or
 * it is not evidence.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const AVAILABLE = await realPgAvailable();
const NOW = new Date("2026-08-01T12:00:00.000Z");
const MIN = 60_000;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

describe.skipIf(!AVAILABLE)("stampMailboxSync — the writer last_sync_at never had", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);

  /**
   * READ THE LAG RULE OVER THIS CASE'S OWN ACCOUNT, THROUGH THE RULE'S OWN SEAM.
   *
   * `evaluateAlerts` counts every lagging mailbox in the DEPLOYMENT, so a co-tenant seeding one
   * between this case's two reads moves the count and the delta below fails with nothing wrong —
   * green alone, red in company (the 0.19.1 freeze, this case by name). `parkedAccounts` is the
   * host's reader of "accounts this deployment is not syncing" and is handed the LAGGING ids, so
   * parking everything but ours narrows the population while the predicate, the driver and the
   * raw `coalesce` fragment stay production's — the only reason this file is a pg twin.
   */
  const lagOf = async (accountId: string) => {
    const alerts = await evaluateAlerts(db, {
      now: NOW,
      parkedAccounts: async (ids) => new Set(ids.filter((id) => id !== accountId)),
    });
    return alerts.find((a) => a.kind === "sync_lag");
  };

  const seedMailbox = async (createdAgoMs: number) => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `stamp-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `stamp-${accountId.slice(0, 8)}@example.test`,
      status: "connected", createdAt: ago(createdAgoMs),
    }).returning();
    return { accountId, id: mb!.id };
  };

  it("THE REGRESSION: a mailbox that just synced is no longer reported as lagging", async () => {
    // Created an hour ago and never stamped — which before the writer existed described EVERY
    // mailbox in production, including ones actively syncing.
    const mb = await seedMailbox(60 * MIN);

    const lagBefore = await lagOf(mb.accountId);
    // The control. If an unstamped mailbox did not look lagging, the assertion after the
    // stamp would pass for the wrong reason and prove nothing.
    expect(lagBefore, "an unstamped mailbox must look lagging, or this test is vacuous").toBeDefined();
    // This account holds exactly the one mailbox, so the count is the reading rather than a
    // delta over whatever else the deployment happens to hold while the case runs.
    expect(lagBefore!.count, "the scoped read must see this case's one mailbox and nothing else").toBe(1);

    await stampMailboxSync(db, [mb.id], NOW);

    const lagAfter = await lagOf(mb.accountId);
    expect((lagAfter?.count ?? 0), "the stamped mailbox must drop out of the lag set").toBe(0);
  });

  it("a mailbox that has genuinely stopped syncing STILL alerts", async () => {
    // The other direction. Stamping must not have turned the rule off — a stamp older than
    // the threshold is still a lag, which is the only reason the alert is worth keeping.
    const mb = await seedMailbox(5 * MIN);
    await stampMailboxSync(db, [mb.id], ago(45 * MIN));

    // Scoped for the same reason, and it buys a sharper assertion: unscoped, `oldestSeconds` is
    // the worst lag in the deployment, so a co-tenant's older row satisfies the bound while this
    // mailbox is not in the set at all — the reading would be somebody else's.
    const lag = await lagOf(mb.accountId);
    expect(lag).toBeDefined();
    expect(lag!.count, "this account's one stale mailbox is the whole of the scoped set").toBe(1);
    expect(lag!.oldestSeconds!).toBe(45 * 60);
  });

  it("stamps the whole rotation in one statement, and only those ids", async () => {
    const a = await seedMailbox(MIN);
    const b = await seedMailbox(MIN);
    const c = await seedMailbox(MIN);

    await stampMailboxSync(db, [a.id, b.id], NOW);

    const [ra] = await db.select().from(mailboxes).where(eq(mailboxes.id, a.id));
    const [rb] = await db.select().from(mailboxes).where(eq(mailboxes.id, b.id));
    const [rc] = await db.select().from(mailboxes).where(eq(mailboxes.id, c.id));
    expect(ra!.lastSyncAt).not.toBeNull();
    expect(rb!.lastSyncAt).not.toBeNull();
    // The WHERE is real: a mailbox that did NOT sync must not be credited with one.
    expect(rc!.lastSyncAt, "a mailbox absent from the rotation must not be stamped").toBeNull();
  });

  it("stampMailboxSyncNow is monotone at the DATABASE's clock — raises, never regresses, never immortalizes the future", async () => {
    // Three properties of the DB-clock writer, each load-bearing for the pull affordance's
    // honest settle (2026-08-26 review, rounds 3 and 4):
    //  · a BACKDATED write (the pass-end batch, backdated to the pass's start) must not
    //    overwrite a NEWER stamp (a woken visit's eager write) — GREATEST;
    //  · a FUTURE stamp planted by a host-clock writer (an older deployment, the Date form)
    //    must DECAY to the database's own now() on the next honest write, not be preserved
    //    until the wall clock catches up — the LEAST(existing, now()) clamp inside it. A
    //    preserved future value settles pulls with no scan behind them and suppresses the lag
    //    alert for the whole skew.
    //  · a NULL column still takes its first stamp (GREATEST ignores NULL).
    const mb = await seedMailbox(MIN);

    // First stamp lands on a NULL column.
    await stampMailboxSyncNow(db, [mb.id]);
    const [first] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb.id));
    expect(first!.lastSyncAt).not.toBeNull();

    // A backdated write must not regress the fresher value.
    await stampMailboxSyncNow(db, [mb.id], 60_000);
    const [afterBackdate] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb.id));
    expect(afterBackdate!.lastSyncAt!.getTime()).toBeGreaterThanOrEqual(first!.lastSyncAt!.getTime());

    // A planted FUTURE stamp is REPLACED BY THE WRITE'S OWN CANDIDATE — never preserved, and
    // never merely clamped to now(): a backdated write claims its scan's START, and handing a
    // corrupted row `now()` instead would claim a completion that can post-date a pull baseline
    // this scan never covered (review round 5). Seeded in SQL off the database's own clock, so
    // no host clock shapes the fixture.
    await db.update(mailboxes)
      // `dsql`, because this file's `sql` is the postgres-js CLIENT — the bare tag would
      // EXECUTE a query and hand its pending promise to the column mapper.
      .set({ lastSyncAt: dsql`now() + interval '10 minutes'` })
      .where(eq(mailboxes.id, mb.id));
    await stampMailboxSyncNow(db, [mb.id], 60_000);
    const [decayed] = await db.select({
      inFuture: dsql<boolean>`${mailboxes.lastSyncAt} > now() + interval '1 second'`,
      // The sharp half: the surviving value is the BACKDATED candidate (~now()-60s), not now().
      atScanStart: dsql<boolean>`${mailboxes.lastSyncAt} < now() - interval '59 seconds'`,
      at: mailboxes.lastSyncAt,
    }).from(mailboxes).where(eq(mailboxes.id, mb.id));
    // Mutation evidence, both watched red on 2026-08-26: a bare `greatest(last_sync_at, …)`
    // preserves the +10min value (`inFuture` fails); round 4's `greatest(least(existing, now()),
    // …)` decays it to now() instead of the scan start (`atScanStart` fails).
    expect(decayed!.inFuture, "a future stamp survived an honest write").toBe(false);
    expect(decayed!.atScanStart,
      "a corrupted future stamp decayed to now() — a completion claim this backdated scan never made",
    ).toBe(true);
    expect(decayed!.at).not.toBeNull();
  });

  it("an empty rotation touches nothing", async () => {
    // `WHERE id IN ()` is a full-table UPDATE on some dialects. On THIS table that would
    // silence the lag alert for every account at once, which is the exact failure the alert
    // exists to catch — so the guard is asserted rather than assumed.
    const mb = await seedMailbox(MIN);
    await stampMailboxSync(db, [], NOW);
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb.id));
    expect(row!.lastSyncAt).toBeNull();
  });

  // ── the first-import-complete floor's WRITER ──────────────────────────────────────────────
  //
  // `initial_import_completed_at` is what stops a partial mailbox reading as complete. Two
  // properties are load-bearing and neither is visible without a real row: it is stamped ONCE (the
  // `IS NULL` guard, so "when the first import finished" is never rewritten to a later cycle) and it
  // is per-mailbox (never a blanket update).

  it("stampInitialImportComplete stamps a drained import ONCE and never overwrites it", async () => {
    const mb = await seedMailbox(60 * MIN);
    const [before] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb.id));
    expect(before!.initialImportCompletedAt, "a fresh mailbox has not finished its first import").toBeNull();

    await stampInitialImportComplete(db, mb.id, ago(30 * MIN));
    const [after] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb.id));
    expect(after!.initialImportCompletedAt, "the first no-backlog cycle did not stamp the marker").not.toBeNull();
    const stampedAt = after!.initialImportCompletedAt!.getTime();

    // A LATER no-backlog cycle must NOT move the stamp. The `IS NULL` guard is the whole of
    // "stamped once": without it, every subsequent drained cycle would rewrite the moment the
    // import "finished" to now, and the floor would flap true→false→true forever after a
    // clear-to-re-run. A blanket `UPDATE … SET initial_import_completed_at = now()` passes the
    // assertion above and fails this one.
    await stampInitialImportComplete(db, mb.id, NOW);
    const [again] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb.id));
    expect(again!.initialImportCompletedAt!.getTime(), "a later cycle overwrote the once-only stamp")
      .toBe(stampedAt);
  });

  it("stampInitialImportComplete stamps only the mailbox that drained, not the whole table", async () => {
    const a = await seedMailbox(MIN);
    const b = await seedMailbox(MIN);
    await stampInitialImportComplete(db, a.id, NOW);
    const [ra] = await db.select().from(mailboxes).where(eq(mailboxes.id, a.id));
    const [rb] = await db.select().from(mailboxes).where(eq(mailboxes.id, b.id));
    expect(ra!.initialImportCompletedAt).not.toBeNull();
    expect(rb!.initialImportCompletedAt, "a mailbox that did not drain must not be marked complete")
      .toBeNull();
  });
});

describe("the worker actually calls it", () => {
  const src = readSource(`${HERE}../src/index.ts`);

  /**
   * ── THE ANCHORS ARE THE CALLS, NOT THE LINES THEY SIT ON ────────────────────────
   *
   * These scans used to match the whole statement — `await stampMailboxSync(db, synced, new
   * Date());` — and that made them a guard on the CALL and, accidentally, on everything wrapped
   * around it. The lanes change wrapped both stamps in `asDatabaseFault(…)` so that a shared database
   * fault swallowed by their best-effort catches is still ANNOUNCED (see
   * `index.ts#noteIfSharedDatabaseFault`), and all three claims turned red without a word about
   * the property any of them exists to protect.
   *
   * So the anchor is now the call and its arguments, which is what each claim is actually about;
   * the surrounding expression is free to change. Nothing is weakened — the arguments are still
   * pinned exactly, and `synced` in the batched one is the whole point of that claim.
   */
  // `stampMailboxSyncNow`, with NO Date argument — the absence is part of the claim since the
  // pull affordance landed: `last_sync_at` is compared against `sync_requested_at`, which the
  // API stamps with SQL `now()`, so the cycle's stamps must come off the DATABASE's clock. A
  // mutation that reintroduces `new Date()` here re-inserts the worker host's wall clock into
  // that comparison and turns this anchor red.
  const BATCHED = "stampMailboxSyncNow(roster, synced, Date.now() - passStartedMs)";
  const IMPORT_DONE = "stampInitialImportComplete(forAccount(rt.accountId).db, rt.mailboxId, new Date())";

  it("every mailbox that completed a cycle is collected and stamped", () => {
    // A writer nobody calls leaves the column exactly as broken as it was. The collection
    // point is the SUCCESS branch of the rotation loop, beside the in-memory `lastSuccessAt`
    // the worker already maintained and never persisted.
    expect(src).toMatch(/rt\.lastSuccessAt = new Date\(\);\s*\n\s*synced\.push\(rt\.mailboxId\);/);
    expect(src).toContain(BATCHED);
  });

  it("the stamp is best-effort — a failed bookkeeping write must not kill a serving mailbox", () => {
    const at = src.indexOf(BATCHED);
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at - 200, at)).toMatch(/try \{/);
    expect(src.slice(at, at + 500)).toMatch(/catch \(err\)[\s\S]*mailbox_sync_stamp_failed/);
  });

  it("it runs BEFORE the quarantine pass, so one bad mailbox cannot cost a good one its stamp", () => {
    expect(src.indexOf(BATCHED)).toBeLessThan(src.indexOf("for (const { rt, err } of toQuarantine)"));
  });

  it("stamps initial-import-complete only on a NO-BACKLOG cycle, and best-effort", () => {
    // The floor the client reads is written here and only here. It must fire on the cycle that
    // DRAINS the backlog (`!hasBacklog`), never on every successful cycle, or a mailbox 40 messages
    // into a longer import would stamp itself complete. And it must be best-effort, because an
    // uncaught freshness write would fall into the rotation's `catch` and walk a serving mailbox
    // toward `status='error'`.
    const at = src.indexOf(IMPORT_DONE);
    expect(at, "the worker never calls stampInitialImportComplete").toBeGreaterThan(0);
    expect(src.slice(at - 300, at), "the stamp is not gated on a drained (`!hasBacklog`) cycle")
      .toMatch(/if \(!hasBacklog\) \{\s*\n\s*try \{/);
    expect(src.slice(at, at + 600), "the stamp is not best-effort")
      .toMatch(/catch \(err\)[\s\S]*mailbox_import_complete_stamp_failed/);
  });

  it("a swallowed SHARED database fault is still announced", () => {
    // The half the best-effort catches were silently missing. Both stamps are pure-database
    // calls, so a throw from either IS our database — `asDatabaseFault` is what makes that
    // answerable, and the catch then announces the shard-wide condition without counting
    // anything against the mailbox. Measured: without this a database outage landing while every
    // lane was past `runSyncCycle` left `/health` reporting `degraded: false` throughout.
    for (const call of [BATCHED, IMPORT_DONE]) {
      const at = src.indexOf(call);
      expect(src.slice(at - 300, at), `${call} does not name the database as its origin`)
        .toContain("asDatabaseFault(");
      expect(src.slice(at, at + 600), `${call}'s catch swallows a shared database fault silently`)
        .toContain("noteIfSharedDatabaseFault(");
    }
  });
});
