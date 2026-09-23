/**
 * IS SOMEBODY USING THIS INSTALL RIGHT NOW — the question a store-only pass asks before it takes the
 * connection. PGlite is one connection, so a pass round in flight is a round a search or a History
 * page waits behind. A request counts as a PERSON when it is a write (bar the report the window
 * sends on its own clock) or one of the reads a person asks for; the drain's pull, the
 * body prefetch and every status poll do not, or the window's own 8 s drain would keep the answer
 * "busy" for as long as it is open.
 */

/** Writes that are reports on a timer, never a press. */
const REPORT_WRITES: ReadonlyArray<readonly [string, RegExp]> = [
  ["POST", /^\/local\/window\/sync-failed$/],
];

/** Reads a person asks for: searching, paging History or a list, opening a message or a thread. */
const PERSON_READS: readonly RegExp[] = [
  /^\/search$/,
  /^\/screener\/junk\/search$/,
  /^\/messages$/,
  /^\/messages\/timeline$/,
  /^\/messages\/[^/]+(\/(body|attachments)(\/.*)?)?$/,
  /^\/threads(\/.*)?$/,
];

/** Is this request somebody at a screen (`true`), or a door's own clock (`false`)? */
export function isPersonRequest(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") {
    // `/messages/bodies` is the prefetch after a drain, not a message somebody opened.
    if (pathname === "/messages/bodies") return false;
    return PERSON_READS.some((re) => re.test(pathname));
  }
  return !REPORT_WRITES.some(([rm, re]) => rm === m && re.test(pathname));
}

/** How long after the last person's request a store-only pass may run. */
export const PERSON_QUIET_MS = 60_000;

interface AttentionClock {
  /** Every request any door serves passes through here. */
  note(method: string, pathname: string): void;
  /** Milliseconds since a person's last request; `Infinity` when none since boot. */
  quietForMs(): number;
}

export function createAttentionClock(now: () => number = Date.now): AttentionClock {
  let lastPersonAt: number | null = null;
  return {
    note(method, pathname) {
      if (isPersonRequest(method, pathname)) lastPersonAt = now();
    },
    quietForMs() {
      return lastPersonAt === null ? Number.POSITIVE_INFINITY : Math.max(0, now() - lastPersonAt);
    },
  };
}
