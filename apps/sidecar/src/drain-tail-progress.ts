/**
 * A LONG DRAIN TAIL SAYS SO WHILE IT RUNS. The drain line is written at the drain's END so the
 * tail's own checkpoint can be counted — right for a settled mailbox, whose tail is microseconds,
 * and wrong for the FIRST tail after an import, which runs the name repair and the join heal over
 * the whole mailbox: measured taking a quarter of an hour at a third of one core with not one line
 * written, which from outside is indistinguishable from a hang. So the tail names the pass it is
 * inside, and one that outlives the interval keeps saying so. A tail that finishes first writes
 * NOTHING — the quiet case has to stay quiet, or the line is noise on every poll of every mailbox.
 */

/** The logger's shape at the sidecar's call sites — `log(event, fields)`. */
export type TailLog = (event: string, fields: Record<string, unknown>) => void;

/** How long a tail may run before it owes a line, and then how often it owes another. */
export const TAIL_PROGRESS_EVERY_MS = 15_000;

export interface TailProgress {
  /** Name the pass now running. The next line carries it. */
  phase: (name: string) => void;
  /** Stop the timer and report what was written. Idempotent. */
  end: () => { lines: number; totalMs: number };
}

export interface TailProgressDeps {
  everyMs?: number;
  now?: () => number;
}

export function startTailProgress(log: TailLog, deps: TailProgressDeps = {}): TailProgress {
  const everyMs = deps.everyMs ?? TAIL_PROGRESS_EVERY_MS;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let phase = "starting";
  let lines = 0;
  let stopped = false;
  const timer = setInterval(() => {
    lines += 1;
    log("sync_drain_tail_running", { phase, totalMs: now() - startedAt });
  }, everyMs);
  // The tail is not a reason to keep the process alive — a drain that ends with the app does not
  // owe another line.
  (timer as { unref?: () => void }).unref?.();
  return {
    phase: (name: string): void => { phase = name; },
    end: (): { lines: number; totalMs: number } => {
      if (!stopped) { stopped = true; clearInterval(timer); }
      return { lines, totalMs: now() - startedAt };
    },
  };
}
