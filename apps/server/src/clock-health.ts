import { ALERT_PASS_EVERY_MS, ALERT_PASS_FIRST_DELAY_MS } from "./alert-clock.js";
import {
  rowsFor, SCHEDULED_SEND_EVERY_MS, SCHEDULED_SEND_FIRST_DELAY_MS, type ClockRow,
} from "./clocks.js";
import type { Runtime } from "./deps.js";

export interface ClockProgress {
  lastBeatAt: number | null;
  stalled: boolean;
}

const MINUTE = 60_000;
const CLOCK_GRACE_MS = 2 * MINUTE;
const SEND_GRACE_MS = 30 * MINUTE;

/** Observe the existing clock entry points without changing their work or cadence. */
export function observeClocks(
  runtime: Runtime, dispatch: (req: Request) => Promise<Response>, rows?: readonly ClockRow[],
) {
  const { cfg, logger, alertDb } = runtime;
  const own = cfg.chosen.sendClock === "own-chain";
  const heartbeats = new Map<string, {
    firstMs: number; gapMs: number; lastBeatAt: number | null; staleAt: number;
  }>();
  const expectClock = (name: string, firstDelayMs: number, intervalMs: number, graceMs = CLOCK_GRACE_MS): void => {
    const firstMs = firstDelayMs + graceMs;
    heartbeats.set(name, { firstMs, gapMs: intervalMs + graceMs, lastBeatAt: null, staleAt: Date.now() + firstMs });
  };
  const beat = (name: string): void => {
    const clock = heartbeats.get(name);
    if (!clock) return;
    const now = Date.now();
    const recovered = now >= clock.staleAt;
    clock.lastBeatAt = now;
    clock.staleAt = now + clock.gapMs;
    if (recovered) logger.info("api_clock_recovered", { route: name, reason: "the next pass started" });
  };

  if (own) {
    expectClock("selfhost_send", SCHEDULED_SEND_FIRST_DELAY_MS, SCHEDULED_SEND_EVERY_MS, SEND_GRACE_MS);
    if (cfg.alerts) expectClock("alerts", ALERT_PASS_FIRST_DELAY_MS, ALERT_PASS_EVERY_MS);
  }
  const targets = new Map<string, string>();
  if (cfg.clocks.inProcess) {
    for (const row of rowsFor(own ? "plain" : "managed", rows).driven) {
      targets.set(row.route, row.target);
      expectClock(row.target, row.firstDelayMs, row.everyMs + row.jitterMs);
    }
  }

  return {
    runtime: own ? {
      ...runtime,
      services: {
        ...runtime.services,
        // This view belongs to the clocks. The send loop reads this port when it starts a pass.
        get scheduledFiles() {
          beat("selfhost_send");
          return runtime.services.scheduledFiles;
        },
      },
      alertDb: alertDb && (() => {
        beat("alerts");
        return alertDb();
      }),
    } : runtime,
    dispatch(req: Request): Promise<Response> {
      const target = targets.get(new URL(req.url).pathname);
      if (target) beat(target);
      return dispatch(req);
    },
    progress(leading: boolean): Record<string, ClockProgress> | undefined {
      const now = Date.now();
      if (!leading) {
        for (const clock of heartbeats.values()) {
          clock.lastBeatAt = null;
          clock.staleAt = now + clock.firstMs;
        }
        return undefined;
      }
      return Object.fromEntries([...heartbeats].map(([name, clock]) => [name, {
        lastBeatAt: clock.lastBeatAt, stalled: now >= clock.staleAt,
      }]));
    },
  };
}
