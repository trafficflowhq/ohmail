import { pathToFileURL } from "node:url";
import type { Logger } from "@trafficflow/core";

/**
 * "Was this module run directly?" — correctly.
 *
 * The idiom `import.meta.url === \`file://${process.argv[1]}\`` is WRONG for any path that
 * needs percent-encoding. A repo checked out under `/Volumes/Macintosh SSD/…` produces
 * `import.meta.url = file:///Volumes/Macintosh%20SSD/…` while the template string yields
 * `file:///Volumes/Macintosh SSD/…`, so the guard is never true and `tsx src/index.ts`
 * exits 0 having done NOTHING — no health server, no lock, no sync, no error. Every worker
 * and cron entry point is behind this, i.e. the exact code the deployment platform executes.
 */
export function isCliEntry(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  return moduleUrl === pathToFileURL(argv1).href;
}

/**
 * Exit, but let the last log line actually LEAVE the process first. `process.exit()` does not flush pending
 * stdout writes, and on Linux stdout to a PIPE (every container) is ASYNCHRONOUS, so
 * `log.error(...); process.exit(1)` discards the very line that explains the crash. Not hypothetical: one
 * early outage's whole deployment log was a single "Starting Container" line — a fatal path that reports
 * nothing turns a one-minute fix into an hour-long outage. `write("")` resolves once the queue ahead of it
 * has drained; the timeout is the honest part — if stdout is a full pipe with no reader we must still exit,
 * so the flush gets a deadline and then we go anyway.
 */
export function flushExit(code: number, timeoutMs = 2000): void {
  let done = false;
  const go = (): void => { if (!done) { done = true; process.exit(code); } };
  const timer = setTimeout(go, timeoutMs);
  timer.unref?.();
  try {
    process.stdout.write("", () => { clearTimeout(timer); go(); });
  } catch {
    // A stdout whose write throws synchronously must not block the exit — proceed now.
    go();
  }
}

/** The narrow slice of `process` the crash handlers need, so a test can hand them a fake. */
export interface CrashHost {
  on(event: "uncaughtException" | "unhandledRejection", listener: (value: unknown) => void): unknown;
}

export interface CrashHandlerOptions {
  /**
   * Read LAZILY, every time, and that is the point of the indirection: the handlers are
   * installed BEFORE the configured logger exists (see below), so they must resolve the best
   * logger available at the moment of the crash rather than capture the bootstrap one.
   */
  log: () => Logger;
  host?: CrashHost;
  exit?: (code: number) => void;
  /**
   * THE ONE WAY AN UNCAUGHT EXCEPTION MAY NOT KILL THIS PROCESS — a hole punched to an exact shape by a
   * caller, or it does not exist. Returns the operator-facing REASON to survive `err`, or `null` for the
   * contract's normal work; default `undefined` (an embedder that says nothing gets `exit(1)`). The
   * knowledge is INJECTED, not written here: the only shape that needs it is a `postgres@3.4.9` defect
   * (`driver-write-race.ts`, passed in by `index.ts`), and a contract that enumerates one dependency's bugs
   * stops being a contract — and `entry.ts` is a PUBLISHED subpath (`@trafficflow/worker/entry`, imported by
   * `apps/sidecar` for `isCliEntry`) whose engine runs PGlite and has no postgres.js. Only `uncaughtException`
   * consults it: the driver's throw comes out of `setImmediate` (no promise to attach to); the same value as
   * a REJECTION means a promise owns it, which the `DatabaseFaultError` taxonomy already classifies. */
  survivable?: (err: unknown) => string | null;
}

/**
 * Report an escaping throw, then leave — through the logger's own error contract. The message is GONE: the
 * handlers used to log `errorDetail: err.message`, and `log.ts` reduces `err` to CLASS + CODE precisely
 * because a message interpolates the connection string, the failing query or the RFC822 bytes; `errorDetail`
 * was NOT on `REDACTED_KEYS` (that file's own escape hatch), so it routed the withheld string into the
 * drain. Both halves are closed (pass `err` only; `errordetail` is now redacted). Installed FIRST, before
 * `await import("./supervisor.js")` and `loadConfig()` — the two steps most likely to fail on a fresh
 * deploy (a malformed `TF_SHARD_INDEX`, a pooled `DATABASE_URL_SESSION`), which used to reject the async IIFE
 * through Node's default path (no event, no flush, "Starting Container"). Honest limit: cannot report an OOM
 * (SIGKILL is uncatchable). The one exemption `opts.survivable` (`driver-write-race.ts`) is never quiet — it logs at `error` with a running COUNT, and is deliberately uncapped (a cap re-creates the crash). */
export function installCrashHandlers(opts: CrashHandlerOptions): void {
  const host = opts.host ?? (process as unknown as CrashHost);
  const exit = opts.exit ?? flushExit;
  let survived = 0;
  host.on("uncaughtException", (err: unknown) => {
    const reason = opts.survivable?.(err) ?? null;
    if (reason !== null) {
      survived++;
      opts.log().error("uncaught_exception_survived", { err, reason, survived });
      return;
    }
    opts.log().error("uncaught_exception", { err });
    exit(1);
  });
  host.on("unhandledRejection", (reason: unknown) => {
    opts.log().error("unhandled_rejection", { err: reason });
    exit(1);
  });
}
