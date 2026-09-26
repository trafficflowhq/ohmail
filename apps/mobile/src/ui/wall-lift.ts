/**
 * WHEN THE WALL ASKS WHETHER IT MAY LIFT. `opens` is one fresh access read answering `true` only
 * for `access: "open"`, and that read itself takes the wall down (`net/account.ts`); this decides
 * only when to ask: once on every return to the foreground, once a minute while the wall is shown
 * and the app in front, and a bounded poll after the way-back press. A spent poll offers one more.
 * Pure — the lifecycle and the clock are handed in, so the suite turns both by hand.
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
    if (now() - lastRead < RETURN_DEBOUNCE_MS) return;
    void readOnce();
  };

  const armMinute = (): void => {
    minute = timers.set(() => {
      minute = null;
      if (stopped) return;
      // At most one a minute: a return or a poll that asked inside the minute already answered it.
      if (i.lifecycle.now() === "active" && !polling && now() - lastRead >= WALL_READ_MS) void readOnce();
      armMinute();
    }, WALL_READ_MS);
  };

  const unsubscribe = i.lifecycle.subscribe((status) => { if (status === "active") onReturn(); });
  armMinute();

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
