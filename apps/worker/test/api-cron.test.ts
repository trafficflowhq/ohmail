import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ALERT_THRESHOLDS } from "@trafficflow/db/cloud";
import {
  UNSUB_DRAIN_CEILING_MS, UNSUB_DRAIN_CLOSE_RESERVE_MS, UNSUB_DRAIN_RUN_BUDGET_MS,
} from "@trafficflow/core/mail";
import {
  API_CRON_CONTINUATIONS_PER_FIRE, API_CRON_JITTER_MS, API_CRON_TARGETS, startApiCron,
  type ApiCronDeps, type ApiCronTarget,
} from "../src/api-cron.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * THE WORKER-DRIVEN SCHEDULE FOR THE API'S INTERNAL PASSES — the properties that make it a
 * driver rather than a hope.
 *
 * The layer this replaces failed SILENTLY: vercel.json carried the cron entries for three
 * weeks of production deploys and `vercel crons ls` reported every one "not deployed" — no
 * error, no log line, no run. So the tests here are exactly the visibility properties that
 * were missing: a poke that authorizes the way the routes demand, a cadence that re-arms
 * itself after every outcome, a dead target that CANNOT read as healthy on `/health`, and an
 * overlap that cannot start a second in-flight request.
 *
 * Watched red (2026-08-22), one mutation per property:
 *  · failure recording no-op'd (`state.outcome = outcome` skipped on the failure arm) →
 *    "a dead target is visible" red: outcome stayed null and the streak stayed 0 while every
 *    poke failed — the exact silent-green this surface exists to forbid.
 *  · re-entry guard removed (`if (state.inFlight) return` deleted) → "overlap" red: two
 *    concurrent fetches of one route.
 *  · the tail re-arm made conditional on success (`if (outcome === "ok") arm(...)`) →
 *    red twice: the dead-target test's "a failed pass re-arms the chain" and the timeout
 *    test's re-arm assertion. A first attempt at this mutation (an extra `arm` + `return`
 *    inside the ok branch) changed nothing observable because failures still reached the
 *    tail `arm` — the suite stayed green and the green was CORRECT. Recorded because a
 *    mutation that cannot fail is not a watch.
 */

interface FakeTimer { fn: () => void; ms: number; cleared: boolean }

function makeTimers(): {
  scheduled: FakeTimer[];
  /** The most recently armed, un-cleared timer — after a pass settles, that is the re-arm. */
  latest: () => FakeTimer;
  deps: Pick<ApiCronDeps, "setTimer" | "clearTimer">;
} {
  const scheduled: FakeTimer[] = [];
  return {
    scheduled,
    latest: () => {
      const live = scheduled.filter((t) => !t.cleared);
      return live[live.length - 1]!;
    },
    deps: {
      setTimer: (fn, ms) => {
        const t: FakeTimer = { fn, ms, cleared: false };
        scheduled.push(t);
        return t as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (h) => { (h as unknown as FakeTimer).cleared = true; },
    },
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => { setImmediate(r); });
};

const TARGET: ApiCronTarget = {
  target: "sessions_reap",
  route: "/internal/sessions/reap",
  everyMs: 24 * 60 * 60 * 1000,
  firstDelayMs: 4 * 60 * 1000,
  timeoutMs: 60 * 1000,
};

type FetchCall = { url: string; method: string | undefined; auth: string | undefined };

/**
 * The double answers what a real `Response` answers: `text()` is what the driver reads, and a
 * double that only offered `arrayBuffer()` would have made the body-reading arm throw into the
 * `catch` and pass for reasons production does not have.
 */
function okResponse(status = 200, body = ""): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

describe("startApiCron", () => {
  it("pokes GET {base}{route} with the bearer secret, and records the success", async () => {
    const timers = makeTimers();
    const calls: FetchCall[] = [];
    const secret = "sdcret-sdcret-sdcret-sdcret-fixture-token";
    const cron = startApiCron({
      baseUrl: "https://api.example.test/", // trailing slash must be absorbed, not doubled
      secret,
      targets: [TARGET],
      random: () => 0,
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(url),
          method: init?.method,
          auth: (init?.headers as Record<string, string> | undefined)?.authorization,
        });
        return okResponse();
      }) as typeof fetch,
      ...timers.deps,
    });

    // Exactly one timer armed per target, at firstDelay (+ jitter, zeroed here).
    expect(timers.scheduled).toHaveLength(1);
    expect(timers.scheduled[0]!.ms).toBe(TARGET.firstDelayMs);

    timers.scheduled[0]!.fn();
    await settle();

    expect(calls).toEqual([{
      url: "https://api.example.test/internal/sessions/reap",
      method: "GET",
      auth: `Bearer ${secret}`,
    }]);

    const [h] = cron.health();
    expect(h!.outcome).toBe("ok");
    expect(h!.attempts).toBe(1);
    expect(h!.consecutiveFailures).toBe(0);
    expect(h!.lastOkAt).not.toBeNull();
    expect(h!.lastAttemptAt).not.toBeNull();

    // The chain re-armed itself for the next interval (jitter zeroed ⇒ exactly everyMs).
    const rearmed = timers.scheduled.filter((t) => !t.cleared);
    expect(rearmed).toHaveLength(2);
    expect(rearmed[1]!.ms).toBe(TARGET.everyMs);
    cron.stop();
  });

  it("a dead target is VISIBLE: failures set a closed outcome, grow the streak, and never touch lastOkAt", async () => {
    const timers = makeTimers();
    let status = 401;
    const cron = startApiCron({
      baseUrl: "https://api.example.test",
      secret: "x".repeat(24),
      targets: [TARGET],
      random: () => 0,
      fetchImpl: (async () => okResponse(status)) as typeof fetch,
      ...timers.deps,
    });

    timers.scheduled[0]!.fn();
    await settle();
    let [h] = cron.health();
    expect(h!.outcome).toBe("http_401");
    expect(h!.consecutiveFailures).toBe(1);
    expect(h!.lastOkAt).toBeNull();
    expect(h!.lastAttemptAt).not.toBeNull();
    // A failed pass re-arms the chain — a scheduler that only continues while healthy dies
    // on the first blip and then reads exactly like the platform layer this one replaced.
    expect(timers.scheduled.filter((x) => !x.cleared).some((x) => x.ms === TARGET.everyMs)).toBe(true);

    // The chain survives a failure: the next poke is armed, and a 503 grows the streak.
    status = 503;
    timers.latest().fn();
    await settle();
    [h] = cron.health();
    expect(h!.outcome).toBe("http_error");
    expect(h!.consecutiveFailures).toBe(2);
    expect(h!.lastOkAt).toBeNull();

    // 404 is its own name — an API host with no armed internal surface is a specific fix.
    status = 404;
    timers.latest().fn();
    await settle();
    [h] = cron.health();
    expect(h!.outcome).toBe("http_404");
    expect(h!.consecutiveFailures).toBe(3);

    // Recovery clears the streak and stamps lastOkAt.
    status = 200;
    timers.latest().fn();
    await settle();
    [h] = cron.health();
    expect(h!.outcome).toBe("ok");
    expect(h!.consecutiveFailures).toBe(0);
    expect(h!.lastOkAt).not.toBeNull();
    cron.stop();
  });

  it("never runs one route twice concurrently — a second fire while in flight is refused", async () => {
    const timers = makeTimers();
    let fetches = 0;
    const cron = startApiCron({
      baseUrl: "https://api.example.test",
      secret: "x".repeat(24),
      targets: [TARGET],
      random: () => 0,
      fetchImpl: (async () => {
        fetches += 1;
        return new Promise<Response>(() => { /* hangs — the pass never settles */ });
      }) as typeof fetch,
      ...timers.deps,
    });

    timers.scheduled[0]!.fn();
    await settle();
    // Simulate a double-armed timer (the interval-refactor mistake): fire the callback again.
    timers.scheduled[0]!.fn();
    await settle();
    expect(fetches).toBe(1);
    cron.stop();
  });

  it("a hung route is cut at timeoutMs and recorded as 'timeout'", async () => {
    const timers = makeTimers();
    const cron = startApiCron({
      baseUrl: "https://api.example.test",
      secret: "x".repeat(24),
      targets: [TARGET],
      random: () => 0,
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => { reject(new Error("aborted")); });
        })) as typeof fetch,
      ...timers.deps,
    });

    timers.scheduled[0]!.fn();
    await settle();
    // The abort timer is the second scheduled entry; firing it aborts the in-flight request.
    const abortTimer = timers.scheduled[1]!;
    expect(abortTimer.ms).toBe(TARGET.timeoutMs);
    abortTimer.fn();
    await settle();

    const [h] = cron.health();
    expect(h!.outcome).toBe("timeout");
    expect(h!.consecutiveFailures).toBe(1);
    // And the chain re-armed anyway — one hung pass must not kill the cadence.
    expect(timers.scheduled.filter((t) => !t.cleared).some((t) => t.ms === TARGET.everyMs)).toBe(true);
    cron.stop();
  });

  it("a fetch that throws is 'unreachable', never an exception out of the timer", async () => {
    const timers = makeTimers();
    const cron = startApiCron({
      baseUrl: "https://api.example.test",
      secret: "x".repeat(24),
      targets: [TARGET],
      random: () => 0,
      fetchImpl: (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as typeof fetch,
      ...timers.deps,
    });
    timers.scheduled[0]!.fn();
    await settle();
    const [h] = cron.health();
    expect(h!.outcome).toBe("unreachable");
    cron.stop();
  });

  it("stop() clears every armed timer and nothing re-arms after it", async () => {
    const timers = makeTimers();
    let fetches = 0;
    const cron = startApiCron({
      baseUrl: "https://api.example.test",
      secret: "x".repeat(24),
      targets: [TARGET],
      random: () => 0,
      fetchImpl: (async () => { fetches += 1; return okResponse(); }) as typeof fetch,
      ...timers.deps,
    });
    cron.stop();
    expect(timers.scheduled.every((t) => t.cleared)).toBe(true);
    // A timer that had already fired into the macrotask queue before stop() must do nothing.
    timers.scheduled[0]!.fn();
    await settle();
    expect(fetches).toBe(0);
    expect(cron.health()[0]!.attempts).toBe(0);
  });

  it("jitter is bounded and additive: waits land in [everyMs, everyMs + jitter)", async () => {
    const timers = makeTimers();
    const cron = startApiCron({
      baseUrl: "https://api.example.test",
      secret: "x".repeat(24),
      targets: [TARGET],
      random: () => 0.999,
      fetchImpl: (async () => okResponse()) as typeof fetch,
      ...timers.deps,
    });
    // First delay: firstDelayMs + up to 30 s of jitter.
    expect(timers.scheduled[0]!.ms).toBeGreaterThanOrEqual(TARGET.firstDelayMs);
    expect(timers.scheduled[0]!.ms).toBeLessThan(TARGET.firstDelayMs + 30 * 1000);
    timers.scheduled[0]!.fn();
    await settle();
    const rearmed = timers.scheduled.filter((t) => !t.cleared && t.ms >= TARGET.everyMs);
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0]!.ms).toBeLessThan(TARGET.everyMs + API_CRON_JITTER_MS);
    cron.stop();
  });

  it("the shipped table: seven targets, the alert route absent, and each cadence pinned", () => {
    // 4 → 5: `send_reconcile`, the reconciler for stranded send reservations. It is on this
    // table because a route that is built, tested and never poked is the failure this census
    // exists for — the pass would be green in every suite and would never run in production.
    //
    // 5 → 6: `away_responder` (mail 0087), and it is the sharpest instance of that same failure
    // yet — the pass it replaces lived in THIS app, whose platform blocks outbound SMTP
    // submission at the port level (`smtp-size.ts`), so it was green in every suite here and had
    // almost certainly never delivered a reply to anybody.
    //
    // 6 → 7: `billing_invoice_reconcile` (cloud 0029), the invoice mirror's daily heal. It is
    // APPENDED rather than placed beside the subscription reconciler it is a sibling of, and the
    // placement is this file's own arithmetic: the assertions below address targets by INDEX
    // by index, so inserting or REMOVING one in the middle silently re-pointed four cadence pins
    // at other people's targets — a green run asserting the wrong things. Three targets have
    // since been removed from the middle, and every pin below is addressed BY NAME because of
    // it. The table's order is not its schedule; every target carries its own `firstDelayMs`.
    //
    // 8 → 9: `platform_signals` (cloud 0030), the 5xx poll. APPENDED for the index reason above,
    // and it is the target this census matters most for: the pass measures whether the API host
    // is serving errors, so a poll that is built, tested and never poked would leave a rule that
    // can never fire — coverage on paper, silence in production, on the one question an operator
    // would most want asked.
    //
    // 9 → 10: `unsubscribe_drain`. APPENDED for the index reason above,
    // and it is this census's own sentence again: the drain was built and tested and poked by
    // nobody, so a cap on the Screener's in-request fan-out would have converted an over-long
    // request into silently unfinished work.
    //
    // 10 → 11: `account_lifecycle` (cloud 0040, the wall). APPENDED for the index reason above.
    // The census's sentence a third time: the reminder mails and the erasure run only when this
    // clock pokes them, and a pass poked by nobody leaves closed accounts un-noticed for ever
    // and retention promises that never execute.
    expect(API_CRON_TARGETS.map((t) => t.target))
      .toEqual([ "sessions_reap", "smtp_size", "scheduled_send",
        "send_reconcile", "away_responder", "platform_signals", "unsubscribe_drain",
        "account_lifecycle", "security_notices", "sent_copies",
      ]);
    /* ADDRESSED BY NAME FROM HERE DOWN, and the change is the lesson: three targets left the
     * MIDDLE of this table, and every `API_CRON_TARGETS[n]` below then pointed at somebody
     * else's target while staying green — a cadence pin asserting the wrong thing. */
    const byName = (n: string): ApiCronTarget => {
      const t = API_CRON_TARGETS.find((x) => x.target === n);
      if (!t) throw new Error(`the table has no ${n} target`);
      return t;
    };
    // The two DAILIES, by name: the session reaper and the SMTP-size probe. The hourly
    // reconciler that used to head this table left with the reconciler.
    // 11 → 12, APPENDED: `security_notices`. A notice a locked sign-in owes and nobody sends is a
    // promise on paper. Every five minutes, the jitter a tenth of that, the route its door's.
    expect(byName("security_notices")).toMatchObject({
      route: "/internal/security-notices/run", everyMs: 5 * 60 * 1000, jitterMs: 30 * 1000,
    });
    // 12 → 13, APPENDED: `sent_copies`, the late pass for owed Sent copies; its rows wait days, so
    // five minutes, and its body's `remaining` reaches the health row.
    expect(byName("sent_copies")).toMatchObject({
      route: "/internal/sends/sent-copies/run", everyMs: 5 * 60 * 1000, jitterMs: 30 * 1000,
      firstDelayMs: 2 * 60 * 1000, timeoutMs: 60 * 1000, readsRemaining: true,
    });
    for (const n of ["sessions_reap", "smtp_size"]) {
      expect(byName(n).everyMs, `${n} is daily`).toBe(24 * 60 * 60 * 1000);
      // One interval plus jitter must stay inside a day, or the clock would drift a poke.
      expect(byName(n).everyMs + API_CRON_JITTER_MS).toBeLessThan(25 * 60 * 60 * 1000);
    }
    // SEND LATER's clock (mail 0077): the appointment's stated precision is "±about a minute",
    // so the poke interval PLUS its jitter must stay near a minute — the default 5-minute
    // jitter over a 60-second cadence would make the promise a sentence the arithmetic
    // contradicts, which is why the per-target `jitterMs` override exists at all.
    const scheduled = byName("scheduled_send");
    expect(scheduled.everyMs).toBe(60 * 1000);
    expect(scheduled.jitterMs).toBeDefined();
    expect(scheduled.everyMs + scheduled.jitterMs!).toBeLessThanOrEqual(90 * 1000);
    // The reconciler's cadence is what the stuck-send alarm's threshold is written against, and
    // this is that sentence as arithmetic rather than as a comment: a reservation becomes
    // eligible at `SEND_STALE_AFTER_MS` and the alarm fires at `stuckSendMs`, so the window
    // between them must hold at least two full cycles of THIS clock, or a healthy reconciliation
    // pages a human every time it takes one extra minute.
    //
    // `SEND_STALE_AFTER_MS` IS A LITERAL HERE, and that is the module boundary rather than
    // laziness: it lives in the services package, which this app may not import — and
    // `deps.test.ts` fails any test file that so much as NAMES that package (it matches on the
    // file's text, which is why this paragraph does not spell it either), because such an import
    // creeping into the worker is the measured Node-23 boot crash. So the claim is split, not
    // weakened: the other half is `packages/services/test/send-reconcile.test.ts`, which pins
    // the constant to this same ten minutes against the shipped code. Changing it turns THAT
    // test red, and its failure names this one.
    const STALE_AFTER_MS = 10 * 60 * 1000;
    const reconciler = byName("send_reconcile");
    expect(reconciler.route).toBe("/internal/sends/reconcile/run");
    expect(reconciler.everyMs).toBe(60 * 1000);
    expect(reconciler.jitterMs).toBeDefined();
    expect(reconciler.everyMs + reconciler.jitterMs!).toBeLessThanOrEqual(90 * 1000);
    expect(DEFAULT_ALERT_THRESHOLDS.stuckSendMs)
      .toBeGreaterThanOrEqual(STALE_AFTER_MS + 2 * (reconciler.everyMs + reconciler.jitterMs!));
    // The away responder holds the same line for the same reason: "away" is a promise about mail
    // that has just arrived, so a coarse cadence would make the reply's delay visible to whoever
    // wrote. Both minute-clocks therefore need the per-target jitter override, not the 5-minute
    // default — which over a 60-second cadence is a schedule made mostly of jitter.
    const away = byName("away_responder");   // index 5: the reconciler took 4 when its own pass landed first
    expect(away.route).toBe("/internal/away/run");
    expect(away.everyMs).toBe(60 * 1000);
    expect(away.jitterMs).toBeDefined();
    expect(away.everyMs + away.jitterMs!).toBeLessThanOrEqual(90 * 1000);
    // It must NOT share the sender clock's first delay: two SMTP-dialling invocations landing on
    // the same host at the same instant on every leader takeover is what the stagger prevents, and
    // these are the two targets that dial.
    expect(away.firstDelayMs).not.toBe(scheduled.firstDelayMs);
    // The worker must never drive the alert pass over HTTP — it runs it in-process, and the
    // route's job includes reporting THIS process's death, which a dead process cannot poke for.
    for (const t of API_CRON_TARGETS) expect(t.route).not.toBe("/internal/alerts/run");
    // Staggered first delays: no two targets land their first poke together.
    const delays = API_CRON_TARGETS.map((t) => t.firstDelayMs);
    expect(new Set(delays).size).toBe(delays.length);
  });
});

/**
 * CONTROL 4 for `UNSUBSCRIBE-DRAIN-NEVER-SUCCEEDED-IN-PRODUCTION`. The pass answered `timeout`
 * twice in production with `lastOkAt` null, and one unsubscribe HAD been delivered inside the
 * killed invocation — a flat outcome cannot tell that from "did nothing". The row now carries
 * what the pass says is still owed.
 *
 * Watched red 2026-09-14, one mutation per property, each restored by copying the pristine file
 * back and proved by `cmp`:
 *  · `state.remaining = n` skipped in the ok arm → the first case red, `null` where 7 was sent.
 *  · `readsRemaining` dropped from the SHIPPED table entry → 1 failed / 3 passed: the last case
 *    red and the first three green, because they drive their own target — the pair that tells
 *    "the mechanism works" apart from "the mechanism is wired to the pass that needs it".
 *  · `readRemaining`'s integer check loosened to `typeof n !== "number"` → the hostile-body case
 *    red at `{"remaining":-1}`, which the row would otherwise have published as a backlog.
 */
describe("the health row carries what a pass says is still owed", () => {
  const DRAIN: ApiCronTarget = {
    target: "unsubscribe_drain",
    route: "/internal/unsubscribe/drain",
    everyMs: 60 * 60 * 1000,
    firstDelayMs: 9 * 60 * 1000,
    timeoutMs: 60 * 1000,
    readsRemaining: true,
  };

  function driveWith(bodies: string[], target: ApiCronTarget = DRAIN): {
    timers: ReturnType<typeof makeTimers>; cron: ReturnType<typeof startApiCron>;
  } {
    const timers = makeTimers();
    let i = 0;
    const cron = startApiCron({
      baseUrl: "https://api.example.test",
      secret: "sdcret-sdcret-sdcret-sdcret-fixture-token",
      targets: [target],
      random: () => 0,
      fetchImpl: (async () => okResponse(200, bodies[Math.min(i++, bodies.length - 1)]!)) as typeof fetch,
      ...timers.deps,
    });
    return { timers, cron };
  }

  it("reads remaining > 0 while the backlog exists and 0 after — and null before any answer", async () => {
    const { timers, cron } = driveWith([
      JSON.stringify({ now: "2026-09-14T14:00:00Z", accounts: 2, claimed: 10, delivered: 9, skipped: 0, failed: 1, remaining: 7, elapsedMs: 812 }),
      JSON.stringify({ now: "2026-09-14T15:00:00Z", accounts: 1, claimed: 7, delivered: 7, skipped: 0, failed: 0, remaining: 0, elapsedMs: 604 }),
    ]);
    // Before the first poke the row says NOTHING, which is not the same as nothing left.
    expect(cron.health()[0]!.remaining).toBeNull();

    timers.latest().fn();
    await settle();
    expect(cron.health()[0]!.outcome).toBe("ok");
    expect(cron.health()[0]!.remaining).toBe(7);

    timers.latest().fn();
    await settle();
    expect(cron.health()[0]!.remaining).toBe(0);
    cron.stop();
  });

  it("a target that does not declare it answers null for ever — the field is opt-in, not a default", async () => {
    const { timers, cron } = driveWith(
      [JSON.stringify({ remaining: 7 })],
      { ...DRAIN, readsRemaining: undefined },
    );
    timers.latest().fn();
    await settle();
    expect(cron.health()[0]!.outcome).toBe("ok");
    expect(cron.health()[0]!.remaining).toBeNull();
    cron.stop();
  });

  it("a body it cannot believe leaves the last reading standing rather than writing a lie", async () => {
    for (const hostile of ["", "not json", "[]", "null", '{"remaining":"7"}', '{"remaining":-1}', '{"remaining":1.5}', "{}"]) {
      const { timers, cron } = driveWith([JSON.stringify({ remaining: 4 }), hostile]);
      timers.latest().fn();
      await settle();
      expect(cron.health()[0]!.remaining, `first read for ${JSON.stringify(hostile)}`).toBe(4);
      timers.latest().fn();
      await settle();
      // NOT null, and NOT the hostile value: the previous honest answer is the last thing known.
      expect(cron.health()[0]!.remaining, `after ${JSON.stringify(hostile)}`).toBe(4);
      cron.stop();
    }
  });

  it("an EXPLICIT null is the pass saying it did not measure — and it replaces the last number", async () => {
    // THREE STATES, NOT TWO. A number is a count; an explicit null is "this run did not reach the
    // end of its window"; an unbelievable body is neither and leaves the last reading standing.
    // Collapsing the first two would leave a small stale number on the row for as long as the
    // pass stayed unable to look, which reads exactly like a pass that is keeping up.
    const { timers, cron } = driveWith([
      JSON.stringify({ remaining: 4 }),
      JSON.stringify({ remaining: null }),
    ]);
    timers.latest().fn();
    await settle();
    expect(cron.health()[0]!.remaining).toBe(4);
    timers.latest().fn();
    await settle();
    expect(cron.health()[0]!.remaining, "an explicit null is an answer, not a bad body").toBeNull();
    cron.stop();
  });

  it("the SHIPPED drain target reads it, and the caller's timeout is the shared ceiling", () => {
    const drain = API_CRON_TARGETS.find((t) => t.target === "unsubscribe_drain")!;
    expect(drain.readsRemaining).toBe(true);
    expect(drain.timeoutMs).toBe(UNSUB_DRAIN_CEILING_MS);
    // The route's own budget plus its closing reserve must fit inside the ceiling with room to
    // spare — the pair used to be 60 s here and 45 s there, and the run spent 53 s before its own
    // clock started. A budget at or over the ceiling is the shape that shipped.
    expect(UNSUB_DRAIN_RUN_BUDGET_MS + UNSUB_DRAIN_CLOSE_RESERVE_MS).toBeLessThan(UNSUB_DRAIN_CEILING_MS);
    // No second copy of the number in the caller's own file.
    expect(readFileSync(resolve(__dirname, "../src/api-cron.ts"), "utf8"))
      .toContain("timeoutMs: UNSUB_DRAIN_CEILING_MS");
  });
});

// the driver's half: a sweep answering `next` is poked again with `?after=` at once, at most
// API_CRON_CONTINUATIONS_PER_FIRE times per fire; each id in `erasureDue` is erased one call at a
// time, and an API that 404s the door is said at ERROR per account.
describe("the lifecycle sweep's continuation and its erasures", () => {
  const LIFECYCLE = API_CRON_TARGETS.find((t) => t.target === "account_lifecycle")!;
  const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  function drive(answer: (url: string) => Response): {
    urls: string[]; lines: Array<{ level: string; event: string }>; fire: () => Promise<void>;
    cron: ReturnType<typeof startApiCron>;
  } {
    const timers = makeTimers();
    const urls: string[] = [];
    const lines: Array<{ level: string; event: string }> = [];
    const at = (level: string) => (event: string) => { lines.push({ level, event }); };
    const log = { level: "info", child: () => log, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
    const cron = startApiCron({
      baseUrl: "https://api.example.test", secret: "sdcret-sdcret-sdcret-sdcret-fixture-token",
      targets: [LIFECYCLE], random: () => 0, log: log as unknown as ApiCronDeps["log"],
      fetchImpl: (async (url: RequestInfo | URL) => { urls.push(String(url)); return answer(String(url)); }) as typeof fetch,
      ...timers.deps,
    });
    return { urls, lines, cron, fire: async () => { timers.latest().fn(); for (let i = 0; i < 60; i++) await settle(); } };
  }

  it("the shipped target continues, erases through its door, and waits no longer than the platform", () => {
    expect(LIFECYCLE.continues?.eraseRoute).toBe("/internal/account-lifecycle/erase");
    expect(LIFECYCLE.timeoutMs).toBe(60 * 1000);
  });

  it("goes on with ?after= until the sweep answers next: null, then erases each named account", async () => {
    let page = 0;
    const { urls, fire, cron } = drive((url) => {
      if (url.includes("/erase?")) return okResponse(200, JSON.stringify({ outcome: "erased" }));
      page += 1;
      return okResponse(200, JSON.stringify({ next: page < 3 ? id(page) : null, erasureDue: [id(100 + page)] }));
    });
    await fire();
    expect(urls.map((u) => u.replace("https://api.example.test", ""))).toEqual([
      "/internal/account-lifecycle/run",
      `/internal/account-lifecycle/run?after=${id(1)}`,
      `/internal/account-lifecycle/run?after=${id(2)}`,
      `/internal/account-lifecycle/erase?account=${id(101)}`,
      `/internal/account-lifecycle/erase?account=${id(102)}`,
      `/internal/account-lifecycle/erase?account=${id(103)}`,
    ]);
    expect(cron.health()[0]!.outcome).toBe("ok");
    cron.stop();
  });

  it("stops following a sweep that never ends at the cap, and says so", async () => {
    let page = 0;
    const { urls, lines, fire, cron } = drive(() => okResponse(200, JSON.stringify({ next: id(++page), erasureDue: [] })));
    await fire();
    expect(urls.filter((u) => u.includes("/run")).length, "the continuation ran past its cap")
      .toBe(1 + API_CRON_CONTINUATIONS_PER_FIRE);
    expect(lines.some((l) => l.event === "api_cron_continuation_capped")).toBe(true);
    cron.stop();
  });

  it("an API without the door answers 404, said at ERROR for each account it owes", async () => {
    const { lines, fire, cron } = drive((url) => url.includes("/erase?")
      ? okResponse(404, "") : okResponse(200, JSON.stringify({ next: null, erasureDue: [id(7), id(8)] })));
    await fire();
    expect(lines.filter((l) => l.event === "api_cron_erase_failed" && l.level === "error")).toHaveLength(2);
    cron.stop();
  });

  it("an older API's answer — no next, no erasureDue — is one poke and nothing else", async () => {
    const { urls, fire, cron } = drive(() => okResponse(200, JSON.stringify({ accounts: 3, erased: 0 })));
    await fire();
    expect(urls).toHaveLength(1);
    cron.stop();
  });
});
