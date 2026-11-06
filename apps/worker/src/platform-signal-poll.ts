import type { Logger } from "@trafficflow/core";
import type { Tx } from "@trafficflow/db";
import {
  makePlatformSignalPort, runPlatformSignalPass, SIGNAL_SETTLE_MS, SIGNAL_WINDOW_MS,
  type DeliberateRefusal, type PlatformSignalEnv,
} from "@trafficflow/db/cloud";

/**
 * THE 5xx POLL, on the worker with its own platform credential (`TF_SIGNAL_*`, `config.ts`), so the
 * internet-facing API host holds none. The pass, its bounds and its fenced upserts are
 * `platform-signals.ts`'s; this is the clock around it: shard 0's leader only, one run at a time, never
 * throws, its health read by `api_cron_stale:platform_signals`. It fires on the bucket grid, past the
 * settle margin, so each bucket is read once and complete; a clock re-armed at run end drifted into it.
 */

/** The worker's own credential and the deliberate refusals, as `loadConfig` reads them. */
export interface PlatformSignalConfig {
  env: PlatformSignalEnv;
  deliberate: readonly DeliberateRefusal[];
  /** TEST SEAM: the platform transport. */
  fetchImpl?: typeof fetch;
  /** TEST SEAM: the first run's delay; absent ⇒ the first grid slot. */
  firstDelayMs?: number;
}

/** The cadence: one bucket per run, three of them make the rule's fifteen minutes. */
export const SIGNAL_POLL_EVERY_MS = SIGNAL_WINDOW_MS;
/** Where on the grid a run fires: this long after a bucket closes, past its settle margin. */
export const SIGNAL_POLL_OFFSET_MS = SIGNAL_SETTLE_MS + 10_000;
/** Added to every wait, never subtracted. */
export const SIGNAL_POLL_JITTER_MS = 30_000;
/**
 * The worker's wall clock for one pass, in place of the API host's 40 s (sized for a 60 s function).
 * Here the bound is the grid: the latest fire (offset plus jitter, 130 s), this, and two alert passes
 * fit inside one cadence, so every window is judged twice; 45 s leaves 5 s for the upserts and prune.
 */
export const SIGNAL_POLL_WALL_CLOCK_MS = 45_000;
/**
 * Log pages per project and window: 800 requests, against the API host's 12 (600). Twenty pages ran
 * a p90 of 39.4 s, about 2 s a page, so 16 pages (~32 s) leave the project lookup and a slow page
 * inside the wall clock; a bigger budget would end busy windows as deadline samples that re-walk.
 */
export const SIGNAL_POLL_PAGE_BUDGET = 16;

/** The first grid slot after `nowMs` (a bucket close plus the offset), plus `jitter01` of the jitter. */
export function nextSignalPollAt(nowMs: number, jitter01: number): number {
  const slot = (Math.floor((nowMs - SIGNAL_POLL_OFFSET_MS) / SIGNAL_POLL_EVERY_MS) + 1) * SIGNAL_POLL_EVERY_MS
    + SIGNAL_POLL_OFFSET_MS;
  return slot + Math.floor(jitter01 * SIGNAL_POLL_JITTER_MS);
}

/** The poll as `api_cron_stale` reads a target; only `written` is ok, `unconfigured` is a half-set pair. */
export interface PlatformSignalPollHealth {
  target: "platform_signals";
  everySeconds: number;
  lastOkAt: string | null;
  /** `failed`: the platform refused or failed the read; `error`: the database refused the pass. */
  outcome: "ok" | "failed" | "error" | null;
  consecutiveFailures: number;
}

export interface PlatformSignalPollHandle {
  /** Memory read. */
  health(): PlatformSignalPollHealth;
  /** When the poll started: the age a never-run poll is judged from. */
  since(): Date;
  /** Idempotent. Disarms the clock; a run in flight finishes, its upserts fenced by `fetched_at`. */
  stop(): void;
}

export interface PlatformSignalPollDeps {
  db: Tx;
  signals: PlatformSignalConfig;
  log: Logger;
  seams?: {
    now?: () => Date;
    random?: () => number;
    /** The callback resolves when the run it started has finished. */
    setTimer?: (fn: () => Promise<void>, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  };
}

export const startPlatformSignalPoll = (deps: PlatformSignalPollDeps): PlatformSignalPollHandle => {
  const { db, signals, log } = deps;
  const now = deps.seams?.now ?? ((): Date => new Date());
  const random = deps.seams?.random ?? Math.random;
  const setTimer = deps.seams?.setTimer ?? setTimeout;
  const clearTimer = deps.seams?.clearTimer ?? clearTimeout;
  const port = makePlatformSignalPort(signals.env, {
    pageBudget: SIGNAL_POLL_PAGE_BUDGET,
    wallClockMs: SIGNAL_POLL_WALL_CLOCK_MS,
    deliberate: signals.deliberate,
    ...(signals.fetchImpl ? { fetchImpl: signals.fetchImpl } : {}),
  });
  // Half a pair boots (the port answers `unconfigured`); the missing half is named once, never a value.
  const hasToken = (signals.env.VERCEL_TOKEN ?? "").trim().length > 0;
  const hasTeam = (signals.env.VERCEL_TEAM_ID ?? "").trim().length > 0;
  // Never ok, so api_cron_stale pages; a pass with nothing left to read would otherwise say `written`.
  const incomplete = hasToken !== hasTeam;
  if (incomplete) {
    log.warn("platform_signal_config_incomplete", {
      configVar: hasToken ? "TF_SIGNAL_VERCEL_TEAM_ID" : "TF_SIGNAL_VERCEL_TOKEN",
    });
  }

  const startedAt = now();
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dueAt = 0;
  let outcome: PlatformSignalPollHealth["outcome"] = null;
  let consecutiveFailures = 0;
  let lastOkAt: Date | null = null;

  const arm = (at: number): void => {
    if (stopped) return;
    dueAt = at;
    timer = setTimer(() => fire(), Math.max(0, at - now().getTime()));
  };

  // A timer that fires before its due time (the wall clock stepped back) waits out the rest and reads nothing.
  const fire = (): Promise<void> => {
    timer = null;
    if (stopped) return Promise.resolve();
    if (now().getTime() < dueAt) {
      arm(dueAt);
      return Promise.resolve();
    }
    return runOnce();
  };

  const runOnce = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const report = await runPlatformSignalPass(db, { port, now, wallClockMs: SIGNAL_POLL_WALL_CLOCK_MS });
      const code = incomplete ? "config_incomplete" : report.code;
      const fields = {
        outcome: report.outcome, rows: report.rows, pruned: report.pruned, deferred: report.deferred,
        ...(code ? { code } : {}),
      };
      if (incomplete || report.outcome !== "written") {
        consecutiveFailures += 1;
        outcome = "failed";
        (consecutiveFailures >= 3 ? log.error.bind(log) : log.warn.bind(log))("platform_signal_pass", fields);
      } else {
        consecutiveFailures = 0;
        outcome = "ok";
        lastOkAt = now();
        log.info("platform_signal_pass", fields);
      }
    } catch (err) {
      consecutiveFailures += 1;
      outcome = "error";
      // After stop() the pool may be closing under the run; that is shutdown, not a fault.
      if (!stopped) log.error("platform_signal_pass_failed", { err });
    } finally {
      inFlight = false;
      arm(nextSignalPollAt(now().getTime(), random()));
    }
  };

  arm(signals.firstDelayMs !== undefined
    ? startedAt.getTime() + signals.firstDelayMs
    : nextSignalPollAt(startedAt.getTime(), random()));

  return {
    health: () => ({
      target: "platform_signals",
      everySeconds: Math.round(SIGNAL_POLL_EVERY_MS / 1000),
      lastOkAt: lastOkAt ? lastOkAt.toISOString() : null,
      outcome,
      consecutiveFailures,
    }),
    since: () => startedAt,
    stop: () => {
      stopped = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
    },
  };
};
