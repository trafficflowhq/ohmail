import type { Logger } from "@trafficflow/core";
import type { Tx } from "@trafficflow/db";
import {
  makePlatformSignalPort, runPlatformSignalPass, SIGNAL_WINDOW_MS,
  type DeliberateRefusal, type PlatformSignalEnv,
} from "@trafficflow/db/cloud";

/**
 * THE 5xx POLL, on the worker with its own platform credential (`TF_SIGNAL_*`, `config.ts`). It ran
 * on the API host as `GET /internal/platform-signals/run`, which kept a deploy-capable platform token
 * inside the internet-facing function. The pass, its bounds and its fenced upserts are
 * `platform-signals.ts`'s; this is the clock around it. Started by shard 0's leader only, one run at a
 * time, and it never throws. Its health feeds `api_cron_stale:platform_signals` beside the API-cron
 * targets, which is what pages a poll that keeps failing over a table `signal_source_dark` cannot see.
 */

/** The worker's own credential and the deliberate refusals, as `loadConfig` reads them. */
export interface PlatformSignalConfig {
  env: PlatformSignalEnv;
  deliberate: readonly DeliberateRefusal[];
  /** TEST SEAM: the platform transport. */
  fetchImpl?: typeof fetch;
  /** TEST SEAM: the first run's delay; absent ⇒ {@link SIGNAL_POLL_FIRST_DELAY_MS}. */
  firstDelayMs?: number;
}

/** The cadence: one aligned window per run, three of them make the rule's fifteen minutes. */
export const SIGNAL_POLL_EVERY_MS = SIGNAL_WINDOW_MS;
/** Late in the first cycle, as the API-cron target was: an observability read nobody waits on. */
export const SIGNAL_POLL_FIRST_DELAY_MS = 3 * 60 * 1000;
/** Added to every later wait: a tenth of the cadence. */
export const SIGNAL_POLL_JITTER_MS = 30 * 1000;

/** The poll as `api_cron_stale` reads a target; `written` and `unconfigured` are both ok. */
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
    setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
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
    deliberate: signals.deliberate,
    ...(signals.fetchImpl ? { fetchImpl: signals.fetchImpl } : {}),
  });
  // Half a pair boots (the port answers `unconfigured`); the missing half is named once, never a value.
  const hasToken = (signals.env.VERCEL_TOKEN ?? "").trim().length > 0;
  const hasTeam = (signals.env.VERCEL_TEAM_ID ?? "").trim().length > 0;
  if (hasToken !== hasTeam) {
    log.warn("platform_signal_config_incomplete", {
      configVar: hasToken ? "TF_SIGNAL_VERCEL_TEAM_ID" : "TF_SIGNAL_VERCEL_TOKEN",
    });
  }

  const startedAt = now();
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let outcome: PlatformSignalPollHealth["outcome"] = null;
  let consecutiveFailures = 0;
  let lastOkAt: Date | null = null;

  const arm = (ms: number): void => {
    if (stopped) return;
    timer = setTimer(() => { void runOnce(); }, ms);
  };

  const runOnce = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const report = await runPlatformSignalPass(db, { port, now });
      const fields = {
        outcome: report.outcome, rows: report.rows, pruned: report.pruned,
        ...(report.code ? { code: report.code } : {}),
      };
      if (report.outcome === "failed") {
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
      arm(SIGNAL_POLL_EVERY_MS + Math.floor(random() * SIGNAL_POLL_JITTER_MS));
    }
  };

  arm(signals.firstDelayMs ?? SIGNAL_POLL_FIRST_DELAY_MS);

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
