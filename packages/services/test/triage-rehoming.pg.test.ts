import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dbFor } from "../src/context.js";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { accounts, mailboxes, messages } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { TriageService, type ServiceContext } from "@trafficflow/services";

/**
 * ══ THE UN-PARK RE-HOMING UNDER REAL CONCURRENCY (review round on that change) ══════════════════
 *
 * `TriageService.setState` classifies a `none` transition by the PRIOR state — did the row just
 * leave a bottom pile? — and re-homes a read row's `last_read_at` to the message's own date when
 * it did. Two review findings live exactly in the gaps PGlite cannot exercise:
 *
 *  · THE CLASSIFICATION RACE: one client PARKS while a second, stale client CLEARS. Without a
 *    lock, the clear reads `prior = none` beside the park's uncommitted insert, then wins the
 *    upsert queue — final state `none`, and the re-homing skipped even though the winning
 *    transition just emptied a pile. The fix is the message-row `FOR UPDATE` on the guard
 *    select, which serializes the classification with the sibling transition. The interleave
 *    below is DETERMINISTIC: the park's transaction is held open at a gate (drizzle commits
 *    when the callback resolves, so awaiting inside delays the COMMIT), the clear is started
 *    against the held lock, and only then is the gate released.
 *
 *  · THE LATER-WORD RULE: `resurface_done` dispatches `triage_set: none` and a deliberate
 *    `mark_seen` WITHOUT awaiting, so either may commit first. The re-homing's row predicate
 *    (`last_read_at <= prior.setAt`) is what makes the outcomes converge: a fresh deliberate
 *    stamp — newer than the pile entry — survives the clear whichever order lands. Proven here
 *    on real Postgres because the predicate is exactly the kind of fragment PGlite binds
 *    happily while postgres-js parameterizes differently (the repo's standing pg rule).
 *
 * ONE suite at a time on :5433 — the shared advisory-lock rule.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let owned: OwnedDb;
let db: OwnedDb["db"];

const NOW = new Date("2026-08-24T12:00:00.000Z");
const DATE = new Date("2026-08-01T09:00:00.000Z");

const ctx = (accountId: string): ServiceContext => ({
  db: dbFor(db, accountId),
  accountId,
  userId: null,
  now: () => NOW,
  requestId: `rehome-${randomUUID().slice(0, 8)}`,
});

async function newWorld(): Promise<{ accountId: string; messageId: string }> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `rehome-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `rehome-${accountId.slice(0, 8)}@example.test`,
  }).returning();
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "rh", dedupKey: `rh:${randomUUID()}`,
    subject: "re-homed", fromAddress: "s@example.test", date: DATE, unread: false,
    // The pre-park glance's stamp — inside the parked interlude, so the re-homing disowns it.
    lastReadAt: new Date("2026-08-20T10:00:00.000Z"),
    nativeLocator: { folder: "INBOX", ref: "1:1" },
  }).returning();
  return { accountId, messageId: m!.id };
}

const rowOf = async (id: string) =>
  (await db.select({ lastReadAt: messages.lastReadAt }).from(messages).where(eq(messages.id, id)))[0]!;

describe.skipIf(!PG_UP)("un-park re-homing on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 6, onnotice: () => {} });
    owned = makeOwnedDb(PG_TEST_URL);
    db = owned.db;
  }, 120_000);
  afterAll(async () => { await owned?.close(); await client?.end({ timeout: 5 }); });

  it("a STALE CLEAR racing a PARK still re-homes — the message-row lock serializes the classification", async () => {
    const w = await newWorld();
    const svc = new TriageService();

    // The park's transaction, held open at a gate AFTER its writes: the clear must start
    // while the park is uncommitted, which is the exact window the finding names.
    let releasePark!: () => void;
    const gate = new Promise<void>((resolve) => { releasePark = resolve; });
    let signalParked!: () => void;
    const parked = new Promise<void>((resolve) => { signalParked = resolve; });
    const parkCtx = ctx(w.accountId);
    const realTransaction = db.transaction.bind(db);
    (parkCtx.db as unknown as { transaction: typeof realTransaction }).transaction = (async (
      cb: Parameters<typeof realTransaction>[0],
    ) => realTransaction(async (tx) => {
      const out = await cb(tx);
      // DETERMINISTIC, not a sleep: the park's writes (its FOR UPDATE included) are done the
      // instant this resolves, and only then does the rival start — a slow runner cannot let
      // the clear slip in first and fail the test on scheduling (review round).
      signalParked();
      await gate; // writes done, COMMIT delayed — the rival runs inside this window
      return out;
    })) as typeof realTransaction;

    const park = svc.setState(parkCtx, w.messageId, { state: "reply_later" });
    await parked;
    const clear = svc.setState(ctx(w.accountId), w.messageId, { state: "none" });
    // The clear's arrival AT the row lock has no signal to await (it blocks inside Postgres);
    // this grace only widens the uncommitted window it runs into. Too small on a loaded
    // runner degrades toward the sequential ordering — which converges to the same final
    // state — so the wrong direction here is a vacuous pass, never a flake failure.
    await new Promise((r) => setTimeout(r, 300));
    releasePark();
    await Promise.all([park, clear]);

    // The clear was serialized BEHIND the park, classified against the committed
    // `reply_later`, and re-homed: the glance stamp is disowned for the message's own date.
    expect((await rowOf(w.messageId)).lastReadAt?.toISOString()).toBe(DATE.toISOString());
  });

  it("the deliberate read's stamp survives the un-awaited clear, in BOTH commit orders", async () => {
    const svc = new TriageService();
    const doneNow = new Date("2026-08-24T12:30:00.000Z");

    // Order A: the read lands first, the clear second — the predicate must not rewind it.
    const a = await newWorld();
    await svc.setState(ctx(a.accountId), a.messageId, { state: "bubbled_up", bubbleUpAt: "2026-09-01T09:00:00.000Z" });
    await db.update(messages).set({ lastReadAt: doneNow }).where(eq(messages.id, a.messageId));
    await svc.setState(ctx(a.accountId), a.messageId, { state: "none" });
    expect((await rowOf(a.messageId)).lastReadAt?.toISOString()).toBe(doneNow.toISOString());

    // Order B: the clear lands first (re-homes to the date), the read second (stamps NOW) —
    // the same end state from the other side.
    const b = await newWorld();
    await svc.setState(ctx(b.accountId), b.messageId, { state: "bubbled_up", bubbleUpAt: "2026-09-01T09:00:00.000Z" });
    await svc.setState(ctx(b.accountId), b.messageId, { state: "none" });
    expect((await rowOf(b.messageId)).lastReadAt?.toISOString()).toBe(DATE.toISOString());
    await db.update(messages).set({ lastReadAt: doneNow }).where(eq(messages.id, b.messageId));
    expect((await rowOf(b.messageId)).lastReadAt?.toISOString()).toBe(doneNow.toISOString());
  });
});
