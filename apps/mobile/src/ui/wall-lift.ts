/**
 * WHEN THE ACCOUNT'S STANDING IS ASKED — one schedule, two users. `opens` is one fresh access read;
 * `true` ends a poll. This decides only when to ask: once on every return to the foreground (past
 * `returnFloor`), on `minute` while the app is in front (`null`, the default: never on a clock),
 * and a bounded poll after the way-back press. The wall passes `WALL_READ_MS` and its read takes
 * the wall down (`net/account.ts`); the account strip passes no minute. A spent poll offers one
 * more. Pure — the lifecycle and the clock are handed in, so the suite turns both by hand.
 */
import type { AppLifecycle, CadenceTimers } from "../net/drain-cadence";

export const LIFT_POLL_MS = 2_000;
export const LIFT_POLL_MAX = 30;
export const WALL_READ_MS = 60_000;
/** A read that has not answered by then is no answer, so a hung request cannot hold the poll. */
export const LIFT_READ_BOUND_MS = 10_000;
/** A return this soon after a read asks nothing more: a foreground flicker is one question. */
export const RETURN_DEBOUNCE_MS = 1_500;

/** `checking` while a poll runs; `pending` once it has spent itself on a still-closed account. */
export type WallCheck = "idle" | "checking" | "pending";

export interface WallLiftInputs {
  opens: () => Promise<boolean>;
  lifecycle: AppLifecycle;
  onCheck: (check: WallCheck) => void;
  timers?: CadenceTimers;
  now?: () => number;
  /** A read this often while the app is in front, or `null` (the default) for none. */
  minute?: number | null;
  /** How soon after the last read a return asks again. Default {@link RETURN_DEBOUNCE_MS}. */
  returnFloor?: () => number;
  /** When this client last had an answer, by any reader; the floor counts from the later of it and this schedule's own read. */
  lastAsked?: () => number;
}

export interface WallLift {
  /** The way-back press: the next return to the foreground polls rather than asking once. */
  armPoll(): void;
  /** One more bounded poll, from `pending`. */
  checkAgain(): void;
  stop(): void;
}

const realTimers: CadenceTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function wallLift(i: WallLiftInputs): WallLift {
  const timers = i.timers ?? realTimers;
  const now = i.now ?? Date.now;
  let stopped = false;
  let polling = false;
  let armed = false;
  let lastRead = Number.NEGATIVE_INFINITY;
  let minute: unknown = null;
  const held = new Set<unknown>();

  const after = (ms: number): Promise<void> => new Promise((resolve) => {
    const handle = timers.set(() => { held.delete(handle); resolve(); }, ms);
    held.add(handle);
  });

  const readOnce = async (): Promise<boolean> => {
    lastRead = now();
    let bound: unknown = null;
    try {
      return await Promise.race([
        i.opens().catch(() => false),
        new Promise<boolean>((resolve) => { bound = timers.set(() => resolve(false), LIFT_READ_BOUND_MS); }),
      ]);
    } finally {
      if (bound !== null) timers.clear(bound);
    }
  };

  const poll = async (): Promise<void> => {
    if (stopped || polling) return;
    polling = true;
    armed = false;
    i.onCheck("checking");
    for (let n = 0; n < LIFT_POLL_MAX; n += 1) {
      if (n > 0) await after(LIFT_POLL_MS);
      if (stopped) return;
      if (await readOnce()) {
        polling = false;
        if (!stopped) i.onCheck("idle");
        return;
      }
    }
    polling = false;
    if (!stopped) i.onCheck("pending");
  };

  const onReturn = (): void => {
    if (stopped || polling) return;
    if (armed) { void poll(); return; }
    const last = Math.max(lastRead, i.lastAsked?.() ?? Number.NEGATIVE_INFINITY);
    if (now() - last < (i.returnFloor?.() ?? RETURN_DEBOUNCE_MS)) return;
    void readOnce();
  };

  const every = i.minute ?? null;
  const armMinute = (ms: number): void => {
    minute = timers.set(() => {
      minute = null;
      if (stopped) return;
      // At most one a minute: a return or a poll that asked inside the minute already answered it.
      if (i.lifecycle.now() === "active" && !polling && now() - lastRead >= ms) void readOnce();
      armMinute(ms);
    }, ms);
  };

  const unsubscribe = i.lifecycle.subscribe((status) => { if (status === "active") onReturn(); });
  if (every !== null) armMinute(every);

  return {
    armPoll: () => { armed = true; },
    checkAgain: () => { void poll(); },
    stop: () => {
      stopped = true;
      unsubscribe();
      if (minute !== null) timers.clear(minute);
      for (const handle of held) timers.clear(handle);
      held.clear();
    },
  };
}
