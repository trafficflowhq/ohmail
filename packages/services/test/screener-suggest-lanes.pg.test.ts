import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { accounts, mailboxes, messages, folderState } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import type { ClassifierPort } from "@trafficflow/core";
import { ScreenerService, suggestLaneGate, type ServiceContext } from "@trafficflow/services";
import { pgTestUrl } from "@trafficflow/db/testing";
import { fakeSpendPort } from "./helpers/spend-port-fake.js";
import { PLANE_PRICING } from "./helpers/plane-pricing.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE PURCHASE BUYS ITS SENDERS IN LANES, AND THE MONEY IS UNMOVED
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `ScreenerService.suggest` bought one sender at a time. The whole of its wall clock was a model
 * round trip it spent idle — measured at ~2 s per sender — so a fifteen-sender request took about
 * thirty seconds, and the largest ladder the client offers was many of those,
 * about a quarter of an hour.
 *
 * ── WHY THIS IS STILL A `pg` TEST ───────────────────────────────────────────────────────────
 *
 * Not for the money any more — the spend verdict comes from a port and its double answers a
 * counter (whether a balance serialises is the entitlements program's property and is proven on
 * its side). What is left is this repository's, and it is a database property: each sender's
 * work RESOLVES and STORES inside its own transaction on ONE handle, so what the lanes actually
 * contend for is `messages`/`folder_state` reads and the mirror write. A single-connection
 * PGlite serialises everything anyway and would report that green for a build with no lane
 * bounding at all.
 *
 * ── AND THE CONNECTION IS `max: 1`, DELIBERATELY ────────────────────────────────────────────
 *
 * Every serverless invocation of the API dials one connection (`packages/db/src/client.ts`), and
 * that is the shape this change had to be safe under: N lanes issuing transactions into ONE
 * postgres.js handle. Its own header claims `max: 1` QUEUES rather than errors; this file is the
 * first thing in the tree that depends on that claim being true of concurrent `db.transaction()`
 * calls, so it is driven rather than read. A handle sized like the other race fixtures (`max: 5`)
 * would prove the easy case and leave production's untested.
 */
const URL = pgTestUrl(import.meta.url);

/** PRODUCTION'S SHAPE. See the header — this number is the point of the file, not a default. */
const sql = postgres(URL, { max: 1 });
const db = brandDialect(drizzle(sql, { schema }), "pg");

const NOW = new Date("2026-09-02T12:00:00Z");

/**
 * The measured cost of one screening call, as a sleep.
 *
 * 120 ms and not the ~2 000 ms a hosted model actually takes: the RATIO is what this file
 * measures and a faithful latency would make the suite take a minute to say the same thing. The
 * arithmetic scales — at the real figure the same fifteen senders are 30 s serial and ~6 s in
 * five lanes.
 */
const MODEL_MS = 120;

interface Trace {
  /** How many classify calls were in flight at once, at the peak. */
  peak: number;
  live: number;
  calls: number;
  /** The `From` of every call, in the order the model was actually asked. */
  order: string[];
}

function slowClassifier(t: Trace): ClassifierPort {
  return {
    async classify(i) {
      t.calls++;
      t.order.push(i.from.address);
      t.live++;
      t.peak = Math.max(t.peak, t.live);
      await new Promise((r) => setTimeout(r, MODEL_MS));
      t.live--;
      return { destination: "INBOX", confidence: 0.9, rationale: `about ${i.from.address}`, spam: false };
    },
  };
}

/**
 * THE SPEND PORT, RECORDING — module-scoped, like the lane gate it is measured beside.
 *
 * Every case sets its own budget through {@link FakeSpendPort.budget}, so "stops at the balance"
 * is still driven end to end; what is no longer here is a ledger, because the open server does
 * not keep one. `spends` is what a debit count used to be read from, and it is a stronger
 * reading: it records the ACTION and the bare attempt key each lane asked with, which is the
 * half a ledger row could not show.
 */
const credits = fakeSpendPort();

const ctxFor = (accountId: string): ServiceContext =>
  ({ db, accountId, userId: null, now: () => NOW, requestId: randomUUID() });

/** `granted` is the number of spends the port will admit before it answers `insufficient`. */
async function seedAccount(granted: number, senders: string[]): Promise<string> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "lanes" });
  credits.budget(granted);
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `lanes-${accountId.slice(0, 8)}@ex.example` }).returning();
  for (const from of senders) {
    const dedup = `mid:${randomUUID()}`;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
      subject: "first contact", fromAddress: from, date: NOW, snippet: "hello",
      nativeLocator: { folder: "ohmail/Screener", ref: `1:${Math.floor(Math.random() * 1e6)}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
  }
  return accountId;
}

/** What this account was CHARGED for, read off the port's own record of what it was asked. */
const debitsOf = async (accountId: string) =>
  credits.spends.filter(
    (c) => c.accountId === accountId && c.action === "screener" && c.outcome.verdict === "ok",
  );

const SENDERS = (n: number, tag: string): string[] =>
  Array.from({ length: n }, (_, i) => `${tag}${String(i).padStart(2, "0")}@ex.example`);

describe("a suggest request buys its senders in bounded lanes", () => {
  beforeAll(async () => { await runMigrations(URL); });
  afterAll(async () => { await sql.end({ timeout: 5 }); });

  it("overlaps the model calls, and the overlap is BOUNDED", async () => {
    const senders = SENDERS(15, "lane");
    const accountId = await seedAccount(100, senders);
    const t: Trace = { peak: 0, live: 0, calls: 0, order: [] };
    const svc = new ScreenerService({ classifier: slowClassifier(t), credits, pricing: PLANE_PRICING });

    const started = Date.now();
    const res = await svc.suggest(ctxFor(accountId), { senders });
    const elapsed = Date.now() - started;

    expect(res.suggestions).toHaveLength(15);
    expect(t.calls).toBe(15);

    // ── THE ACCELERATION ────────────────────────────────────────────────────────────────────
    //
    // Serial is 15 × MODEL_MS of model time and nothing overlaps. The bar is set at TWO THIRDS of
    // that rather than at the theoretical fifth, because the database phase of each sender is
    // real and — on a `max: 1` handle — genuinely serial: this asserts that the model waits
    // overlap, not that the whole request divides by five.
    expect(
      elapsed,
      `the purchase is still serial: ${elapsed} ms for 15 senders at ${MODEL_MS} ms each`,
    ).toBeLessThan(15 * MODEL_MS * (2 / 3));

    // ── AND THE BOUND, WHICH IS THE OTHER HALF ──────────────────────────────────────────────
    //
    // `Promise.all` over the set would pass the assertion above and put fifty model calls in
    // flight against a per-account rate limit. The peak is what says the fan-out is bounded, and
    // it is read from the model port itself rather than from a constant this file imports.
    expect(t.peak, "the fan-out is unbounded").toBeLessThanOrEqual(5);
    expect(t.peak, "nothing overlapped at all — the lanes are not running").toBeGreaterThan(1);
  }, 60_000);

  it("the answer is in the CALLER'S order, whatever order the lanes finish in", async () => {
    // The model is asked in lane order, which is not the caller's; the RESPONSE must be, or two
    // identical requests answer differently and "stopped at N of M" names a different sender each
    // time.
    const senders = SENDERS(12, "ord");
    const accountId = await seedAccount(100, senders);
    const t: Trace = { peak: 0, live: 0, calls: 0, order: [] };
    const svc = new ScreenerService({ classifier: slowClassifier(t), credits, pricing: PLANE_PRICING });

    const res = await svc.suggest(ctxFor(accountId), { senders });

    expect(res.suggestions.map((s) => s.sender)).toEqual(senders);
    // …and the run really was interleaved, or the assertion above is satisfied by a serial build.
    expect(t.peak).toBeGreaterThan(1);
  }, 60_000);

  it("stops at the balance and never past it — the ledger after a partial run", async () => {
    // Eight credits, twenty senders, five lanes. The lanes cannot admit past the balance because
    // `spend` is the authority and it serialises on the balance row; the senders it refuses are
    // reported rather than dropped.
    const senders = SENDERS(20, "cap");
    const accountId = await seedAccount(8, senders);
    const t: Trace = { peak: 0, live: 0, calls: 0, order: [] };
    const svc = new ScreenerService({ classifier: slowClassifier(t), credits, pricing: PLANE_PRICING });

    const res = await svc.suggest(ctxFor(accountId), { senders });

    expect(res.charged, "the run spent past the balance").toBe(8);
    expect(t.calls, "the model was asked about mail nobody paid for").toBe(8);
    expect(await debitsOf(accountId)).toHaveLength(8);
    expect(res.suggestions).toHaveLength(8);
    expect(res.skipped).toHaveLength(12);
    expect(res.skipped.every((s) => s.reason === "out_of_credits")).toBe(true);
    expect(res.stopped).toBe("out_of_credits");
    // Every named sender is accounted for exactly once, in the caller's order — a partial run may
    // not lose one.
    expect([...res.suggestions.map((s) => s.sender), ...res.skipped.map((s) => s.sender)].sort())
      .toEqual([...senders].sort());
  }, 60_000);

  it("a FATAL lane closes the queue — a storage fault may not go on debiting the batch", async () => {
    /*
     * The review finding this exists for. `buy` catches the MODEL's own faults per sender; what
     * reaches the pool is the rest — `store` rejecting, the database going away mid-write. In the
     * serial loop that throw left the function and nothing else was bought. `Promise.all` does not
     * have that property: it rejects on the first error and leaves the other lanes running, so a
     * transient fault would go on dequeuing and DEBITING while the caller already has a 500 and no
     * idempotency row is claimed. Money moved for work nobody will ever see.
     */
    const senders = SENDERS(20, "fat");
    const accountId = await seedAccount(100, senders);
    const t: Trace = { peak: 0, live: 0, calls: 0, order: [] };
    const svc = new ScreenerService({ classifier: slowClassifier(t), credits, pricing: PLANE_PRICING });
    // The FOURTH model answer explodes on the way to storage — after its debit, which is what
    // makes the count below meaningful.
    let answered = 0;
    const realStore = (svc as unknown as { store: (...a: unknown[]) => Promise<void> }).store;
    (svc as unknown as { store: (...a: unknown[]) => Promise<void> }).store = async function (...a: unknown[]) {
      if (++answered === 4) throw new Error("the mirror went away mid-write");
      return realStore.apply(this, a);
    };

    await expect(svc.suggest(ctxFor(accountId), { senders }))
      .rejects.toThrow(/the mirror went away mid-write/);

    // THE BOUND. Without it every one of the twenty is debited while the caller gets an error.
    // At most the lanes that were already in flight when the throw landed may have joined the
    // four that were admitted before it — never the whole batch.
    const debits = await debitsOf(accountId);
    expect(
      debits.length,
      `a fatal lane kept spending: ${debits.length} of ${senders.length} senders were debited`,
    ).toBeLessThanOrEqual(4 + 5);
    expect(debits.length, "nothing was bought at all — the test is measuring the wrong throw")
      .toBeGreaterThanOrEqual(4);
    // …and every lane LANDED. A lane still mid-model-call when the error propagated would keep
    // running after the response, which is the other half of the same defect.
    expect(t.live, "a lane was still in flight when the call returned").toBe(0);
  }, 60_000);

  it("the lane ceiling is per PROCESS — two concurrent requests do not double the fan-out", async () => {
    /*
     * The second review finding. A bound local to one call bounds nothing a rate limit cares
     * about: the lanes of two requests do not contend on the per-source claim (different accounts,
     * different messages), so before the module-level gate ten requests put fifty model calls in
     * flight — exactly the fan-out the bound exists to prevent.
     *
     * The trace is SHARED between the two services, so `peak` is the real simultaneous count
     * across both requests rather than each one's own.
     */
    const mine = SENDERS(10, "pa");
    const theirs = SENDERS(10, "pb");
    const a = await seedAccount(100, mine);
    const b = await seedAccount(100, theirs);
    const t: Trace = { peak: 0, live: 0, calls: 0, order: [] };
    const shared = slowClassifier(t);
    const svcA = new ScreenerService({ classifier: shared, credits, pricing: PLANE_PRICING });
    const svcB = new ScreenerService({ classifier: shared, credits, pricing: PLANE_PRICING });

    await Promise.all([
      svcA.suggest(ctxFor(a), { senders: mine }),
      svcB.suggest(ctxFor(b), { senders: theirs }),
    ]);

    expect(t.calls).toBe(20);
    expect(
      t.peak,
      `two requests put ${t.peak} model calls in flight at once — the ceiling is per request, not per process`,
    ).toBeLessThanOrEqual(5);
    expect(t.peak, "nothing overlapped — the measurement is not exercising the gate").toBeGreaterThan(1);
  }, 60_000);

  it("NOTHING IS CHARGED FOR A QUEUE POSITION — the slot is taken before the money", async () => {
    /*
     * The review finding this exists for, and it is the one that would have cost real money. The
     * first version of the gate took its slot around the MODEL CALL — after `gate.spend()` had
     * already debited and claimed. On a host that multiplexes several requests into one instance
     * the queue can outlive the invocation, and a request the platform KILLS has no response, no
     * `finally` and no idempotency row: what is left behind is a charged, claimed sender nobody
     * will ever be shown.
     *
     * So: every slot is held, a purchase is started, and after a window long enough for a whole
     * sender's work the ledger must still be EMPTY. Then the slots are released and the same
     * purchase completes normally — which is what says the emptiness above was the gate and not a
     * broken request.
     */
    const senders = SENDERS(3, "q");
    const accountId = await seedAccount(100, senders);
    const t: Trace = { peak: 0, live: 0, calls: 0, order: [] };
    const svc = new ScreenerService({ classifier: slowClassifier(t), credits, pricing: PLANE_PRICING });

    // Every slot, held by "another request". COUNTED, because the gate is module-scoped and
    // shared by every case in this file: a slot leaked out of a failing assertion here makes each
    // later one queue for the whole request budget, which looks exactly like a hang.
    const far = Date.now() + 30_000;
    let held = 0;
    let run: Promise<unknown> | null = null;
    try {
      for (let i = 0; i < 5; i++) {
        expect(await suggestLaneGate.acquire(far)).toBe(true);
        held++;
      }
      run = svc.suggest(ctxFor(accountId), { senders });
      // A whole sender's work — model, store and the transactions either side — with the gate
      // full. Nothing may have moved.
      await new Promise((r) => setTimeout(r, MODEL_MS * 4));

      expect(t.calls, "the model was called from behind a full gate").toBe(0);
      expect(
        (await debitsOf(accountId)).length,
        "a sender was charged for a queue position",
      ).toBe(0);

      // Let them through, and the SAME purchase finishes — which is what says the emptiness above
      // was the gate and not a broken request.
      while (held > 0) { suggestLaneGate.release(); held--; }
      const res = (await run) as Awaited<ReturnType<ScreenerService["suggest"]>>;
      run = null;
      expect(res.suggestions).toHaveLength(3);
      expect(res.charged).toBe(3);
      expect(await debitsOf(accountId)).toHaveLength(3);
    } finally {
      while (held > 0) { suggestLaneGate.release(); held--; }
      // An in-flight purchase must not outlive the test either: it holds slots of its own.
      if (run) await run.catch(() => undefined);
    }
  }, 60_000);

  it("A HOST THAT STATES A CEILING refuses past it, and charges nothing to say so", async () => {
    /*
     * `invocationBudgetMs` declared, and small enough that the admission window is already gone
     * before the first lane asks. Every sender must come back `spend_unavailable` — the honest
     * "ask again" — and the ledger must be untouched, because a slot the budget cannot buy is a
     * refusal rather than a purchase.
     */
    const senders = SENDERS(4, "bud");
    const accountId = await seedAccount(100, senders);
    const t: Trace = { peak: 0, live: 0, calls: 0, order: [] };
    // The window is `budget − the model ceiling − the store`, clamped at zero: any budget at or
    // below the ceiling admits nothing at all.
    const svc = new ScreenerService({ classifier: slowClassifier(t), credits, pricing: PLANE_PRICING, invocationBudgetMs: 1 });

    await expect(svc.suggest(ctxFor(accountId), { senders }))
      .rejects.toMatchObject({ code: "ai_unavailable", httpStatus: 503 });

    expect(t.calls, "the model was asked inside a window that had already closed").toBe(0);
    expect(await debitsOf(accountId), "a sender was charged for work that was never admitted")
      .toHaveLength(0);
  }, 60_000);

  it("A HOST THAT STATES NONE waits instead — the window is not universal", async () => {
    /*
     * Three hosts compose this service and only ONE is killed by a platform. The self-hosted
     * server and the standalone desktop's engine are ordinary processes, and the desktop's
     * provider deliberately permits a sixty-second model call because a local model is slow.
     * Applying the serverless window there would refuse every sender after the first round —
     * a deadline enforcing a ceiling that host does not have.
     *
     * No `invocationBudgetMs`, every slot held: the purchase must WAIT, then complete in full.
     */
    const senders = SENDERS(3, "unb");
    const accountId = await seedAccount(100, senders);
    const t: Trace = { peak: 0, live: 0, calls: 0, order: [] };
    const svc = new ScreenerService({ classifier: slowClassifier(t), credits, pricing: PLANE_PRICING });

    const far = Date.now() + 30_000;
    let held = 0;
    let run: Promise<unknown> | null = null;
    try {
      for (let i = 0; i < 5; i++) { expect(await suggestLaneGate.acquire(far)).toBe(true); held++; }
      run = svc.suggest(ctxFor(accountId), { senders });
      await new Promise((r) => setTimeout(r, MODEL_MS * 4));
      expect(t.calls, "a host with no ceiling started work from behind a full gate").toBe(0);
      expect(await debitsOf(accountId)).toHaveLength(0);

      while (held > 0) { suggestLaneGate.release(); held--; }
      const res = (await run) as Awaited<ReturnType<ScreenerService["suggest"]>>;
      run = null;
      expect(res.suggestions, "the wait became a refusal — the serverless window was applied here")
        .toHaveLength(3);
      expect(res.skipped).toEqual([]);
    } finally {
      while (held > 0) { suggestLaneGate.release(); held--; }
      if (run) await run.catch(() => undefined);
    }
  }, 60_000);

  it("a DRY RUN answers out of the resolution pass alone — no lane, no model, no debit", async () => {
    const senders = SENDERS(20, "dry");
    const accountId = await seedAccount(100, senders);
    const t: Trace = { peak: 0, live: 0, calls: 0, order: [] };
    const svc = new ScreenerService({ classifier: slowClassifier(t), credits, pricing: PLANE_PRICING });

    const res = await svc.suggest(ctxFor(accountId), { senders, dryRun: true });

    expect(res.quoted).toBe(20);
    expect(res.charged).toBe(0);
    expect(t.calls, "a quote reached the model").toBe(0);
    expect(await debitsOf(accountId), "a quote debited").toHaveLength(0);
  }, 60_000);

  it("one sender's model fault costs that sender and no other lane", async () => {
    // Per-item isolation was a property of the serial loop by accident — a throw left the whole
    // pass. In lanes it has to be a property of the lane, and a lane that swallowed the wrong
    // thing would take four other senders' verdicts with it.
    const senders = SENDERS(10, "flt");
    const accountId = await seedAccount(100, senders);
    const t: Trace = { peak: 0, live: 0, calls: 0, order: [] };
    const inner = slowClassifier(t);
    const svc = new ScreenerService({
      classifier: {
        async classify(i) {
          if (i.from.address === "flt04@ex.example") throw new Error("the model refused this one");
          return inner.classify(i);
        },
      },
      credits, pricing: PLANE_PRICING,
    });

    const res = await svc.suggest(ctxFor(accountId), { senders });

    expect(res.suggestions).toHaveLength(9);
    expect(res.suggestions.map((s) => s.sender)).not.toContain("flt04@ex.example");
    expect(res.skipped).toEqual([{ sender: "flt04@ex.example", reason: "model_unavailable" }]);
    // The charge for the failed sender STANDS, deliberately — the source is stable, so the retry
    // answers `duplicate` and is free. Ten debits for nine verdicts is the documented shape.
    expect(await debitsOf(accountId)).toHaveLength(10);
  }, 60_000);
});
