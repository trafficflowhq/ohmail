/**
 * THE OPEN PHONE KEEPS DRAINING — the cadence the web and the desktop already had. The engine has
 * no loop of its own (`start()`/`syncOnce()` are one round each), so before this a live session
 * drained once at adoption and then only on a press or a push wake: an open phone read "As of …"
 * for as long as nobody pulled. Pure — no React Native, no network — so the suite drives it with a
 * fake lifecycle and a hand-turned clock; `connection.tsx` hands in `AppState` and the rounds.
 */

/**
 * The foreground cadence: the web's `POLL_MS`, the visible-tab rule when no wake stream carries the
 * tab. The phone is exactly that window — the same engine, no wake stream — and a push wake, where
 * one exists, only pulls a round earlier (`syncNow` joins the one in flight).
 */
export const FOREGROUND_DRAIN_MS = 8_000;

/** The web's `BACKOFF_CAP_MS`: a failing round waits longer each time, never past a minute. */
export const DRAIN_BACKOFF_CAP_MS = 60_000;

/** The app's lifecycle as the cadence reads it — React Native's `AppState` in the app. */
export interface AppLifecycle {
  now(): string | null | undefined;
  subscribe(listener: (status: string) => void): () => void;
}

/** The network door, as the cadence reads it (`network-door.ts#NetworkWatch`). */
export interface CadenceNetwork {
  now(): string;
  subscribe(listener: (state: string) => void): () => void;
}

/** The clock the next round is armed on — `setTimeout` in the app, a hand-turned one in the suite. */
export interface CadenceTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface KeepDraining {
  /** One round, joined onto any in flight; resolves the consecutive failures after it (0 = ok). */
  round(): Promise<number>;
  lifecycle: AppLifecycle;
  timers?: CadenceTimers;
  everyMs?: number;
  capMs?: number;
  /** Absent, or `unknown`, the cadence runs as it always did. */
  network?: CadenceNetwork;
}

const realTimers: CadenceTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** How long after a settled round the next one runs: the cadence, doubling per failure to the cap. */
export function nextDrainDelay(failures: number, everyMs = FOREGROUND_DRAIN_MS, capMs = DRAIN_BACKOFF_CAP_MS): number {
  if (failures <= 0) return everyMs;
  return Math.min(everyMs * 2 ** (failures - 1), capMs);
}

/**
 * Start the cadence for one session; answers its stop. Only `active` arms a timer — any other status
 * clears it, so a backgrounded app holds none — and a return to `active` drains at once rather than
 * waiting out an interval. The first timer counts from the start: the session's first drain is the
 * adoption's own, and a tick that lands while it runs joins it.
 */
export function keepDraining(opts: KeepDraining): () => void {
  const timers = opts.timers ?? realTimers;
  const every = opts.everyMs ?? FOREGROUND_DRAIN_MS;
  const cap = opts.capMs ?? DRAIN_BACKOFF_CAP_MS;
  let stopped = false;
  let handle: unknown = null;
  let running = false;

  const disarm = (): void => {
    if (handle !== null) timers.clear(handle);
    handle = null;
  };
  const arm = (ms: number): void => {
    disarm();
    if (stopped || opts.lifecycle.now() !== "active") return;
    handle = timers.set(tick, ms);
  };
  function tick(): void {
    handle = null;
    if (stopped || running || opts.lifecycle.now() !== "active") return;
    // NO NETWORK ON THE PHONE: nothing to ask, and no failure to count — the return drains.
    if (opts.network?.now() === "offline") { arm(every); return; }
    running = true;
    void opts.round()
      .catch(() => 1)
      .then((failures) => {
        running = false;
        arm(nextDrainDelay(failures, every, cap));
      });
  }

  const unsubscribe = opts.lifecycle.subscribe((status) => {
    if (status !== "active") { disarm(); return; }
    // Back in front: drain now. A round still in the air arms the next one when it settles.
    disarm();
    tick();
  });
  /* THE RETURN OF THE NETWORK DRAINS AT ONCE: it used to wait out a failure
     backoff of up to a minute, so "As of …" stood for 30-50 s after the phone was back. */
  const unwatch = opts.network?.subscribe((state) => {
    if (state !== "online") return;
    disarm();
    tick();
  });
  arm(every);

  return () => {
    stopped = true;
    disarm();
    unsubscribe();
    unwatch?.();
  };
}
