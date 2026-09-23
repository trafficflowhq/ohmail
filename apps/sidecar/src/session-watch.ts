import type { CloudSessionReading } from "./cloud-auth.js";

/**
 * THE WINDOW'S HELD QUESTION — "answer when the session reading moves" (`GET /cloud/session/wait`).
 * The pipe is request/response, so nothing reaches the window unasked; it keeps one request open
 * and the engine answers it the moment the reading changes, or at the hold bound unchanged. A
 * refusal then reaches the window in one round trip instead of on the next minute's `/health`.
 * `release()` answers every held question and holds no new one: a quit never waits out a hold.
 */

/** Under the window's own one-minute bridge deadline, so a hold always answers before it gives up. */
export const SESSION_WAIT_HOLD_MS = 45_000;

/** The reading the window holds, as it sent it back: `state` null is "no session". */
export interface HeldReading {
  state: string | null;
  code: string | null;
  since: string | null;
}

export function heldReadingOf(params: URLSearchParams): HeldReading {
  const state = params.get("state");
  const code = params.get("code");
  const since = params.get("since");
  return {
    state: state === null || state === "" || state === "none" ? null : state,
    code: code === null || code === "" ? null : code,
    since: since === null || since === "" ? null : since,
  };
}

/** Is the engine's reading the one the window holds? Every field, or a `since` move is missed. */
export function sameReading(now: CloudSessionReading | null, held: HeldReading): boolean {
  if (now === null) return held.state === null;
  return now.state === held.state && now.code === held.code && now.since === held.since;
}

export interface SessionWatch {
  /** The reading changed: answer every held question. */
  moved(): void;
  /** Stop holding: answer every held question now, and every later one at once. */
  release(): void;
  /** Resolves on a move, a release or the hold bound — at once if `same()` is already false. */
  wait(same: () => boolean, holdMs?: number): Promise<void>;
  /** How many questions are held. For the tests and the shutdown line. */
  held(): number;
}

export function createSessionWatch(): SessionWatch {
  const waiters = new Set<() => void>();
  let released = false;
  const answerAll = (): void => {
    for (const done of [...waiters]) done();
  };
  return {
    moved: answerAll,
    release() {
      released = true;
      answerAll();
    },
    wait(same, holdMs = SESSION_WAIT_HOLD_MS) {
      if (released || !same()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, holdMs);
        timer.unref?.();
        waiters.add(done);
      });
    },
    held: () => waiters.size,
  };
}
