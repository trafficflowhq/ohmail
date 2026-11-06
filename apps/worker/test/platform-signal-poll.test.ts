import { describe, it, expect, vi } from "vitest";
import { createLogger } from "@trafficflow/core";
import type { Tx } from "@trafficflow/db";
import {
  DEFAULT_ALERT_THRESHOLDS, evaluateAlerts, platformSignals, platformSignalWindow, SIGNAL_PAGE_BUDGET, SIGNAL_SETTLE_MS,
  SIGNAL_WALL_CLOCK_MS,
} from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { DEFAULT_ALERT_INTERVAL_MS } from "../src/config.js";
import {
  nextSignalPollAt, startPlatformSignalPoll, SIGNAL_POLL_EVERY_MS, SIGNAL_POLL_JITTER_MS, SIGNAL_POLL_OFFSET_MS,
  SIGNAL_POLL_PAGE_BUDGET, SIGNAL_POLL_WALL_CLOCK_MS, type PlatformSignalPollDeps,
} from "../src/platform-signal-poll.js";

/**
 * THE 5xx POLL ON THE WORKER, with its own credential (`TF_SIGNAL_*`). The pass itself is
 * `packages/services/test/platform-signals.test.ts`'s; this is the clock around it: the bucket grid
 * it fires on, the bearer it sends, what a refusal leaves on health and in the log, and the stop.
 * Every timer here fires on a virtual clock, at the time the test sets.
 */

const TOKEN = ["worker", "signal", "fixture", "value"].join("-");
const TEAM = ["team", "fixture"].join("_");
const MIN = 60_000;
/** A bucket close on the five-minute grid. */
const CLOSE = Date.parse("2026-10-25T12:05:00.000Z");

interface Armed { fn: () => Promise<void>; at: number; done: boolean }

/** A seeded uniform source in [0, 1), so a long run covers the jitter range the same way every time. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function harness(opts: {
  startMs: number; status?: number; random?: () => number;
  /** Virtual time one platform request takes. */
  requestMs?: number;
  onLogPage?: () => void;
  /** Every log page says there is more, one row older than the cursor. */
  endless?: boolean;
}) {
  const clock = { ms: opts.startMs };
  const timers: Armed[] = [];
  const bearers: string[] = [];
  /** Every request-log read: the window it asked for and the virtual time it was asked. */
  const reads: Array<{ start: number; at: number }> = [];
  const lines: string[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    bearers.push(new Headers(init?.headers).get("authorization") ?? "");
    const at = clock.ms;
    clock.ms += opts.requestMs ?? 0;
    if ((opts.status ?? 200) !== 200) return new Response("{}", { status: opts.status });
    if (String(url).includes("/v9/projects/")) return new Response(JSON.stringify({ id: "prj_fixture" }));
    const start = Number(new URL(String(url)).searchParams.get("startDate"));
    reads.push({ start, at });
    opts.onLogPage?.();
    if (opts.endless) {
      const end = Number(new URL(String(url)).searchParams.get("endDate"));
      return new Response(JSON.stringify({
        rows: [{ requestId: `r${end}`, statusCode: 200, timestamp: new Date(end - 1000).toISOString(), environment: "production" }],
        hasMoreRows: true,
      }));
    }
    return new Response(JSON.stringify({
      rows: [{ requestId: `r${start}`, statusCode: 200, timestamp: new Date(start + 1000).toISOString(), environment: "production" }],
      hasMoreRows: false,
    }));
  }) as typeof fetch;
  const start = async (
    env: PlatformSignalPollDeps["signals"]["env"] = { VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: TEAM },
    given?: Tx,
  ) => {
    const db = given ?? (await makeTestDb()) as unknown as Tx;
    const poll = startPlatformSignalPoll({
      db,
      signals: { env, deliberate: [], fetchImpl },
      log: createLogger({ service: "worker", level: "debug", sink: (l) => lines.push(l) }),
      seams: {
        now: () => new Date(clock.ms), random: opts.random ?? (() => 0),
        setTimer: (fn, ms) => { const t = { fn, at: clock.ms + ms, done: false }; timers.push(t); return t as never; },
        clearTimer: (h) => { (h as unknown as Armed).done = true; },
      },
    });
    return { db, poll };
  };
  /** The one armed timer, or null. */
  const pending = (): Armed | null => timers.filter((t) => !t.done).at(-1) ?? null;
  /** Fire the armed timer at its due time, or at `at`; resolves when its run has finished. */
  const fire = async (at?: number): Promise<void> => {
    const t = pending()!;
    t.done = true;
    clock.ms = at ?? Math.max(clock.ms, t.at);
    await t.fn();
  };
  const events = (name: string) => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === name);
  return { clock, timers, bearers, reads, lines, start, pending, fire, events };
}

describe("nextSignalPollAt — the bucket grid", () => {
  it("fires after now, 100 to 130 s after a bucket closed, at most one cadence and its jitter away", () => {
    for (let phase = 0; phase < SIGNAL_POLL_EVERY_MS; phase += 1000) {
      for (const now of [CLOSE + phase, CLOSE + phase + 999]) {
        for (const jitter of [0, 0.999_999]) {
          const at = nextSignalPollAt(now, jitter);
          const sinceClose = ((at % SIGNAL_POLL_EVERY_MS) + SIGNAL_POLL_EVERY_MS) % SIGNAL_POLL_EVERY_MS;
          expect(at, `phase ${phase}`).toBeGreaterThan(now);
          expect(sinceClose, `phase ${phase}`).toBeGreaterThanOrEqual(100_000);
          expect(sinceClose, `phase ${phase}`).toBeLessThan(130_000);
          expect(at - now, `phase ${phase}`).toBeLessThanOrEqual(SIGNAL_POLL_EVERY_MS + SIGNAL_POLL_JITTER_MS);
          expect(at - now, `phase ${phase}`).toBeLessThanOrEqual(7 * MIN + 10_000);
        }
      }
    }
  });

  it("leaves every window two alert passes after its slowest read", () => {
    // Past the settle margin, so a read is complete; the latest fire plus a whole pass plus two alert
    // intervals inside one cadence, so each fifteen-minute window is judged at least twice.
    expect(SIGNAL_POLL_OFFSET_MS).toBeGreaterThan(SIGNAL_SETTLE_MS);
    expect(SIGNAL_POLL_OFFSET_MS + SIGNAL_POLL_JITTER_MS + SIGNAL_POLL_WALL_CLOCK_MS + 2 * DEFAULT_ALERT_INTERVAL_MS)
      .toBeLessThanOrEqual(SIGNAL_POLL_EVERY_MS);
  });
});

describe("startPlatformSignalPoll", () => {
  it("six hours on the grid: every window read once, after it settled, complete, and judged at least twice", async () => {
    // 89 s after a close: inside the settle margin, where a clock that drifts reads a bucket too early.
    const h = harness({ startMs: CLOSE + 89_000, requestMs: 3_000, random: seeded(7) });
    const { db, poll } = await h.start();
    const end = CLOSE + 89_000 + 6 * 60 * MIN;
    const judged = new Map<number, number>();
    let settleSamples = 0;
    for (let minute = h.clock.ms + MIN; minute <= end; minute += MIN) {
      for (let t = h.pending(); t !== null && t.at <= minute; t = h.pending()) {
        await h.fire();
        settleSamples += (await db.select().from(platformSignals)).filter((r) => r.sampleCause === "settle_margin").length;
      }
      h.clock.ms = Math.max(h.clock.ms, minute);
      const [w] = await platformSignalWindow(db, new Date(h.clock.ms), DEFAULT_ALERT_THRESHOLDS.api5xxWindowMs);
      const bucketEnd = Math.floor(h.clock.ms / SIGNAL_POLL_EVERY_MS) * SIGNAL_POLL_EVERY_MS;
      if (w !== undefined && w.completeBuckets >= 3) judged.set(bucketEnd, (judged.get(bucketEnd) ?? 0) + 1);
    }
    poll.stop();

    const early = h.reads.filter((r) => r.at < r.start + SIGNAL_POLL_EVERY_MS + SIGNAL_SETTLE_MS);
    expect(early.map((r) => new Date(r.start).toISOString()), "a window read before it settled").toEqual([]);
    const perWindow = new Map<number, number>();
    for (const r of h.reads) perWindow.set(r.start, (perWindow.get(r.start) ?? 0) + 1);
    expect([...perWindow].filter(([, n]) => n !== 1).map(([s]) => new Date(s).toISOString()), "read twice").toEqual([]);
    const rows = await db.select().from(platformSignals);
    expect(rows.length).toBe(perWindow.size);
    expect(rows.filter((r) => r.truncated).map((r) => r.sampleCause), "a bucket left a sample").toEqual([]);
    expect(settleSamples).toBe(0);
    const windows: number[] = [];
    for (let b = CLOSE; b + SIGNAL_POLL_EVERY_MS <= end; b += SIGNAL_POLL_EVERY_MS) windows.push(b);
    expect(windows.length).toBe(72);
    expect(windows.filter((b) => (judged.get(b) ?? 0) < 2).map((b) => new Date(b).toISOString()), "judged under twice")
      .toEqual([]);
  });

  it("runs at its grid slot, writes the closed windows with the worker's bearer, and re-arms on the grid", async () => {
    const h = harness({ startMs: Date.parse("2026-10-25T12:07:31.000Z") });
    const { db, poll } = await h.start();
    // The 12:10 bucket's close plus the offset; no jitter from this random source.
    expect(h.pending()!.at).toBe(Date.parse("2026-10-25T12:11:40.000Z"));
    await h.fire();
    expect((await db.select().from(platformSignals)).length).toBe(3);
    expect(new Set(h.bearers)).toEqual(new Set([`Bearer ${TOKEN}`]));
    expect(poll.health()).toEqual({
      target: "platform_signals", everySeconds: 300, lastOkAt: "2026-10-25T12:11:40.000Z", outcome: "ok", consecutiveFailures: 0,
    });
    expect(h.events("platform_signal_pass")[0]).toMatchObject({ level: "info", outcome: "written", rows: 3, deferred: 0 });
    expect(h.pending()!.at).toBe(Date.parse("2026-10-25T12:16:40.000Z"));
    poll.stop();
  });

  it("a timer that fires early (the wall clock stepped back) reads nothing and re-arms for the rest", async () => {
    const h = harness({ startMs: CLOSE + 151_000 });
    const { poll } = await h.start();
    const due = h.pending()!.at;
    await h.fire(due - MIN);
    expect(h.bearers).toEqual([]);
    expect(h.pending()!.at).toBe(due);
    expect(poll.health().outcome).toBeNull();
    await h.fire();
    expect(h.bearers.length).toBeGreaterThan(0);
    expect(poll.health().outcome).toBe("ok");
    poll.stop();
  });

  it("a refusal is health 'failed' and a code in the log, never the token; the third in a row is an error", async () => {
    const h = harness({ startMs: CLOSE + 151_000, status: 403 });
    const { db, poll } = await h.start();
    await h.fire();
    expect(poll.health()).toMatchObject({ outcome: "failed", consecutiveFailures: 1, lastOkAt: null });
    expect(h.events("platform_signal_pass")[0]).toMatchObject({ level: "warn", outcome: "failed", code: "project_http_403" });
    await h.fire();
    await h.fire();
    expect(h.events("platform_signal_pass").map((l) => l.level)).toEqual(["warn", "warn", "error"]);
    expect(h.lines.join("\n")).not.toContain(TOKEN);
    expect(await db.select().from(platformSignals)).toEqual([]);
    poll.stop();
  });

  it("half a pair is said once by name, asks the platform nothing, never counts as ok and pages", async () => {
    const h = harness({ startMs: CLOSE + 151_000 });
    const { poll } = await h.start({ VERCEL_TOKEN: TOKEN });
    await h.fire();
    expect(h.events("platform_signal_config_incomplete").map((l) => l.configVar)).toEqual(["TF_SIGNAL_VERCEL_TEAM_ID"]);
    expect(h.bearers).toEqual([]);
    expect(poll.health()).toMatchObject({ outcome: "failed", consecutiveFailures: 1, lastOkAt: null });
    expect(h.events("platform_signal_pass")[0]).toMatchObject({ level: "warn", outcome: "unconfigured", code: "config_incomplete" });
    await h.fire();
    await h.fire();
    expect(h.events("platform_signal_pass").map((l) => l.level)).toEqual(["warn", "warn", "error"]);
    // Past the stale floor: a stamped lastOkAt kept api_cron_stale clear for good.
    const alerts = await evaluateAlerts(await makeTestDb(), {
      now: new Date(poll.since().getTime() + 16 * MIN), driver: "worker",
      apiCron: { since: poll.since(), targets: [{ ...poll.health(), inProcess: true }] },
    });
    expect(alerts.map((a) => a.key)).toContain("api_cron_stale:platform_signals");
    poll.stop();
  });

  it("half a pair is not ok even when every bucket it would read is already held", async () => {
    const h = harness({ startMs: CLOSE + 151_000 });
    const db = (await makeTestDb()) as unknown as Tx;
    for (const start of [CLOSE, CLOSE - SIGNAL_POLL_EVERY_MS, CLOSE - 2 * SIGNAL_POLL_EVERY_MS]) {
      await db.insert(platformSignals).values({
        provider: "vercel", project: "ohmail-api", windowStart: new Date(start),
        requests: 5, errors5xx: 0, truncated: false, fetchedAt: new Date(CLOSE),
      });
    }
    const { poll } = await h.start({ VERCEL_TEAM_ID: TEAM }, db);
    await h.fire();
    expect(h.events("platform_signal_pass")[0]).toMatchObject({ outcome: "written", rows: 0, code: "config_incomplete" });
    expect(poll.health()).toMatchObject({ outcome: "failed", lastOkAt: null });
    poll.stop();
  });

  it("walks the worker's page budget, not the API host's twelve", async () => {
    const h = harness({ startMs: CLOSE + 151_000, endless: true });
    const { db, poll } = await h.start({ VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: TEAM, VERCEL_SIGNAL_PROJECTS: "ohmail-api" });
    await h.fire();
    const newest = Math.max(...h.reads.map((r) => r.start));
    expect(h.reads.filter((r) => r.start === newest)).toHaveLength(SIGNAL_POLL_PAGE_BUDGET);
    expect(SIGNAL_POLL_PAGE_BUDGET).toBeGreaterThan(SIGNAL_PAGE_BUDGET);
    expect((await db.select().from(platformSignals)).map((r) => r.sampleCause)).toEqual(["page_budget", "page_budget", "page_budget"]);
    poll.stop();
  });

  it("stop() disarms the clock: a timer that fires anyway runs nothing", async () => {
    const h = harness({ startMs: CLOSE + 151_000 });
    const { poll } = await h.start();
    poll.stop();
    expect(h.timers.every((t) => t.done)).toBe(true);
    await h.timers[0]!.fn();
    expect(h.bearers).toEqual([]);
    expect(h.timers).toHaveLength(1);
    expect(poll.health().outcome).toBeNull();
  });

  it("rows, then the pass's own deadline: the rest is deferred, health stays ok and the log line counts them", async () => {
    const db = (await makeTestDb()) as unknown as Tx;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // The first log page spends the pass's whole wall clock: the two older buckets are the next pass's.
      const h = harness({ startMs: CLOSE + 151_000, onLogPage: () => { vi.setSystemTime(Date.now() + SIGNAL_POLL_WALL_CLOCK_MS + 1000); } });
      const { poll } = await h.start(undefined, db);
      await h.fire();
      expect(poll.health()).toMatchObject({ outcome: "ok", consecutiveFailures: 0 });
      expect(h.events("platform_signal_pass")[0]).toMatchObject({ level: "info", outcome: "written", rows: 1, deferred: 2 });
      expect(await db.select().from(platformSignals)).toHaveLength(1);
      poll.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the pass runs on the worker's wall clock: a first page past the API host's 40 s defers nothing", async () => {
    const db = (await makeTestDb()) as unknown as Tx;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let first = true;
      const h = harness({ startMs: CLOSE + 151_000, onLogPage: () => {
        if (first) vi.setSystemTime(Date.now() + SIGNAL_WALL_CLOCK_MS + 1000);
        first = false;
      } });
      const { poll } = await h.start(undefined, db);
      await h.fire();
      expect(SIGNAL_POLL_WALL_CLOCK_MS).toBeGreaterThan(SIGNAL_WALL_CLOCK_MS + 1000);
      expect(h.events("platform_signal_pass")[0]).toMatchObject({ outcome: "written", rows: 3, deferred: 0 });
      poll.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a database that refuses the pass is health 'error', and the clock keeps running", async () => {
    const h = harness({ startMs: CLOSE + 151_000 });
    const refusing = { select: () => { throw new Error("permission denied for table platform_signals"); } } as unknown as Tx;
    const { poll } = await h.start(undefined, refusing);
    await h.fire();
    expect(poll.health()).toMatchObject({ outcome: "error", consecutiveFailures: 1, lastOkAt: null });
    expect(h.events("platform_signal_pass_failed").map((l) => l.level)).toEqual(["error"]);
    expect(h.pending(), "a refused pass keeps the clock").not.toBeNull();
    poll.stop();
  });
});
