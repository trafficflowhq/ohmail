/**
 * The boot's wait for a database still starting: on a first start Postgres runs its init scripts on a
 * server that takes no TCP connection, then restarts on its final listener. Anything else is thrown at once.
 */

/** Node's connection errors, postgres.js's own, and 57P03 (the database system is starting up). */
const STARTING_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
  "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED",
  "57P03",
]);
/** SQLSTATE class 08, connection exception. */
const CONNECTION_EXCEPTION = /^08[0-9A-Z]{3}$/;
/** The error and its causes, as deep as an ORM wraps a driver error; a cycle ends here too. */
const LEVELS = 5;

export function isDatabaseStarting(err: unknown): boolean {
  let at: unknown = err;
  for (let level = 0; level < LEVELS && typeof at === "object" && at !== null; level++) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string" && (STARTING_CODES.has(code) || CONNECTION_EXCEPTION.test(code))) return true;
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

export interface AwaitDatabaseOptions {
  budgetMs?: number;
  firstDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onWait?: (wait: { err: unknown; tries: number; elapsedMs: number }) => void;
}

/** Runs `probe` until it resolves, doubling the wait up to the cap; past the budget the last error is thrown. */
export async function awaitDatabase(probe: () => Promise<void>, opts: AwaitDatabaseOptions = {}): Promise<void> {
  const budgetMs = opts.budgetMs ?? 120_000;
  const maxDelayMs = opts.maxDelayMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const start = now();
  let delay = opts.firstDelayMs ?? 500;
  for (let tries = 1; ; tries++) {
    try {
      await probe();
      return;
    } catch (err) {
      if (!isDatabaseStarting(err)) throw err;
      const elapsedMs = now() - start;
      if (elapsedMs + delay > budgetMs) throw err;
      opts.onWait?.({ err, tries, elapsedMs });
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}
