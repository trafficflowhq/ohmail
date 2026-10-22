// @services: none — its Postgres URL is never dialed
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiAlertSinkSummary } from "@trafficflow/api";
import { createLogger, type Logger } from "@trafficflow/core";
import type { Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { loadServerConfig, type ServerConfig } from "../src/config.js";
import { alertSinksFor, buildDeps, type ServerRuntime } from "../src/deps.js";
import { handleServerRequest } from "../src/handler.js";
import {
  alertClockFor, startAlertClock, ALERT_PASS_EVERY_MS, ALERT_PASS_FIRST_DELAY_MS,
} from "../src/alert-clock.js";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";

/**
 * THE SELF-HOST API ALERT ARM'S CLOCK. Nothing outside this process schedules the API alert pass
 * on a self-hosted server, and that pass is the only observer of `worker_down`: without a clock
 * here a dead organizer pages nobody. The clock is the send clock's shape — settle, then re-arm,
 * never `setInterval` — and has its own chain, so a stalled sender cannot delay a page.
 */

const EVERY = 60_000;
const FIRST = 30_000;
const SECRET = "a".repeat(32);

const BASE = {
  OHMAIL_ORIGIN: "https://mail.example.com",
  DATABASE_URL: "postgres://tf:tf@localhost:5433/never_dialed",
  [KEY_RING_V1]: "ab".repeat(32),
};
const cfgWith = (extra: Record<string, string>): ServerConfig =>
  loadServerConfig({ ...BASE, ...extra } as NodeJS.ProcessEnv);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function errorsLog(): { errors: string[]; log: Pick<Logger, "error"> } {
  const errors: string[] = [];
  return { errors, log: { error: (event: string) => { errors.push(event); } } };
}

/** The runtime index.ts composes, over a test handle; `db` absent leaves the pass no handle. */
function runtime(cfg: ServerConfig, logger: Logger, db?: unknown): ServerRuntime {
  const handle = (db ?? {}) as never;
  return {
    cfg, db: handle, services: {} as never, changeWake: null, oauth: {} as never,
    onSetupTokenMinted: () => {}, logger,
    alertSinks: alertSinksFor(cfg, logger, handle),
    alertDb: db ? () => Promise.resolve(db as unknown as Tx) : null,
  };
}

function captured(): { lines: Array<Record<string, unknown>>; logger: Logger } {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    service: "server", level: "debug", sink: (l) => { lines.push(JSON.parse(l) as Record<string, unknown>); },
  });
  return { lines, logger };
}

describe("startAlertClock — settle, then re-arm", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("the first pass waits firstDelayMs, then one every everyMs", async () => {
    let calls = 0;
    const clock = startAlertClock({
      run: async () => { calls++; }, everyMs: EVERY, firstDelayMs: FIRST, log: errorsLog().log,
    });
    await vi.advanceTimersByTimeAsync(FIRST - 1);
    expect(calls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(EVERY);
    expect(calls).toBe(2);
    await clock.stop();
  });

  it("a slow pass delays the next one and never runs beside it", async () => {
    // Red mutation: re-arm when the timer fires instead of when the pass settles — a second pass
    // starts while the first still hangs.
    let calls = 0;
    let running = 0;
    let peak = 0;
    const gates: Array<ReturnType<typeof deferred>> = [];
    const clock = startAlertClock({
      run: async () => {
        calls++;
        running++;
        peak = Math.max(peak, running);
        const gate = deferred();
        gates.push(gate);
        await gate.promise;
        running--;
      },
      everyMs: EVERY, firstDelayMs: FIRST, log: errorsLog().log,
    });
    await vi.advanceTimersByTimeAsync(FIRST + 5 * EVERY);
    expect(calls, "five cadences passed while the first pass hung: still one pass").toBe(1);
    gates[0]!.resolve();
    await vi.advanceTimersByTimeAsync(EVERY - 1);
    expect(calls, "the next pass waits a whole cadence after the slow one settled").toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    expect(peak, "two passes never ran at once").toBe(1);
    gates[1]!.resolve();
    await clock.stop();
  });

  it("a pass that throws is logged and the cadence holds", async () => {
    // Red mutation: drop the catch — no alert_pass_failed line, and the rejection escapes unhandled.
    const { errors, log } = errorsLog();
    let calls = 0;
    const clock = startAlertClock({
      run: async () => { calls++; throw new Error("pool closed"); }, everyMs: EVERY, firstDelayMs: FIRST, log,
    });
    await vi.advanceTimersByTimeAsync(FIRST);
    await vi.advanceTimersByTimeAsync(EVERY);
    expect(calls).toBe(2);
    expect(errors).toEqual(["alert_pass_failed", "alert_pass_failed"]);
    await clock.stop();
  });

  it("stop() waits for the pass in flight and arms nothing after it", async () => {
    // Red mutation: a stop() that only clears the timer — it resolves while the pass still runs,
    // and shutdown closes the pool under it.
    const gate = deferred();
    let calls = 0;
    let finished = false;
    const clock = startAlertClock({
      run: async () => { calls++; await gate.promise; finished = true; },
      everyMs: EVERY, firstDelayMs: FIRST, log: errorsLog().log,
    });
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(calls).toBe(1);
    let stopped = false;
    const stopping = clock.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped, "stop() resolved while the pass was still running").toBe(false);
    gate.resolve();
    await stopping;
    expect(finished).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * EVERY);
    expect(calls, "nothing ran after stop()").toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop() before the first tick: no pass ever runs", async () => {
    let calls = 0;
    const clock = startAlertClock({
      run: async () => { calls++; }, everyMs: EVERY, firstDelayMs: FIRST, log: errorsLog().log,
    });
    await clock.stop();
    await vi.advanceTimersByTimeAsync(FIRST + 3 * EVERY);
    expect(calls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs at the worker's cadence: worker_down (two minutes stale) pages within three", () => {
    expect(ALERT_PASS_EVERY_MS).toBe(60_000);
    expect(ALERT_PASS_FIRST_DELAY_MS).toBeLessThan(ALERT_PASS_EVERY_MS);
  });
});

describe("alertClockFor — armed by TF_ALERT_SECRET, and only by it", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("no secret: no clock and no timer, and the boot line names the variable", () => {
    // Red mutation: arm the clock without `cfg.alerts` — a timer exists and the line is missing.
    vi.useFakeTimers();
    const { lines, logger } = captured();
    const clock = alertClockFor(runtime(cfgWith({}), logger));
    expect(clock).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(lines.filter((l) => String(l.event).startsWith("alert_clock_"))).toEqual([
      expect.objectContaining({ event: "alert_clock_unarmed", configVar: "TF_ALERT_SECRET" }),
    ]);
  });

  it("no entitlements program here: the pass gets no plane reader, and the boot says the watch is off, once", async () => {
    // Red mutation: drop `planeOps:` from buildDeps' alerts block — the pass reads it as absent.
    vi.useFakeTimers();
    for (const extra of [{}, { TF_ALERT_SECRET: SECRET }]) {
      const { lines, logger } = captured();
      const rt = runtime(cfgWith(extra), logger);
      const clock = alertClockFor(rt);
      expect(lines.filter((l) => l.event === "plane_ops_watch")).toEqual([
        expect.objectContaining({ level: "info", state: "off" }),
      ]);
      expect(lines.filter((l) => "droppedFields" in l), "the logger census refused a field").toEqual([]);
      if (extra.TF_ALERT_SECRET) {
        const alerts = buildDeps(new Request(rt.cfg.origin), rt).alerts;
        expect(alerts).toBeDefined();
        expect(alerts!.planeOps, "null, never absent: this server reads no plane").toBeNull();
      }
      await clock?.stop();
    }
  });

  it("armed: one boot line names the cadence and the arms, and the census drops none of it", async () => {
    vi.useFakeTimers();
    const { lines, logger } = captured();
    const cfg = cfgWith({ TF_ALERT_SECRET: SECRET, TF_ALERT_WEBHOOK_URL: "https://ntfy.example/ohmail" });
    const clock = alertClockFor(runtime(cfg, logger));
    expect(clock).not.toBeNull();
    const armed = lines.filter((l) => l.event === "alert_clock_armed");
    expect(armed).toEqual([
      expect.objectContaining({ everyMs: ALERT_PASS_EVERY_MS, alertSinks: ["webhook"] }),
    ]);
    // One arm is one vendor: said at boot, the worker's line verbatim.
    expect(lines.map((l) => l.event)).toContain("alert_sinks_single_vendor");
    expect(lines.filter((l) => "droppedFields" in l), "the logger census refused a field").toEqual([]);
    await clock!.stop();
  });

  it("armed: the clock runs the api driver's pass on the composed handle, and GET /internal/alerts shows it", async () => {
    // Red mutation: the clock calls nothing (or composes no handle) — `passes` never moves and the
    // read shows the api driver as never run.
    const db = await makeTestDb();
    const { logger } = captured();
    const rt = runtime(cfgWith({ TF_ALERT_SECRET: SECRET }), logger, db);
    const before = apiAlertSinkSummary([]).passes;
    const clock = alertClockFor(rt, { everyMs: 60_000, firstDelayMs: 1 });
    expect(clock).not.toBeNull();
    await vi.waitFor(() => { expect(apiAlertSinkSummary([]).passes).toBeGreaterThan(before); }, { timeout: 10_000 });
    await clock!.stop();

    const res = await handleServerRequest(new Request("http://localhost:8080/internal/alerts", {
      headers: { authorization: `Bearer ${SECRET}` },
    }), rt);
    expect(res.status).toBe(200);
    const body = await res.json() as { open: Array<{ alertKey: string }>; drivers: Array<{ driver: string; ranAt: string | null }> };
    expect(body.drivers.find((d) => d.driver === "api")?.ranAt, "the clock's pass is the api driver's").not.toBeNull();
    // No organizer has ever beaten here, so the pass the clock ran saw a dead worker.
    expect(body.open.map((o) => o.alertKey)).toContain("worker_down:0");
  }, 20_000);
});
