/**
 * EVERY CALL INTO THE SHELL HAS A DEADLINE, and it is one bound for every caller. A command the
 * shell never answered left its caller pending for ever: a wedged shell kept a press busy with no
 * sentence. The rejection is NAMED (`BridgeDeadlineError`) so a press site renders its message.
 *
 * THE DEFAULT IS THE BOUND. A caller that names no deadline gets it; one that names a deadline of
 * 0, a negative, `NaN` or `undefined` is refused by name BEFORE anything is sent, because a helper
 * whose fallback is "no deadline" is the branch nobody tests. No import and no module-level call,
 * so every bundle may take it without taking anything else.
 */
export const SHELL_DEADLINE_MS = 60_000;

export interface DeadlineOptions {
  /** Absent: {@link SHELL_DEADLINE_MS}. Present, it must be a finite number above zero. */
  ms?: number;
  /** An abort the caller races against the answer; it rejects, it cannot cancel the shell's work. */
  signal?: AbortSignal;
}

function named(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

function span(ms: number): string {
  return ms === 60_000 ? "a minute" : `${Math.ceil(ms / 1000)} seconds`;
}

/** The deadline's rejection. `who` is what did not answer: the local engine, or the app itself. */
export function deadlineError(who: string, ms: number = SHELL_DEADLINE_MS): Error {
  return named(
    "BridgeDeadlineError",
    `ohmail Desktop: ${who} did not answer within ${span(ms)}, so this request was given up.`,
  );
}

export function abortError(): Error {
  return named("AbortError", "ohmail Desktop: the request was aborted.");
}

/**
 * Start `start` and race it against the deadline (and the caller's abort). The loser's rejection
 * is handled by `Promise.race`. The raced promise itself is returned and the timer is cleared on
 * a side branch, so a caller awaits no more steps than a bare race and no timer outlives a call.
 */
export function withDeadline<T>(
  who: string,
  start: () => Promise<T>,
  options: DeadlineOptions = {},
): Promise<T> {
  const ms = Object.prototype.hasOwnProperty.call(options, "ms") ? options.ms : SHELL_DEADLINE_MS;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return Promise.reject(named(
      "DeadlineMissingError",
      `ohmail Desktop: a call into the app was given no deadline (${String(ms)}), so it was not sent.`,
    ));
  }
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(abortError());
  let work: Promise<T>;
  try {
    work = start();
  } catch (err) {
    return Promise.reject(err);
  }
  let expire: ReturnType<typeof setTimeout> | undefined;
  const racers: Promise<T>[] = [
    work,
    new Promise<never>((_resolve, reject) => {
      expire = setTimeout(() => reject(deadlineError(who, ms)), ms);
    }),
  ];
  if (signal) {
    racers.push(new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
    }));
  }
  const raced = Promise.race(racers);
  const clear = (): void => clearTimeout(expire);
  raced.then(clear, clear);
  return raced;
}
