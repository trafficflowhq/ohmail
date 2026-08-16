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
 * Exit, but let the last log line actually LEAVE the process first.
 *
 * `process.exit()` does not flush pending stdout writes, and on Linux stdout to a PIPE — i.e.
 * stdout in every container — is ASYNCHRONOUS. So the extremely reasonable-looking
 *
 *     log.error("worker_start_failed", { err });
 *     process.exit(1);
 *
 * discards the very line that explains the crash. That is not hypothetical: in one early outage the
 * worker died and the platform's log for the deployment contained exactly one line, "Starting
 * Container". A fatal path that reports nothing turns a one-minute fix into an hour-long
 * outage, so the report has to be worth more than the microseconds saved by exiting instantly.
 *
 * `write("")` resolves once the queue ahead of it has drained. The timeout is the honest part:
 * if stdout is a full pipe with no reader we must still exit, so the flush gets a deadline and
 * then we go anyway.
 */
export function flushExit(code: number, timeoutMs = 2000): void {
  let done = false;
  const go = (): void => { if (!done) { done = true; process.exit(code); } };
  const timer = setTimeout(go, timeoutMs);
  timer.unref?.();
  try {
    process.stdout.write("", () => { clearTimeout(timer); go(); });
  } catch {
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
   * THE ONE WAY AN UNCAUGHT EXCEPTION MAY NOT KILL THIS PROCESS — and it is a hole punched to
   * an exact shape, by a caller, or it does not exist at all.
   *
   * Returns the operator-facing REASON to survive `err`, or `null` to let the contract below do
   * its normal work. Default `undefined`: an embedder that says nothing gets `exit(1)` for
   * everything, exactly as before.
   *
   * ── WHY THE KNOWLEDGE IS INJECTED RATHER THAN WRITTEN HERE ────────────────────────────────
   *
   * The only shape that needs this today is a defect in `postgres@3.4.9` (see
   * `driver-write-race.ts`, which `index.ts` passes in). It does not belong in this file for two
   * separate reasons. The design one: this module owns the CONTRACT — report through the
   * logger's error path, then leave — and a contract that enumerates one dependency's bugs stops
   * being a contract. The concrete one: `entry.ts` is a PUBLISHED subpath
   * (`@trafficflow/worker/entry`, imported by `apps/sidecar` for `isCliEntry`), and the desktop
   * engine runs PGlite and has no postgres.js at all. Knowledge of a Cloud driver's internals has
   * no business riding into the published payload.
   *
   * ── AND WHY ONLY `uncaughtException` CONSULTS IT ──────────────────────────────────────────
   *
   * Narrow to what was measured. The driver's throw comes out of `setImmediate`, which is the one
   * delivery with no promise to attach to; that is the whole reason it is uncatchable and the
   * whole reason this hook exists. The same value arriving as a REJECTION would mean a promise
   * owns it — i.e. a statement's own failure, which the `DatabaseFaultError` taxonomy already
   * classifies at the seams. Widening the hole to a channel nothing has been observed to use
   * would be speculation, and this is the wrong file to speculate in.
   */
  survivable?: (err: unknown) => string | null;
}

/**
 * Report an escaping throw, then leave — through the logger's own error contract.
 *
 * ── WHY THE MESSAGE IS GONE ──────────────────────────────────────────────────────────────
 *
 * These handlers used to log `errorDetail: err.message` beside `err`. `packages/core/src/log.ts`
 * reduces `err` to CLASS + CODE precisely because a message is not ours to publish — a driver
 * error interpolates the connection string (`host=…&user=…`, a defect this repo has already
 * had), a `postgres` error carries the failing query, a parse failure quotes the RFC822 bytes it
 * choked on. `errorDetail` was NOT on `REDACTED_KEYS` — it was that file's own advertised escape
 * hatch — so passing the message under that key routed the exact string the serialiser exists to
 * withhold into an operator-visible drain: absolute account isolation breached through the back door, from the one code path
 * that fires when things are already going wrong.
 *
 * Both halves are closed. These handlers pass `err` and nothing else, like every other call site;
 * and `errordetail` is now a redacted key, so the next caller who reaches for it cannot reopen
 * this by remembering the wrong idiom.
 *
 * ── AND WHY THEY ARE INSTALLED FIRST ─────────────────────────────────────────────────────
 *
 * They used to be registered AFTER `await import("./supervisor.js")` and `loadConfig()`, i.e.
 * after the two steps most likely to fail on a fresh deploy. A malformed `TF_SHARD_INDEX` or a
 * pooled `DATABASE_URL_SESSION` rejected the discarded async IIFE through Node's default path:
 * no structured event, no flush, and — because stdout to a container pipe is asynchronous — on
 * a fast exit no output at all. That is the "Starting Container" and nothing else that
 * `flushExit` above was written for.
 *
 * Honest limit, unchanged: this cannot report an OOM. The kernel's SIGKILL is not catchable,
 * which is why the memory bound belongs in the adapter's batch budget and not in a handler.
 *
 * ── THE ONE EXEMPTION, AND WHY IT IS STILL A CRASH CONTRACT ──────────────────────────────────
 *
 * `opts.survivable` may name a shape that must not kill the process. It is not a softening of the
 * rule above: exiting is still the answer to every value this process has no specific knowledge
 * of, and an embedder that passes nothing keeps the old behaviour exactly. What it admits is that
 * a DEPENDENCY's known defect can throw a value that is not evidence about this process at all —
 * `driver-write-race.ts` is the case and carries the measurement — and that answering it with
 * `exit(1)` produces a restart loop during the outage the process was taught to ride out.
 *
 * A survived throw is never quiet. It logs at `error`, through the same reduced-`err` path, with
 * the reason its matcher supplied and a running COUNT — so a shape that starts arriving in
 * numbers is visible as escalation rather than hidden as a handled case. It is deliberately not
 * capped: a cap converts a long outage back into the crash this exists to prevent, and the
 * matcher's own narrowness is what bounds the hole instead.
 */
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
