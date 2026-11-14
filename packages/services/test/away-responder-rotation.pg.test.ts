import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq, inArray } from "drizzle-orm";
import {
  accounts, awayReplies, awayResponders, awaySenderState, folderState,
  mailboxes, messageBodies, messages,
} from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { OutboundMessage, SendAdapter } from "@trafficflow/core";
import { AWAY_ACCOUNTS_PER_RUN, runAwayResponderPass } from "../src/away-responder-pass.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE AWAY PASS'S PER-RUN BOUND DECIDES HOW MUCH WORK HAPPENS, NEVER WHOSE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The probe draws at most `AWAY_ACCOUNTS_PER_RUN` responders per tick. Ordered by `enabled_at`
 * alone that page was DETERMINISTIC, so every tick drew the same fifty: a fifty-first person
 * enables their responder, is shown "On", and answers nobody for as long as the fifty ahead of
 * them stay on. The fix is a durable rotation stamp — `away_responders.last_considered_at`,
 * written on the accounts a run actually WALKED and read first by the probe's ORDER BY.
 *
 * WHY THIS FILE IS `.pg.test.ts` AND NOT A PGlite ONE. The whole claim is that the rotation
 * SURVIVES the invocation: a cursor held in a module variable passes any single-process suite and
 * starves the fifty-first person in production, where each tick is a new serverless invocation
 * against a database that has forgotten everything else. So the ticks here run against real
 * Postgres and the durability case opens a SECOND CLIENT for its second tick — no shared handle,
 * no shared module state, the only thing carried between them is the row.
 *
 * SCOPED, as every pg file here is: fifty-one accounts of this run's own, every invocation
 * narrowed to their mailboxes (`mailboxIds`, the sidecar's real shape), every read keyed on those
 * ids, and `afterEach` takes the rows back out.
 *
 * MUTATIONS WATCHED RED, THEN RESTORED FROM A PRISTINE COPY AND PROVED BY `cmp`:
 *  · `asc(awayResponders.lastConsideredAt)` removed from the probe's ORDER BY (the pass exactly as
 *    it was) → "every enabled responder is reached" red on the fifty-first, tick after tick;
 *  · `.limit(AWAY_ACCOUNTS_PER_RUN)` → `.limit(AWAY_ACCOUNTS_PER_RUN + 1)` → "the per-run bound
 *    still holds" red at fifty-one walked in one tick;
 *  · `eq(awayResponders.enabled, true)` removed from the probe's WHERE → "refuses a row whose
 *    switch is off even where the enablement instant still stands" red. It leaves the case above
 *    it GREEN, measured: three mechanisms refuse the product's own off row, and one deleted is a
 *    no-op — which is why that case's twin exists and says so;
 *  · the `markConsidered(db, walked, now())` call removed → "the rotation survives the process"
 *    red, nothing stamped and the second client redraws the first page.
 */
const PG_UP = await realPgAvailable();

const NOW = new Date("2026-09-02T12:00:00.000Z");
/** One more than the page, which is the whole subject. */
const N = AWAY_ACCOUNTS_PER_RUN + 1;

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  if (!PG_UP) return;
  await runMigrations(PG_TEST_URL);
  client = postgres(PG_TEST_URL, { max: 4 });
  db = brandDialect(drizzle(client), "pg");
});

afterAll(async () => {
  await client?.end({ timeout: 5 });
});

/**
 * A silent log that keeps what it refused. Silent because an `away_reply_sent` line per reply per
 * tick buries the run; kept because `runAwayResponderPass` CONTAINS a per-account fault and
 * returns normally, so a rotation that reached an account and threw there would otherwise read
 * exactly like one that reached it and answered.
 */
function logSpy() {
  const errors: string[] = [];
  const log = {
    info: () => {},
    warn: () => {},
    error: (event: string) => { errors.push(event); },
    child: () => log,
  } as unknown as Parameters<typeof runAwayResponderPass>[1]["log"];
  return { log, errors };
}

/** Counts what a run handed to a transport; the reply itself is not this file's subject. */
function recorder() {
  const delivered: OutboundMessage[] = [];
  const factory = async (): Promise<SendAdapter> => ({
    send: async (m: OutboundMessage) => {
      delivered.push(m);
      return { providerMessageId: `<p-${delivered.length}>` };
    },
    messageInSent: async () => false,
    close: async () => {},
  }) as unknown as SendAdapter;
  return { factory, delivered };
}

interface Fleet {
  /** In the order the pass's tie-break (`enabled_at`, then `account_id`) puts them. */
  accountIds: string[];
  mailboxIds: string[];
  messageIds: string[];
}

let fleet: Fleet | null = null;

/**
 * `n` accounts, each with one live responder and one message waiting.
 *
 * `enabled_at` is a second apart and increasing, so the tie-break order is the seeded order and
 * "the last one" is a NAME, not a guess: at HEAD's ordering the last seeded account is exactly the
 * one the page cannot reach.
 */
async function seedFleet(n: number): Promise<Fleet> {
  const accountIds: string[] = [];
  const mailboxIds: string[] = [];
  const messageIds: string[] = [];
  const arrivedAt = new Date(NOW.getTime() - 60_000);

  const accRows = Array.from({ length: n }, () => ({ id: randomUUID(), name: "away rotation" }));
  await db.insert(accounts).values(accRows);
  const mbRows = accRows.map((a) => ({
    id: randomUUID(), accountId: a.id, provider: "imap" as const,
    address: `me-${a.id}@rotation.test`, organizerRole: "organizer" as const,
    status: "connected" as const,
  }));
  await db.insert(mailboxes).values(mbRows);
  await db.insert(awayResponders).values(accRows.map((a, i) => ({
    accountId: a.id, enabled: true, body: "Back Monday.", audience: "screened_in",
    throttle: "always",
    enabledAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000 + i * 1000),
    updatedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000 + i * 1000),
  })));
  const msgRows = accRows.map((a, i) => ({
    id: randomUUID(), accountId: a.id, mailboxId: mbRows[i]!.id,
    messageIdHeader: `<${randomUUID()}@them.test>`,
    bodyHash: randomUUID(), dedupKey: randomUUID(),
    subject: "the roof", fromAddress: "colleague@them.test",
    date: arrivedAt, createdAt: arrivedAt,
  }));
  await db.insert(messages).values(msgRows);
  await db.insert(messageBodies).values(msgRows.map((m) => ({
    messageId: m.id, accountId: m.accountId, text: "hello", headers: {},
  })));
  await db.insert(folderState).values(msgRows.map((m) => ({
    messageId: m.id, accountId: m.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" as const,
  })));

  for (let i = 0; i < n; i++) {
    accountIds.push(accRows[i]!.id);
    mailboxIds.push(mbRows[i]!.id);
    messageIds.push(msgRows[i]!.id);
  }
  fleet = { accountIds, mailboxIds, messageIds };
  return fleet;
}

afterEach(async () => {
  if (!PG_UP || fleet === null) return;
  const { accountIds, messageIds } = fleet;
  fleet = null;
  await db.delete(folderState).where(inArray(folderState.messageId, messageIds));
  await db.delete(messageBodies).where(inArray(messageBodies.messageId, messageIds));
  await db.delete(awayReplies).where(inArray(awayReplies.accountId, accountIds));
  await db.delete(awaySenderState).where(inArray(awaySenderState.accountId, accountIds));
  await db.delete(messages).where(inArray(messages.accountId, accountIds));
  await db.delete(awayResponders).where(inArray(awayResponders.accountId, accountIds));
  await db.delete(mailboxes).where(inArray(mailboxes.accountId, accountIds));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

/** Which of this run's accounts have been answered — the ledger is the person's own evidence. */
async function answered(f: Fleet): Promise<Set<string>> {
  const rows = await db.select({ accountId: awayReplies.accountId }).from(awayReplies)
    .where(inArray(awayReplies.accountId, f.accountIds));
  return new Set(rows.map((r) => r.accountId));
}

/**
 * One tick of the clock the deployed schedule runs (`apps/worker/src/api-cron.ts`, every 60 s).
 *
 * The send budget is lifted deliberately: this file's subject is the ACCOUNT page, and with the
 * shipped budget of five the walk would stop on account five and measure the budget instead.
 */
async function tick(handle: typeof db, f: Fleet, at: Date) {
  const r = recorder();
  const spy = logSpy();
  const result = await runAwayResponderPass(handle as never, {
    openSendAdapter: r.factory, now: () => at, mailboxIds: f.mailboxIds, sendsPerRun: N * 2,
    log: spy.log,
  });
  return { result, delivered: r.delivered, errors: spy.errors };
}

const minutes = (k: number) => new Date(NOW.getTime() + k * 60_000);

describe.skipIf(!PG_UP)("the away pass reaches every enabled responder", () => {
  /**
   * CONTROL 1 — the subject. Fifty-one enabled responders, each with one person waiting for a
   * reply. One tick cannot serve them all and is not meant to; the claim is that the next tick
   * serves the one it missed.
   *
   * Mutation watched red: `asc(awayResponders.lastConsideredAt)` deleted from the probe's ORDER BY
   * — the pass as it shipped. The fifty-first is then missing after tick two and after tick three,
   * and the assertion names it.
   */
  it("reaches all fifty-one across successive ticks, and the last one in the second", async () => {
    const f = await seedFleet(N);
    const last = f.accountIds[N - 1]!;

    const t1 = await tick(db, f, minutes(0));
    const after1 = await answered(f);
    expect(t1.errors).toEqual([]);                 // no account was "reached" by failing in it
    expect(t1.result.accounts).toBe(AWAY_ACCOUNTS_PER_RUN);
    expect(after1.size).toBe(AWAY_ACCOUNTS_PER_RUN);
    expect(after1.has(last)).toBe(false);          // the defect, still true after one tick

    const t2 = await tick(db, f, minutes(1));
    const after2 = await answered(f);
    expect(t2.errors).toEqual([]);
    expect(after2.has(last)).toBe(true);           // …and untrue after the next one
    expect(after2.size).toBe(N);
  });

  /**
   * CONTROL 2 — THE POSITIVE ONE. The rotation must not have removed the cap: a tick still walks
   * at most `AWAY_ACCOUNTS_PER_RUN` accounts, which is the bound the serverless deadline is sized
   * against. Mutation watched red: `.limit(AWAY_ACCOUNTS_PER_RUN + 1)`.
   */
  it("still walks at most one page per tick", async () => {
    const f = await seedFleet(N);
    const t1 = await tick(db, f, minutes(0));
    expect(t1.result.accounts).toBe(AWAY_ACCOUNTS_PER_RUN);
    expect(t1.delivered.length).toBe(AWAY_ACCOUNTS_PER_RUN);
    const t2 = await tick(db, f, minutes(1));
    expect(t2.result.accounts).toBe(AWAY_ACCOUNTS_PER_RUN);
  });

  /**
   * CONTROL 3 — a responder switched off between two ticks is not answered afterwards, however
   * near the front of the rotation it has come. The one the first tick could not reach is the
   * hardest case: with the fix it sorts FIRST in the second tick, so the only thing between it
   * and a reply is the probe's refusal.
   *
   * Written off the way the product writes it: `AwayResponderService.put` runs `nextEnabledAt`,
   * which returns null for `enabled: false`, so an off row ALWAYS carries a null instant.
   *
   * MEASURED, and the reason this case has a twin below: THREE mechanisms refuse that one state —
   * `eq(enabled, true)` and `isNotNull(enabled_at)` in the WHERE, and `if (!enabledAt) continue`
   * in the loop — so deleting any ONE of them leaves this green. (`eq(enabled, true)` alone was
   * run and stayed green, 4 passed.) This case therefore measures the refusal as a whole, and the
   * twin isolates the predicate the brief names.
   */
  it("does not answer a responder switched off mid-rotation", async () => {
    const f = await seedFleet(N);
    const last = f.accountIds[N - 1]!;

    await tick(db, f, minutes(0));
    expect((await answered(f)).has(last)).toBe(false);

    await db.update(awayResponders).set({ enabled: false, enabledAt: null })
      .where(eq(awayResponders.accountId, last));

    const t2 = await tick(db, f, minutes(1));
    expect((await answered(f)).has(last)).toBe(false);
    expect(t2.result.accounts).toBe(N - 1);        // it is not even walked
  });

  /**
   * CONTROL 3's TWIN — `enabled = false` ALONE refuses, with the enablement instant left standing.
   *
   * No product writer leaves that pair (see above), and that is the point: the row is the STRICTER
   * subject, one that still looks live in every column but the switch, so `eq(enabled, true)` is
   * the single line deciding it. Mutation watched red: that predicate deleted from the WHERE.
   */
  it("refuses a row whose switch is off even where the enablement instant still stands", async () => {
    const f = await seedFleet(N);
    const last = f.accountIds[N - 1]!;

    await tick(db, f, minutes(0));
    expect((await answered(f)).has(last)).toBe(false);

    await db.update(awayResponders).set({ enabled: false })
      .where(eq(awayResponders.accountId, last));

    const t2 = await tick(db, f, minutes(1));
    expect((await answered(f)).has(last)).toBe(false);
    expect(t2.result.accounts).toBe(N - 1);
  });

  /**
   * CONTROL 4 — THE DURABILITY. The second tick runs on a client opened after the first one
   * finished: a different connection, a different pool, nothing in memory between them. Only the
   * row carries the rotation, which is the difference between this fix and a module variable that
   * would pass every other case in this file.
   *
   * Mutation watched red: the `markConsidered(db, walked, now())` call deleted — the fresh client
   * redraws the first page and the fifty-first is never answered.
   */
  it("carries the rotation across processes, not in memory", async () => {
    const f = await seedFleet(N);
    const last = f.accountIds[N - 1]!;

    await tick(db, f, minutes(0));
    expect((await answered(f)).has(last)).toBe(false);

    const second = postgres(PG_TEST_URL, { max: 2 });
    try {
      const fresh = brandDialect(drizzle(second), "pg");
      await tick(fresh as never, f, minutes(1));
    } finally {
      await second.end({ timeout: 5 });
    }

    expect((await answered(f)).has(last)).toBe(true);
  });
});
