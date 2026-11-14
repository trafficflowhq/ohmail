import { readFileSync } from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";
import { callCeilingMs } from "@trafficflow/core";
import { ENTITLEMENTS_CALL_BUDGET_MS } from "@trafficflow/db/cloud";
import {
  LaneGate, SUGGEST_ADMISSION, SUGGEST_RECOMMENDED_PER_REQUEST, MAX_SUGGEST_SENDERS,
  admissionDeadline,
} from "../src/screener-service.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE SUGGEST LANE GATE — the admission control, driven directly
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `screener-suggest-lanes.pg.test.ts` proves what the gate does to a PURCHASE: five model calls in
 * flight and no more, across requests as well as within one. What it cannot reach is the gate's own
 * two failure modes, because both need a queue longer than a test may wait for — and both are ways
 * this optimisation turns into a defect rather than a slowdown:
 *
 *  1. **A wait with no deadline is a request that never answers.** On a host that multiplexes four
 *     forty-sender calls into one instance, 160 two-second model calls through five slots is over
 *     two minutes and the invocation is killed at sixty seconds. The caller takes its slot BEFORE
 *     it debits, so a slot that cannot be had inside the budget must come back as a refusal that
 *     spent nothing — never as a wait that outlives the response.
 *  2. **A timed-out waiter that stays in the queue shrinks the ceiling for ever.** `release` hands
 *     its slot to the head of the queue rather than decrementing; hand it to a waiter that has
 *     already given up and the slot is gone — not returned, not taken, just missing. Five becomes
 *     four, then three, for the life of the process, and nothing anywhere reports it.
 *
 * Both are cheap to drive here and impossible to drive through a real purchase, which is why this
 * file exists beside the other one rather than instead of it.
 */

/** A slot held for `ms`, so a test can occupy the gate deliberately. */
async function hold(g: LaneGate, ms: number, deadline = Date.now() + 5_000): Promise<boolean> {
  const ok = await g.acquire(deadline);
  if (!ok) return false;
  setTimeout(() => g.release(), ms).unref?.();
  return true;
}

describe("the suggest lane gate", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("admits up to the ceiling immediately, and no further", async () => {
    // On a fake clock that stands still: a wait of any length would never end here.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const g = new LaneGate(3);
    const now = Date.now();
    expect(await g.acquire(now + 1_000)).toBe(true);
    expect(await g.acquire(now + 1_000)).toBe(true);
    expect(await g.acquire(now + 1_000)).toBe(true);
    // The fourth cannot be had; with a deadline already past it must not wait at all.
    const started = Date.now();
    expect(await g.acquire(Date.now() - 1)).toBe(false);
    expect(Date.now() - started, "a past deadline still waited").toBeLessThan(50);
  });

  it("REFUSES rather than waiting past the deadline — the money argument", async () => {
    // The deadline on a fake clock: the wait is open one tick short of it and refused at it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const g = new LaneGate(1);
    expect(await g.acquire(Date.now() + 1_000)).toBe(true);   // the only slot, held

    const started = Date.now();
    let settled = false;
    const waiting = g.acquire(Date.now() + 60).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(59);
    expect(settled, "the lane gave up before its deadline").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const refused = await waiting;
    const waited = Date.now() - started;

    expect(refused, "a lane waited past its budget instead of refusing").toBe(false);
    expect(waited).toBeGreaterThanOrEqual(50);
    expect(waited, "the deadline was not honoured").toBeLessThan(1_000);
  });

  it("a timed-out waiter does not eat a slot — the ceiling survives", async () => {
    // THE LEAK. Without the queue removal in the timeout, `release` below hands its slot to the
    // waiter that has already given up: nothing decrements, nothing is admitted, and the gate is
    // permanently one narrower. Ten rounds, because one leaked slot on a ceiling of two is still
    // half a working gate and would pass a single-round assertion.
    const g = new LaneGate(2);
    for (let i = 0; i < 10; i++) {
      expect(await g.acquire(Date.now() + 1_000)).toBe(true);
      expect(await g.acquire(Date.now() + 1_000)).toBe(true);
      expect(await g.acquire(Date.now() + 30), `round ${i}`).toBe(false);   // times out, gives up
      g.release();
      g.release();
    }
    // …and the gate still admits its full ceiling afterwards.
    expect(await g.acquire(Date.now() + 200)).toBe(true);
    expect(await g.acquire(Date.now() + 200), "the ceiling shrank — a timed-out waiter ate a slot")
      .toBe(true);
  });

  it("hands a released slot to the waiter that arrived FIRST", async () => {
    // Not fairness for its own sake: without it a request that has been queuing for its whole
    // budget can be overtaken by one that just arrived, and the overtaken one then answers
    // `spend_unavailable` for senders it was next in line for.
    const g = new LaneGate(1);
    expect(await g.acquire(Date.now() + 1_000)).toBe(true);

    const order: string[] = [];
    const first = g.acquire(Date.now() + 2_000).then((ok) => { order.push(`first:${String(ok)}`); });
    // A tick apart, so "arrived first" is a fact about the queue rather than about scheduling.
    await new Promise((r) => setTimeout(r, 20));
    const second = g.acquire(Date.now() + 2_000).then((ok) => { order.push(`second:${String(ok)}`); });

    g.release();
    await first;
    expect(order, "the queue is not FIFO").toEqual(["first:true"]);
    g.release();
    await second;
    expect(order).toEqual(["first:true", "second:true"]);
  });

  it("REFUSES an idle slot once the deadline has passed — capacity is not a reason to start", async () => {
    /*
     * The second review finding, and the sharper of the two. `acquire` tested CAPACITY first, so
     * once a run had passed its budget the very next lane to finish handed its slot straight to
     * another sender: admitted, debited and started AFTER the window that exists to stop exactly
     * that. The gate was empty, so nothing waited and nothing was refused.
     *
     * An empty gate is precisely the state this must still refuse in.
     */
    const g = new LaneGate(5);
    expect(await g.acquire(Date.now() - 1), "an idle gate admitted work past the deadline").toBe(false);

    // …and it is the DEADLINE doing it, not a broken gate: the same idle gate admits at once with
    // a live one.
    expect(await g.acquire(Date.now() + 1_000)).toBe(true);

    // The realistic sequence: a slot is released after the budget has gone, and the next caller
    // must not be handed it.
    const h = new LaneGate(1);
    expect(await h.acquire(Date.now() + 1_000)).toBe(true);
    h.release();
    expect(await h.acquire(Date.now() - 1), "a released slot outlived the budget").toBe(false);
  });

  it("the admission window is what the invocation LEAVES, not a number somebody liked", () => {
    /*
     * The other half of the same finding. Forty-five seconds was wrong by construction: the hosted
     * classifier's own worst case is forty, so a lane admitted at forty-five is past the invocation
     * before it starts. The window has to be `invocation − that ceiling − the store`.
     *
     * Every number is recomputed here from its real source rather than restated: `callCeilingMs`
     * is the function the client actually uses, the timeout and retry count are read out of the
     * API host's own composition root, and `maxDuration` out of the route that serves this service.
     * A change to any of them reddens this instead of silently shrinking the margin.
     */
    const deps = readFileSync(new URL("../../../apps/server/src/deps.ts", import.meta.url), "utf8");
    const classify = /classifier[\s\S]{0,600}?timeoutMs:\s*([0-9_]+)[\s\S]{0,200}?maxRetries:\s*([0-9]+)/
      .exec(deps) ?? /timeoutMs:\s*([0-9_]+),\s*\n\s*maxRetries:\s*([0-9]+)/.exec(deps);
    expect(classify, "could not read the API host's classifier timeout/retries").not.toBeNull();
    const timeoutMs = Number(classify![1]!.replace(/_/g, ""));
    const maxRetries = Number(classify![2]!);

    const route = readFileSync(
      new URL("../../../apps/api-vercel/app/[[...path]]/route.ts", import.meta.url), "utf8");
    const maxDuration = Number(/export const maxDuration = ([0-9]+)/.exec(route)?.[1]);
    expect(maxDuration, "could not read maxDuration off the route").toBeGreaterThan(0);

    expect(
      SUGGEST_ADMISSION.modelCallCeilingMs,
      "the service's model-call ceiling is no longer what the deployment actually permits",
    ).toBe(callCeilingMs({ timeoutMs, maxRetries }));
    expect(SUGGEST_ADMISSION.invocationMs).toBe(maxDuration * 1_000);
    /*
     * THE SPEND CALL IS PART OF THE WORST CASE and the service restates its budget, because `src`
     * may not name the Cloud barrel. This is the pin that makes the restatement safe: raise the
     * client's budget without widening the subtraction and a lane admitted at the deadline
     * overruns its invocation — charged, claimed, and killed before anything is stored.
     */
    expect(
      SUGGEST_ADMISSION.spendCallCeilingMs,
      "the service's spend-call ceiling no longer matches the client's own budget",
    ).toBe(ENTITLEMENTS_CALL_BUDGET_MS);
    expect(SUGGEST_ADMISSION.windowMs)
      .toBe(SUGGEST_ADMISSION.invocationMs - SUGGEST_ADMISSION.spendCallCeilingMs
        - SUGGEST_ADMISSION.modelCallCeilingMs - SUGGEST_ADMISSION.storeMarginMs);
    // And it is a window a request can actually use — a non-positive one refuses everything and
    // would make the whole endpoint answer 503.
    expect(SUGGEST_ADMISSION.windowMs).toBeGreaterThan(0);

    // ── THE REQUEST SIZE THE SERVER PUBLISHES HAS TO FIT INSIDE IT ────────────────────────
    //
    // Lanes admit in rounds, so the whole of a request must be ADMITTED within the window or its
    // tail comes back `spend_unavailable` — and the client halts its chunk sequence on `stopped`,
    // which turns a large purchase into "stopped at thirty-something". This is the arithmetic that
    // keeps the published size and the window from drifting apart, and it is why the size is
    // derived rather than chosen.
    const rounds = Math.ceil(SUGGEST_RECOMMENDED_PER_REQUEST / SUGGEST_ADMISSION.lanes);
    expect(
      rounds * SUGGEST_ADMISSION.perSenderBudgetMs,
      `a full request needs ${String(rounds * SUGGEST_ADMISSION.perSenderBudgetMs)} ms of `
        + `admissions and the window is ${String(SUGGEST_ADMISSION.windowMs)} ms`,
    ).toBeLessThanOrEqual(SUGGEST_ADMISSION.windowMs);
    // …and it is not pointlessly small either: one more round would not fit.
    expect((rounds + 1) * SUGGEST_ADMISSION.perSenderBudgetMs)
      .toBeGreaterThan(SUGGEST_ADMISSION.windowMs);
    // Still under the 413 cap, which is a different bound and must stay the larger one.
    expect(SUGGEST_RECOMMENDED_PER_REQUEST).toBeLessThan(MAX_SUGGEST_SENDERS);
  });

  it("the deadline is the HOST'S, and a host that states none gets none", () => {
    /*
     * Three hosts compose this service and only ONE is killed by a platform. The serverless API
     * declares `maxDuration = 60`; the self-hosted server and the desktop's own engine declare
     * nothing and are ordinary processes, and the desktop's provider deliberately permits a sixty
     * second model call because a local model is slow. Applying the serverless window there would
     * refuse every sender after the first round, enforcing a ceiling that host does not have.
     *
     * This is the derivation itself, driven directly — the behavioural pair in
     * `screener-suggest-lanes.pg.test.ts` needs the gate occupied for longer than the window to
     * separate the two, which is not a wait a suite may take.
     */
    expect(
      admissionDeadline(undefined),
      "a host that states no ceiling was given the serverless one",
    ).toBe(Number.POSITIVE_INFINITY);

    const before = Date.now();
    const bounded = admissionDeadline(SUGGEST_ADMISSION.invocationMs);
    expect(bounded).toBeGreaterThanOrEqual(before + SUGGEST_ADMISSION.windowMs);
    expect(bounded).toBeLessThanOrEqual(Date.now() + SUGGEST_ADMISSION.windowMs);

    // A budget at or under the model's own ceiling admits NOTHING — clamped at zero rather than
    // going negative and reading as "already expired by an hour", which is the same answer but
    // arrived at by accident.
    expect(admissionDeadline(SUGGEST_ADMISSION.modelCallCeilingMs))
      .toBeLessThanOrEqual(Date.now());
    // Including a budget that only the SPEND call would exhaust.
    expect(admissionDeadline(
      SUGGEST_ADMISSION.modelCallCeilingMs + SUGGEST_ADMISSION.spendCallCeilingMs,
    )).toBeLessThanOrEqual(Date.now());
    expect(admissionDeadline(1)).toBeLessThanOrEqual(Date.now());
  });

  it("a HOST WITH NO CEILING waits instead of refusing — the window is not universal", async () => {
    /*
     * `ScreenerService` is composed by three hosts and only ONE of them is killed by a platform.
     * The self-hosted server and the standalone desktop's own engine are ordinary processes, and
     * the desktop's provider deliberately permits a SIXTY SECOND model call because a local model
     * on a laptop is slow. A serverless-sized window applied there would refuse every sender after
     * the first round — a deadline enforcing a ceiling that host does not have.
     *
     * `Infinity` is how "this host states no ceiling" reaches the gate, and it has to WAIT rather
     * than refuse. It must also wait without a timer: `setTimeout` refuses a non-finite delay —
     * it warns and fires on the next tick — which would turn "no deadline" into "every deadline
     * has already passed", the exact inversion this test exists to catch.
     */
    const g = new LaneGate(1);
    expect(await g.acquire(Number.POSITIVE_INFINITY)).toBe(true);

    let settled: boolean | null = null;
    const queued = g.acquire(Number.POSITIVE_INFINITY).then((ok) => { settled = ok; });
    // Long enough that a `setTimeout(fn, Infinity)` — which fires on the next tick — would have
    // resolved it false by now.
    await new Promise((r) => setTimeout(r, 80));
    expect(settled, "an unbounded wait was refused, or fired its own timer").toBeNull();

    g.release();
    await queued;
    expect(settled).toBe(true);
  });

  it("a held slot is genuinely held — the ceiling is not advisory", async () => {
    const g = new LaneGate(2);
    expect(await hold(g, 120)).toBe(true);
    expect(await hold(g, 120)).toBe(true);
    // Both slots are out; a third with a short deadline is refused…
    expect(await g.acquire(Date.now() + 30)).toBe(false);
    // …and a fourth with a deadline past the holders' release is admitted, which is what says the
    // refusal above was the ceiling and not a broken gate.
    expect(await g.acquire(Date.now() + 2_000)).toBe(true);
  });
});
