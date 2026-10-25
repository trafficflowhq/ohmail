import { describe, it, expect } from "vitest";
import { createLogger } from "@trafficflow/core";
import type { Tx } from "@trafficflow/db";
import { platformSignals } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { startPlatformSignalPoll, type PlatformSignalPollDeps } from "../src/platform-signal-poll.js";

/**
 * THE 5xx POLL ON THE WORKER, with its own credential (`TF_SIGNAL_*`). The pass itself is
 * `packages/services/test/platform-signals.test.ts`'s; this is the clock around it: the first run,
 * the bearer it sends, what a refusal leaves on health and in the log, and the stop.
 */

const TOKEN = ["worker", "signal", "fixture", "value"].join("-");
const TEAM = ["team", "fixture"].join("_");
const NOW = new Date("2026-10-25T12:07:31.000Z");

interface FakeTimer { fn: () => void; ms: number; cleared: boolean }

function harness(status = 200) {
  const timers: FakeTimer[] = [];
  const bearers: string[] = [];
  const lines: string[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    bearers.push(new Headers(init?.headers).get("authorization") ?? "");
    if (status !== 200) return new Response("{}", { status });
    if (String(url).includes("/v9/projects/")) return new Response(JSON.stringify({ id: "prj_fixture" }));
    const end = Number(new URL(String(url)).searchParams.get("endDate"));
    return new Response(JSON.stringify({
      rows: [{ requestId: `r${end}`, statusCode: 200, timestamp: new Date(end - 1000).toISOString(), environment: "production" }],
      hasMoreRows: false,
    }));
  }) as typeof fetch;
  const start = async (env: PlatformSignalPollDeps["signals"]["env"] = { VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: TEAM }) => {
    const db = await makeTestDb();
    const poll = startPlatformSignalPoll({
      db: db as unknown as Tx,
      signals: { env, deliberate: [], fetchImpl },
      log: createLogger({ service: "worker", level: "debug", sink: (l) => lines.push(l) }),
      seams: {
        now: () => NOW, random: () => 0,
        setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t as never; },
        clearTimer: (h) => { (h as unknown as FakeTimer).cleared = true; },
      },
    });
    return { db, poll };
  };
  /** Fire the newest armed timer and wait for the run to re-arm the next one. */
  const fire = async (): Promise<void> => {
    const armed = timers.length;
    timers.filter((t) => !t.cleared).at(-1)!.fn();
    for (let i = 0; i < 400 && timers.length === armed; i++) await new Promise((r) => setTimeout(r, 5));
  };
  const events = (name: string) => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === name);
  return { timers, bearers, lines, start, fire, events };
}

describe("startPlatformSignalPoll", () => {
  it("runs three minutes in, writes the closed windows with the worker's bearer, and re-arms at five", async () => {
    const h = harness();
    const { db, poll } = await h.start();
    expect(h.timers.map((t) => t.ms)).toEqual([3 * 60 * 1000]);
    await h.fire();
    expect((await db.select().from(platformSignals)).length).toBeGreaterThan(0);
    expect(new Set(h.bearers)).toEqual(new Set([`Bearer ${TOKEN}`]));
    expect(poll.health()).toEqual({
      target: "platform_signals", everySeconds: 300, lastOkAt: NOW.toISOString(), outcome: "ok", consecutiveFailures: 0,
    });
    expect(h.events("platform_signal_pass")[0]).toMatchObject({ level: "info", outcome: "written", rows: 3 });
    expect(h.timers.at(-1)!.ms).toBe(5 * 60 * 1000);
    poll.stop();
  });

  it("a refusal is health 'failed' and a code in the log, never the token; the third in a row is an error", async () => {
    const h = harness(403);
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

  it("half a pair is said once by name and asks the platform nothing", async () => {
    const h = harness();
    const { poll } = await h.start({ VERCEL_TOKEN: TOKEN });
    await h.fire();
    expect(h.events("platform_signal_config_incomplete").map((l) => l.configVar)).toEqual(["TF_SIGNAL_VERCEL_TEAM_ID"]);
    expect(h.bearers).toEqual([]);
    expect(poll.health().outcome).toBe("ok");
    poll.stop();
  });

  it("stop() disarms the clock: a timer that fires anyway runs nothing", async () => {
    const h = harness();
    const { poll } = await h.start();
    poll.stop();
    expect(h.timers.every((t) => t.cleared)).toBe(true);
    h.timers[0]!.fn();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.bearers).toEqual([]);
    expect(poll.health().outcome).toBeNull();
  });
});
