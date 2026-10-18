import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { accountSettings, folderState, mailboxes, messageBodies, messages, unsubscribeRecords } from "@trafficflow/db";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeUnsubscribeService, startDrainBudget, unsubscribeListKey,
  UNSUB_DRAIN_BUDGET_MS, UNSUB_DRAIN_SCAN_PAGE, UNSUB_DRAIN_WINDOW_MS, UNSUB_ITEM_MIN_MS,
  UNSUB_SYNC_MAX,
  type HostResolver, type OneClickPost,
} from "../src/index.js";
import { makeCtx, personScreenedOut, seedMessage } from "./helpers.js";

/**
 * first half: THE DRAIN BECOMES DRAINABLE.
 *
 * The row was ledgered with a design and the design was reverted unshipped, for a reason this
 * file is the answer to: **the candidate set was not self-shrinking.** `run()` refuses a message
 * with no `List-Unsubscribe`, or one whose `-Post` is missing, BEFORE it claims — so no record
 * row is written and the message stays a candidate for ever. Most screened-out mail publishes no
 * one-click route at all, so a bounded pass would have spent its whole budget re-refusing the
 * same rows and never reached what a request deferred. A drain like that is decorative.
 *
 * Three things make it real, and each has its case below: the candidate query asks the two header
 * keys RFC 8058 requires, it takes the oldest first because an unordered LIMIT is a sample, and
 * the production entry bounds accounts, targets and the clock — the three ways one run could be
 * unbounded.
 */

const PUBLIC_DNS: HostResolver = { async resolve() { return ["93.184.216.34"]; } };
/**
 * The position a Gmail-held mailbox trusts (`providerAuthservIds`), and that provider confirming a
 * candidate's sender, which `seedCandidate` writes: the drain asks a list only for a confirmed
 * sender, and every bound here is about something else.
 */
const GMAIL: ReadonlySet<string> = new Set(["mx.google.com"]);
const CONFIRMED = { "authentication-results": ["mx.google.com; dmarc=pass"] };

const ONE_CLICK = {
  "list-unsubscribe": ["<https://sender.example/u?t=abc>"],
  "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
};
const NO_POST_HEADER = { "list-unsubscribe": ["<https://sender.example/u?t=abc>"] };
const NO_HEADER_AT_ALL: Record<string, string[]> = {};

/**
 * `onSend` lets a case charge its OWN clock for the post, which is the only cost the budget rule
 * is about. `delayMs` remains for the cases that want real elapsed time.
 */
function spyPost(delayMs = 0, onSend?: () => void): OneClickPost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async post(url: string) {
      if (delayMs > 0) await new Promise((r) => { setTimeout(r, delayMs); });
      onSend?.();
      calls.push(url);
      return { status: 200 };
    },
  };
}

const svcWith = (post: OneClickPost) =>
  makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => GMAIL });

type Db = Awaited<ReturnType<typeof makeCtx>>["db"];

async function seedCandidate(
  db: Db, accountId: string, mailboxId: string,
  headers: Record<string, string[]>,
  opts: { from?: string; screenedAt?: Date } = {},
): Promise<string> {
  const from = opts.from ?? `news-${randomUUID()}@sender.example`;
  const messageId = await seedMessage(db, accountId, mailboxId, { from, folder: "ohmail/Screened" });
  await personScreenedOut(db, accountId, from);
  await db.insert(messageBodies).values({ messageId, text: "", headers: { ...CONFIRMED, ...headers } });
  if (opts.screenedAt) {
    await db.update(folderState).set({ updatedAt: opts.screenedAt })
      .where(eq(folderState.messageId, messageId));
  }
  return messageId;
}

/**
 * A page's worth of INELIGIBLE rows, cheaply. The shape is the common one: mail screened out that
 * publishes no one-click route at all, so there is no body row for the header test to pass. Bulk
 * inserts because the point of the case is to exceed {@link UNSUB_DRAIN_SCAN_PAGE}, and a case that
 * cannot reach the fence cannot meet the defect the fence caused.
 */
async function seedIneligible(
  db: Db, accountId: string, mailboxId: string, n: number, at: Date,
): Promise<void> {
  for (let start = 0; start < n; start += 250) {
    const rows = [];
    for (let i = start; i < Math.min(start + 250, n); i += 1) {
      const dedup = `mid:bulk-${accountId}-${i}`;
      rows.push({
        accountId, mailboxId, messageIdHeader: dedup, bodyHash: dedup, dedupKey: dedup,
        subject: "bulk", fromAddress: `bulk-${i}@noroute.example`, date: at,
        nativeLocator: { folder: "ohmail/Screened", ref: `1:${i}` }, snippet: "", unread: true,
      });
    }
    const made = await db.insert(messages).values(rows).returning({ id: messages.id });
    await db.insert(folderState).values(made.map((m) => ({
      messageId: m.id, desiredFolder: "ohmail/Screened", observedFolder: "ohmail/Screened",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false, updatedAt: at,
    })));
    await personScreenedOut(db, accountId, "noroute.example", { kind: "domain" });
  }
}

const NOW = new Date("2026-07-28T12:00:00Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const SINCE_ALL = ago(UNSUB_DRAIN_WINDOW_MS);

describe("the drain's candidate set shrinks", () => {
  it("a sender with no one-click route is NOT a candidate — it used to be one for ever", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx(NOW);
    await seedCandidate(db, accountId, mailboxId, NO_HEADER_AT_ALL);
    await seedCandidate(db, accountId, mailboxId, NO_POST_HEADER);

    const post = spyPost();
    const sweep = await svcWith(post).sweepScreenedOut(ctx, { since: SINCE_ALL, limit: 10 });

    // Not "considered and skipped" — never looked at. That is the difference between a pass that
    // makes progress and one that re-reads the same refusals until the window moves.
    expect(sweep.considered).toBe(0);
    expect(post.calls).toEqual([]);
  });

  it("…and one that does publish a route still is", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx(NOW);
    await seedCandidate(db, accountId, mailboxId, ONE_CLICK);
    await seedCandidate(db, accountId, mailboxId, NO_POST_HEADER);

    const post = spyPost();
    const sweep = await svcWith(post).sweepScreenedOut(ctx, { since: SINCE_ALL, limit: 10 });

    expect(sweep.considered).toBe(1);
    expect(sweep.posted).toBe(1);
    expect(post.calls).toHaveLength(1);
  });

  it("takes the OLDEST first — an unordered LIMIT is a sample", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx(NOW);
    // SEEDED NEWEST FIRST, so insertion order CONTRADICTS the order under test. Seeded the other
    // way round an unordered query returns the right answer by accident and the case measures
    // nothing — the mutation that deletes the `orderBy` has to be able to fail.
    await seedCandidate(db, accountId, mailboxId, ONE_CLICK, {
      from: "c@newest.example", screenedAt: ago(60 * 60 * 1000),
    });
    const middle = await seedCandidate(db, accountId, mailboxId, ONE_CLICK, {
      from: "b@other.example", screenedAt: ago(2 * 60 * 60 * 1000),
    });
    const oldest = await seedCandidate(db, accountId, mailboxId, ONE_CLICK, {
      from: "a@sender.example", screenedAt: ago(3 * 60 * 60 * 1000),
    });

    const sweep = await svcWith(spyPost()).sweepScreenedOut(ctx, { since: SINCE_ALL, limit: 2 });
    expect(sweep.considered).toBe(2);

    const touched = (await db.select().from(unsubscribeRecords)
      .where(eq(unsubscribeRecords.accountId, accountId))).map((r) => r.messageId);
    expect(touched.sort()).toEqual([oldest, middle].sort());
  });
});

describe("one drain run is bounded three ways", () => {
  it("bounds the ACCOUNTS it looks at, and says something is still owed", async () => {
    const { db, accountId, mailboxId } = await makeCtx(NOW);
    await seedCandidate(db, accountId, mailboxId, ONE_CLICK, { screenedAt: ago(3 * 60 * 60 * 1000) });
    const otherAccount = randomUUID();
    const [otherMb] = await db.insert(mailboxes)
      .values({ accountId: otherAccount, provider: "imap", address: "b@lichtgrat.example" }).returning();
    await seedCandidate(db, otherAccount, otherMb!.id, ONE_CLICK, { screenedAt: ago(60 * 60 * 1000) });

    const post = spyPost();
    const run = await svcWith(post).drainScreenedOut(db, {
      now: () => NOW, requestId: "drain", accounts: 1, perAccount: 10,
    });

    expect(run.accounts).toBe(1);
    expect(run.sweep.posted).toBe(1);
    // COUNTED, not inferred: the other account's one candidate is what is still owed. The old
    // answer here was the boolean `true`, assembled from three guesses, and an operator reading a
    // cron table cannot tell from it whether a pass is keeping up.
    expect(run.remaining).toBe(1);

    // …and the SECOND run reaches the other account: the bound defers, it does not drop.
    const second = await svcWith(post).drainScreenedOut(db, {
      now: () => NOW, requestId: "drain", accounts: 1, perAccount: 10,
    });
    expect(second.accounts).toBe(1);
    expect(second.sweep.posted).toBe(1);
    expect(post.calls).toHaveLength(2);
    // …and nothing is owed once both are done, which is the other half of the same number.
    expect(second.remaining).toBe(0);
  });

  it("does not reach outside its window — the backlog the manual sweep refuses stays refused", async () => {
    const { db, accountId, mailboxId } = await makeCtx(NOW);
    await seedCandidate(db, accountId, mailboxId, ONE_CLICK, {
      screenedAt: ago(UNSUB_DRAIN_WINDOW_MS + 60 * 60 * 1000),
    });

    const post = spyPost();
    const run = await svcWith(post).drainScreenedOut(db, { now: () => NOW, requestId: "drain" });

    expect(run.accounts).toBe(0);
    expect(post.calls).toEqual([]);
  });

  it("the CLOCK stops it mid-list, and what it did not reach is `remaining`", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx(NOW);
    for (const who of ["a@one.example", "b@two.example", "c@three.example"]) {
      await seedCandidate(db, accountId, mailboxId, ONE_CLICK, { from: who });
    }

    // A budget with room for exactly one item: the first is started, and once the post has spent
    // its share the two behind it no longer clear `UNSUB_ITEM_MIN_MS` and are left for the next
    // run rather than dropped — or, worse, begun on a clock that cannot pay for them. An item
    // STARTED with nothing left is aborted on the wire and settles `failed`, which spends the
    // at-most-once claim on an outcome nobody chose; that is why the refusal is before the item
    // and not only before the post.
    //
    // DRIVEN BY A CLOCK THIS CASE OWNS, not by the wall. Its first form gave the budget a
    // ten-millisecond margin over the item floor and let the real clock spend it, so under load
    // the candidate read ate the margin before the first post and the case reddened at zero
    // considered — a guard whose verdict moves with the machine measures the machine. Only the
    // POST moves this clock, which is the cost the rule is written about.
    let now = 0;
    const post = spyPost(0, () => { now += 20; });
    const sweep = await svcWith(post).sweepScreenedOut(ctx, {
      since: SINCE_ALL, limit: 3,
      budget: startDrainBudget(UNSUB_ITEM_MIN_MS + 10, 0, () => now),
    });

    expect(sweep.considered).toBe(1);
    expect(sweep.remaining).toBe(2);
    expect(post.calls).toHaveLength(1);
  });

  it("an account that turned the pass off is not selected, and is refused at the seam anyway", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx(NOW);
    const id = await seedCandidate(db, accountId, mailboxId, ONE_CLICK);
    await db.insert(accountSettings).values({ accountId, blockAutoUnsubscribeAt: NOW });

    const post = spyPost();
    const run = await svcWith(post).drainScreenedOut(db, { now: () => NOW, requestId: "drain" });
    expect(run.accounts).toBe(0);

    // The selection is an optimisation; this is the decision. Driven separately so that removing
    // the predicate from the query cannot make this file green on the seam's behalf.
    const sweep = await svcWith(post).onScreenOut(ctx, [id]);
    expect(sweep).toEqual({ considered: 0, posted: 0, skipped: 0, failed: 0, remaining: 0 });
    expect(post.calls).toEqual([]);
  });
});

describe("the in-request fan-out stops, and says what it left", () => {
  it("fifty targets under a five-target ceiling: five now, forty-five for the drain", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx(NOW);
    const ids: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      ids.push(await seedCandidate(db, accountId, mailboxId, ONE_CLICK, {
        from: `sender-${i}@list-${i}.example`,
      }));
    }

    const post = spyPost();
    const sweep = await svcWith(post).onScreenOut(ctx, ids);

    expect(sweep.considered).toBe(UNSUB_SYNC_MAX);
    expect(sweep.remaining).toBe(50 - UNSUB_SYNC_MAX);
    expect(post.calls).toHaveLength(UNSUB_SYNC_MAX);

    // …AND THE FORTY-FIVE ARE NOT LOST. This is the half that makes the ceiling honest: the row
    // this closes refused a cap precisely because a cap without a drain converts an over-long
    // request into silently unfinished work.
    const drained = await svcWith(post).drainScreenedOut(db, {
      now: () => NOW, requestId: "drain", perAccount: 100,
    });
    expect(drained.sweep.posted).toBe(50 - UNSUB_SYNC_MAX);
    expect(post.calls).toHaveLength(50);
  });
});

/**
 * THE FOUR CONTROLS for `UNSUBSCRIBE-DRAIN-NEVER-SUCCEEDED-IN-PRODUCTION` (2026-09-14). The
 * hourly pass answered `timeout` on both of the two runs it ever made: it spent 53.6 s of a 60 s
 * invocation in the account census — a query that ran BEFORE its own 45 s clock started — and was
 * killed by the platform, owing four unsubscribes. The fourth control lives beside the caller, in
 * `apps/worker/test/api-cron.test.ts`.
 *
 * Watched red 2026-09-14, one mutation per property, each restored by copying the pristine file
 * back and proved by `cmp` — the figures below are the measured failures, not the predicted ones:
 *  · the budget re-entered per account (`budget` → `startDrainBudget(…)` in the loop) → 1 failed
 *    / 12 passed: "a target that hangs" red, the post handed more time than was left.
 *  · the item guard reduced to the count (`postingLeftMs() < UNSUB_ITEM_MIN_MS` dropped) →
 *    "the CLOCK stops it mid-list" red, considered 3 where the budget paid for 1. Re-watched
 *    after that case was made to drive its own clock: its first form left a ten-millisecond
 *    margin for the real clock to spend, and under a loaded machine the candidate read ate the
 *    margin before the first post — a guard whose verdict moves with the machine measures the
 *    machine, so the post now charges a clock the case owns.
 *  · `budget?.postingLeftMs()` dropped from the POST call → "a target that hangs" red: the port
 *    was handed `undefined`, which is its own 8 s inside a run that has two.
 *  · the claim's exclusion defeated (`if (claim === null)` never taken) → "a call the platform
 *    killed" red at two posts, which is the sequence that leaves a person's list twice.
 *  · `owedCount` replaced by the run's own remainder → "ten times the batch" red at tick 1:
 *    a full backlog read as nothing owed, the exact silent-green the count exists against.
 *  · the page's `.limit(UNSUB_DRAIN_SCAN_PAGE)` deleted → the census below red.
 * A case timeout note that is part of the watch: the hang case runs under 30 s deliberately, so a
 * lost budget fails on the assertion that names the property rather than on the runner's clock —
 * the first attempt at two of these mutations reddened by test timeout, which proves the run was
 * slow and nothing about which bound was missing.
 */
describe("one run is bounded, and what it leaves is counted", () => {
  it("a backlog of ten times the batch drains to zero across ticks, every call inside the bound", async () => {
    const { db, accountId, mailboxId } = await makeCtx(NOW);
    const BATCH = 5;
    for (let i = 0; i < BATCH * 10; i += 1) {
      await seedCandidate(db, accountId, mailboxId, ONE_CLICK, { from: `sender-${i}@list-${i}.example` });
    }

    const post = spyPost();
    const svc = svcWith(post);
    const owedAfter: number[] = [];
    let ticks = 0;
    for (;;) {
      const run = await svc.drainScreenedOut(db, {
        now: () => NOW, requestId: "drain", perAccount: BATCH,
      });
      ticks += 1;
      // COUNTED, on every tick. A window this small is walked to its end each time, so a `null`
      // here would mean the walk stopped early on fifty rows — which is the other half of the
      // same honesty and would make the sequence below a sequence of guesses.
      expect(run.remaining, `tick ${ticks} must have reached the end of the window`).not.toBeNull();
      owedAfter.push(run.remaining!);
      // EVERY call, not the last: a pass whose first run pays the whole backlog is the shape
      // that met the platform's kill, and a bound read only at the end is no bound during.
      expect(run.elapsedMs, `tick ${ticks} must stay inside one run's budget`)
        .toBeLessThan(UNSUB_DRAIN_BUDGET_MS);
      expect(run.sweep.posted).toBe(BATCH);
      if (run.remaining === 0 || ticks > 20) break;
    }

    expect(ticks).toBe(10);
    expect(post.calls).toHaveLength(BATCH * 10);
    // Strictly down, every tick, ending at nothing owed — the remainder DEFERS, it never drops.
    expect(owedAfter).toEqual([45, 40, 35, 30, 25, 20, 15, 10, 5, 0]);
  });

  it("a target that hangs spends only what is left of the budget, and the call still returns", async () => {
    const { db, accountId, mailboxId } = await makeCtx(NOW);
    const messageId = await seedCandidate(db, accountId, mailboxId, ONE_CLICK);

    const handed: (number | undefined)[] = [];
    const hang: OneClickPost = {
      async post(_url, _pin, timeoutMs) {
        handed.push(timeoutMs);
        // PRODUCTION'S OWN SHAPE: the AbortController fires at the deadline and the request
        // THROWS. A double that resolved would measure a path the wire never takes.
        await new Promise((r) => { setTimeout(r, timeoutMs ?? 8_000); });
        throw new Error("aborted at the deadline");
      },
    };

    const budgetMs = UNSUB_ITEM_MIN_MS + 100;
    // The budget and the hung post on a FAKE clock, stepped over an in-memory store: the run
    // meets its budget at its real size and nothing sleeps.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let run: Awaited<ReturnType<ReturnType<typeof svcWith>["drainScreenedOut"]>>;
    try {
      const started = Date.now();
      let done = false;
      const drained = svcWith(hang).drainScreenedOut(db, {
        now: () => NOW, requestId: "drain", budget: startDrainBudget(budgetMs, 0),
      }).finally(() => { done = true; });
      for (let at = 0; !done && at < 20_000; at += 100) await vi.advanceTimersByTimeAsync(100);
      run = await drained;
      const wall = Date.now() - started;

      // The post was handed the REMAINDER, never its own ceiling: 8 s inside a run that has two
      // is how the last item of a 45 s pass used to run past a 60 s kill.
      expect(handed).toHaveLength(1);
      expect(handed[0]!).toBeLessThanOrEqual(budgetMs);
      expect(handed[0]!, "the port's own 8 s ceiling may not be what a short run waits").toBeLessThan(8_000);
      expect(wall).toBeLessThan(budgetMs + 1_500);
      expect(run.elapsedMs).toBeLessThan(budgetMs + 1_500);
    } finally {
      vi.useRealTimers();
    }

    // The item is FAILED, not skipped and not silently retried: we cannot tell whether the
    // sender received it, and at-most-once resolves that toward not sending again.
    expect(run.sweep.failed).toBe(1);
    expect(run.sweep.posted).toBe(0);
    const [row] = await db.select().from(unsubscribeRecords)
      .where(eq(unsubscribeRecords.messageId, messageId));
    expect(row!.state).toBe("failed");
    // A generous case timeout ON PURPOSE. The default 5 s is shorter than the port's own 8 s
    // ceiling, so a run that lost its budget would die on the RUNNER's clock and the assertions
    // above — the ones that name the property — would never run. The mutations for this case are
    // watched red on `handed[0]` and on the wall clock, which is what they are for.
  }, 30_000);

  it("a call the platform killed leaves no item the next call delivers twice", async () => {
    const { db, accountId, mailboxId } = await makeCtx(NOW);
    const post = spyPost();
    const svc = svcWith(post);

    // (a) DELIVERED, then killed before the run could report it — the state production was
    // measured in: one record row written late in an invocation, state `sent`.
    await seedCandidate(db, accountId, mailboxId, ONE_CLICK, { from: "news@list.example" });
    expect((await svc.drainScreenedOut(db, { now: () => NOW, requestId: "drain" })).sweep.posted).toBe(1);
    expect(post.calls).toHaveLength(1);

    // A SECOND message from the same list, and a second tick: the claim is the whole mutual
    // exclusion, so the list is not left twice.
    await seedCandidate(db, accountId, mailboxId, ONE_CLICK, { from: "news@list.example" });
    const again = await svc.drainScreenedOut(db, { now: () => NOW, requestId: "drain" });
    expect(post.calls).toHaveLength(1);
    expect(again.sweep.posted).toBe(0);

    // (b) THE STATE A KILL ACTUALLY LEAVES — claimed, never settled, because the invocation died
    // between the insert and the update. It is not a candidate again and nobody is posted to: the
    // outcome is lost, the at-most-once is not.
    const third = await seedCandidate(db, accountId, mailboxId, ONE_CLICK, { from: "other@elsewhere.example" });
    await db.insert(unsubscribeRecords).values({
      accountId, mailboxId,
      listKey: unsubscribeListKey(ONE_CLICK, "other@elsewhere.example"),
      state: "claimed", messageId: third, createdAt: NOW, updatedAt: NOW,
    });
    const third_run = await svc.drainScreenedOut(db, { now: () => NOW, requestId: "drain" });
    expect(post.calls).toHaveLength(1);
    expect(third_run.sweep.posted).toBe(0);
    // NOTHING IS STILL COUNTED, and that changed with mail 0116. The second message of the list
    // already left in (a) has no record row of its own — the record is keyed by (mailbox, list)
    // and belongs to the FIRST message — so it used to stay in the window until it aged out,
    // looked at each run and posted to never, and `remaining` named it for ever. The pass now
    // marks a message examined against the record it was judged by, so the run above was the last
    // one to look at it. `remaining` counts what the next run will LOOK AT, which is the number
    // that answers "is this pass keeping up"; it is not a count of unsubscribes owed.
    expect(third_run.remaining).toBe(0);
    expect(third_run.sweep.skipped).toBe(0);
    const [row] = await db.select().from(unsubscribeRecords)
      .where(eq(unsubscribeRecords.messageId, third));
    expect(row!.state).toBe("claimed");
  });
});

/**
 * THE MECHANISM ITSELF, and it is a census because no unit test can see a query PLAN. The
 * deployment-wide scan was one shape: asked as a flat join the planner estimated a single row,
 * drove from `messages` and probed the body of every message before applying the selective
 * predicate. The fix is structural — a subquery carrying its own LIMIT is not reordered into the
 * join — so what is asserted here is the structure, and the timing that justifies it is the
 * production EXPLAIN (ANALYZE) recorded in the change file, not something this file can measure.
 *
 * The second case is the half the first one cost: the fence must not also be the FILTER. Judging
 * rows inside the chunk and returning a flag is what lets the cursor advance past what the pass
 * may not act on; filtering there is what starved it.
 *
 * Watched red: `.limit(UNSUB_DRAIN_SCAN_PAGE)` deleted from the chunk, and the eligibility
 * expression turned back into a `.where(...)`.
 */
describe("the candidate reads drive from the fenced chunk, never from every message", () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/unsubscribe-service.ts"), "utf8",
  );
  const bodyOf = (name: string): string => {
    const at = src.indexOf(name);
    expect(at, `${name} must exist`).toBeGreaterThan(-1);
    return src.slice(at, src.indexOf("\n  }", at));
  };

  it("the chunk carries its own LIMIT — that is what stops the planner reordering it away", () => {
    const chunk = bodyOf("private async scanChunk(");
    expect(chunk).toContain(".from(folderState)");
    expect(chunk).toContain(`.limit(UNSUB_DRAIN_SCAN_PAGE)`);
    // Oldest first inside the fence, or the chunk itself becomes the sample an unordered LIMIT is.
    expect(chunk).toContain("asc(folderState.updatedAt)");
    // …and a CURSOR, which is what makes a second chunk mean anything.
    expect(chunk).toContain("after === null ? undefined");
  });

  it("the chunk JUDGES rather than filters, so the cursor can advance past what it rejected", () => {
    const chunk = bodyOf("private async scanChunk(");
    // The eligibility facts arrive as a flag on every row the chunk read…
    // The GENERIC is not part of that: `boolean` was a falsehood on the device store, which
    // answers an integer where the server answers `true`, so the flag is a verdict word now and
    // `unsubscribe-drain-dialect.test.ts` is what reads it on both. What is guarded here is that
    // eligibility is a SELECTED column at all, which is the difference from a filter.
    expect(chunk).toContain("eligible: sql<");
    // …through LEFT joins, so the chunk's own row count survives to drive the cursor.
    expect(chunk.includes(".innerJoin(messageBodies"), "the body join must not shorten the chunk").toBe(false);
    // …and the two mailbox facts are asked together, in that one expression.
    expect(chunk).toContain("blockAutoUnsubscribeAt");
    expect(chunk).toContain("mailboxes.status");
  });

  it("every read that probes the headers goes through the chunk walk", () => {
    for (const name of ["async sweepScreenedOut(", "async drainScreenedOut(", "private async owedCount("]) {
      const body = bodyOf(name);
      expect(body, `${name} must go through the walk`).toContain("walkWindow(");
      // BOTH SPELLINGS, because the probe changed its name. `jsonb_exists` is the server-only
      // form the chunk used to carry; `jsonHasAny` is the seam's, which is what it carries now —
      // a needle naming only the removed one is a guard that can no longer fire.
      const probe = ["jsonb_exists", "jsonHasAny"].filter((fn) => body.includes(fn));
      expect(probe, `${name} must not carry its own header probe`).toEqual([]);
      expect(body.includes(".from(messages)"), `${name} must not drive from messages`).toBe(false);
    }
  });
});

/**
 * THE STARVATION THE PAGE CAUSED (a high product review finding). The fence that
 * closed the deployment-wide scan was cut on `folder_state` ALONE, and both readers joined it — so
 * a page filled with rows that turn out to be ineligible left the drain posting nothing AND made
 * `remaining` read 0, which is a health row stating that nothing is owed while the backlog stands.
 * A bounded page is cut AFTER every exclusion that decides eligibility, or the bound selects work
 * the pass cannot do.
 *
 * Watched red against the tip that carried the fence, BEFORE the fix was written: zero posts and
 * `remaining: 0` while one candidate was owed. Watched red again after it, by advancing the walk's
 * cursor to the last ELIGIBLE row instead of the last row READ — which is the same defect stated
 * as an off-by-one and the reason the cursor is the mechanism rather than the chunk size.
 */
describe("a page full of ineligible rows does not hide the work behind it", () => {
  it("a deep pile of older ineligible rows in front of one eligible candidate: delivered in ONE tick, and `remaining` is honest", async () => {
    const { db, accountId, mailboxId } = await makeCtx(NOW);
    // The whole fence's worth, OLDER than the candidate, so oldest-first puts every one of them
    // ahead of it. They publish no unsubscribe route, which is what most screened-out mail does.
    await seedIneligible(db, accountId, mailboxId, UNSUB_DRAIN_SCAN_PAGE, ago(6 * 60 * 60 * 1000));

    // …and the eligible one is in ANOTHER account, so a page held by one account is also a
    // fairness failure and not only an ordering one.
    const otherAccount = randomUUID();
    const [otherMb] = await db.insert(mailboxes)
      .values({ accountId: otherAccount, provider: "imap", address: "b@lichtgrat.example" }).returning();
    await seedCandidate(db, otherAccount, otherMb!.id, ONE_CLICK, { screenedAt: ago(60 * 60 * 1000) });

    const post = spyPost();
    const run = await svcWith(post).drainScreenedOut(db, { now: () => NOW, requestId: "drain" });

    expect(post.calls, "the candidate behind the ineligible page is delivered").toHaveLength(1);
    expect(run.sweep.posted).toBe(1);
    // …and only THEN is nothing owed. A `remaining` of 0 that is a page's residue is the number
    // that told an operator the pass was keeping up while it had not looked at the backlog.
    expect(run.remaining).toBe(0);
  }, 120_000);

  it("`remaining` is null, never 0, when the walk did not reach the end of the window", async () => {
    const { db, accountId, mailboxId } = await makeCtx(NOW);
    await seedIneligible(db, accountId, mailboxId, UNSUB_DRAIN_SCAN_PAGE, ago(6 * 60 * 60 * 1000));
    await seedCandidate(db, accountId, mailboxId, ONE_CLICK, { screenedAt: ago(60 * 60 * 1000) });

    // A budget that cannot pay for the walk: the run stops early and says it did not measure.
    // `0` here would be the same lie the case above is about, told by a different route.
    const run = await svcWith(spyPost()).drainScreenedOut(db, {
      now: () => NOW, requestId: "drain", budget: startDrainBudget(1, 0),
    });
    expect(run.remaining).toBeNull();
  }, 120_000);
});

/**
 * A DISCONNECTED MAILBOX IS ACTED FOR BY NOTHING (a high product review finding).
 * Disconnecting keeps the organizer role and the mirrored messages, and the pass asked only the
 * role — so it went on posting unsubscribes in the name of a mailbox its owner had stopped. Leave
 * anytime and nothing-sends-without-an-explicit-action, failing together.
 *
 * Watched red, and the FIRST attempt at it was green — recorded because a mutation that cannot
 * fail is not a watch. Removing `mailboxes.status <> 'disabled'` from the chunk left this file
 * green on the SEAM's behalf: the seam refuses, the sweep counts a skip, no POST is made, so the
 * sent count cannot see the predicate at all. The pair is split by asserting what only the
 * predicate decides — whether the pass LOOKS — and the mutation then reddens at `considered 1`
 * where nothing may be considered. The seam's own throw removed reddens the third case.
 */
describe("a mailbox the person disconnected sends nothing", () => {
  it("holds the deferred unsubscribe while it is disconnected, and drains it once it is back", async () => {
    const { db, accountId, mailboxId } = await makeCtx(NOW);
    await seedCandidate(db, accountId, mailboxId, ONE_CLICK);
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mailboxId));

    const post = spyPost();
    const off = await svcWith(post).drainScreenedOut(db, { now: () => NOW, requestId: "drain" });
    expect(post.calls, "nothing leaves in the name of a mailbox its owner stopped").toEqual([]);
    expect(off.sweep.posted).toBe(0);
    // THE PREDICATE'S OWN EFFECT, ASSERTED APART FROM THE SEAM'S. Removing the status from the
    // walk left this case green on the seam's behalf — the seam refuses, the sweep counts a skip
    // and no POST is made, so the sent count cannot see the predicate at all. What only the
    // predicate decides is whether the pass LOOKS: a row it must not act on is not a candidate,
    // so it is neither considered nor counted as owed.
    expect(off.sweep.considered, "a disconnected mailbox's mail is not even looked at").toBe(0);
    expect(off.sweep.skipped).toBe(0);
    expect(off.remaining, "nothing is owed for a mailbox nobody may send for").toBe(0);
    // …and the intent is HELD, not destroyed: the row is still there for the next connect.
    expect(await db.select().from(unsubscribeRecords)).toHaveLength(0);

    // Reconnected, the same candidate drains — the positive control that the predicate excludes
    // a state and not the whole account.
    await db.update(mailboxes).set({ status: "connected" }).where(eq(mailboxes.id, mailboxId));
    const on = await svcWith(post).drainScreenedOut(db, { now: () => NOW, requestId: "drain" });
    expect(on.sweep.posted).toBe(1);
    expect(post.calls).toHaveLength(1);
  });

  it("`error` is not `disabled` — a mailbox that is failing to sync is still the person's", async () => {
    const { db, accountId, mailboxId } = await makeCtx(NOW);
    await seedCandidate(db, accountId, mailboxId, ONE_CLICK);
    await db.update(mailboxes).set({ status: "error" }).where(eq(mailboxes.id, mailboxId));

    const post = spyPost();
    const run = await svcWith(post).drainScreenedOut(db, { now: () => NOW, requestId: "drain" });
    expect(run.sweep.posted).toBe(1);
  });

  it("the SEAM refuses too, so removing the predicate cannot make this pass on the query's behalf", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx(NOW);
    const id = await seedCandidate(db, accountId, mailboxId, ONE_CLICK);
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mailboxId));

    const post = spyPost();
    await expect(svcWith(post).unsubscribe(ctx, id))
      .rejects.toMatchObject({ code: "unsubscribe_mailbox_disconnected", httpStatus: 409 });
    expect(post.calls).toEqual([]);
  });
});

/**
 * A CLAIM IS NOT AN OUTCOME (a high product review finding). The record is written
 * BEFORE the request, so its existence says only that somebody got as far as trying. Answering
 * `already_recorded` on it told a person — through `ScreenerView`'s "Already unsubscribed from
 * this list." — that a send which never happened was done, while the mail kept arriving.
 *
 * Watched red: the state test removed from `run()` (every conflict answers `already_recorded`) →
 * the stranded case red, `already_recorded` where a send had to happen. The in-flight age gate
 * removed → the last case red AND `unsubscribe-idempotency.pg.test.ts`'s eight-concurrent-presses
 * case red at eight requests to a stranger, which is why the gate is an AGE and not a flag: a
 * `claimed` row is an attempt in flight or a stranded one, and only its age tells them apart.
 */
describe("a claim that never sent is not reported as done", () => {
  const strandedRecord = async (
    db: Db, accountId: string, mailboxId: string, state: string, at: Date,
  ): Promise<void> => {
    await db.insert(unsubscribeRecords).values({
      accountId, mailboxId,
      listKey: unsubscribeListKey(ONE_CLICK, "news@list.example"),
      state, messageId: await seedCandidate(db, accountId, mailboxId, ONE_CLICK, { from: "news@list.example" }),
      createdAt: at, updatedAt: at,
    });
  };

  it("a stranded claim, then a person's press: a send happens", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx(NOW);
    await strandedRecord(db, accountId, mailboxId, "claimed", ago(60 * 60 * 1000));
    const id = await seedCandidate(db, accountId, mailboxId, ONE_CLICK, { from: "news@list.example" });

    const post = spyPost();
    const res = await svcWith(post).unsubscribe(ctx, id);

    expect(res.refusal, "a claim that never sent may not answer `already_recorded`").toBeNull();
    expect(res.posted).toBe(true);
    expect(post.calls).toHaveLength(1);
    // The SAME row settles — no second row is ever inserted, which is what stops duplicate sends.
    const rows = await db.select().from(unsubscribeRecords);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("sent");
  });

  it("a FAILED record behaves the same for a person, and never for the pass", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx(NOW);
    await strandedRecord(db, accountId, mailboxId, "failed", ago(60 * 60 * 1000));
    const id = await seedCandidate(db, accountId, mailboxId, ONE_CLICK, { from: "news@list.example" });

    const post = spyPost();
    // The unattended pass does NOT retry: it cannot tell its own retry from a second send.
    const swept = await svcWith(post).onScreenOut(ctx, [id]);
    expect(post.calls).toEqual([]);
    expect(swept.skipped).toBe(1);

    // The person's press does.
    const res = await svcWith(post).unsubscribe(ctx, id);
    expect(res.posted).toBe(true);
    expect(post.calls).toHaveLength(1);
  });

  it("a SETTLED send still answers `already_recorded` — the case the old answer was written for", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx(NOW);
    await strandedRecord(db, accountId, mailboxId, "sent", ago(60 * 60 * 1000));
    const id = await seedCandidate(db, accountId, mailboxId, ONE_CLICK, { from: "news@list.example" });

    const post = spyPost();
    const res = await svcWith(post).unsubscribe(ctx, id);
    expect(res.refusal).toBe("already_recorded");
    expect(res.posted).toBe(false);
    expect(post.calls).toEqual([]);
  });

  it("a claim still IN FLIGHT is not re-issued — the duplicate-send arm", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx(NOW);
    // Written at the clock's own now: this is what a concurrent press finds, and re-attempting it
    // is how eight presses become eight requests to a stranger.
    await strandedRecord(db, accountId, mailboxId, "claimed", NOW);
    const id = await seedCandidate(db, accountId, mailboxId, ONE_CLICK, { from: "news@list.example" });

    const post = spyPost();
    const res = await svcWith(post).unsubscribe(ctx, id);
    expect(res.refusal).toBe("previous_attempt_unsettled");
    expect(res.refusal, "…and never the sentence that says it is done").not.toBe("already_recorded");
    expect(post.calls).toEqual([]);
  });
});
