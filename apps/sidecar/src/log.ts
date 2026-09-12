import { createLogger, type Logger, type LogLevel, type LogSink } from "@trafficflow/core/mail";

/**
 * The sidecar's diagnostic channel — `packages/core/src/log.ts`, on stderr. `main.ts` used to
 * hand-roll a sink whose doc claimed "same shape as the worker's"; the SHAPE matched and the
 * CONTROLS did not — `JSON.stringify` over an arbitrary record has no allowlist, value patterns,
 * string bound or error discipline, so two defects already fixed in the shared logger (name-keyed
 * redaction, top-level channels bypassing it) were still live here, writing `err.message` verbatim,
 * a full `url`, and an `ephemeral_kek` event. A comment is the claim under test: it is true now
 * because the bytes come from `createLogger`, proven by one test asserting the exact line and one
 * walking every `log(...)` call. `err` is passed WHOLE; the seam is a two-argument {@link Diagnostic}, forced by `readMailboxLease`.
 */

/**
 * What the engine, the host and the worker's lease all call. `detail` is required, matching
 * `readMailboxLease`'s `log` exactly — see the header.
 */
export type Diagnostic = (event: string, detail: Record<string, unknown>) => void;

/**
 * Which events are `error` rather than `info`.
 *
 * A naming convention, asserted against the full event vocabulary this package emits, and it is
 * the whole of the severity logic. Every failure event in this repository ends in one of these
 * three words; a new one that does not is logged at `info`, which is a lost filter and not a lost
 * line.
 */
const ERROR_EVENT = /_(?:failed|fatal|unavailable)$/;

/** What a transport-supplied string becomes when it fails its grammar. `log.ts`'s convention. */
const INVALID = "[invalid]";

/**
 * stderr, never stdout. stdout is the frame stream — see `main.ts`'s header — so the logger's own
 * default sink (`console.log`) would write a JSON line into the middle of a length-prefixed
 * frame and end the connection with no resync point.
 *
 * `process.stderr` is read at call time rather than bound once: `claimStdout()` rewrites
 * `process.stdout.write` while this process is starting, and a test spies on
 * `process.stderr.write` to prove where these bytes actually land.
 */
const stderrSink: LogSink = (line) => {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    /* EPIPE on a closed stderr. Dropping the line is correct; see log.ts property 1. */
  }
};

export interface SidecarLogOptions {
  /** Injected so a test can read the exact bytes. Defaults to stderr. */
  sink?: LogSink;
  level?: LogLevel;
  now?: () => Date;
}

/**
 * The hardened logger itself, `service: sidecar`, on stderr. Exposed separately from {@link
 * createSidecarLog} because the two-argument {@link Diagnostic} (forced by `readMailboxLease`) is the
 * right seam for this package's own call sites, whose severity is a naming convention, and the WRONG
 * seam for code it merely HOSTS: `@trafficflow/worker/sync` is written against `Logger` and states
 * severity per line, which a `Diagnostic` would re-derive from the event name and flatten to `info`
 * (the worker's vocabulary was never written to this convention). So the sync loop gets the `Logger`
 * and this package keeps the `Diagnostic`, both the same object underneath — `createSidecarLog` is
 * `diagnosticFor(createSidecarLogger(...))`, so there is no second config to drift.
 */
export function createSidecarLogger(opts: SidecarLogOptions = {}): Logger {
  return createLogger({
    service: "sidecar",
    sink: opts.sink ?? stderrSink,
    ...(opts.level === undefined ? {} : { level: opts.level }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
}

/** The two-argument seam over a logger, severity derived from the event name. */
export function diagnosticFor(logger: Logger): Diagnostic {
  return (event, detail) => {
    if (ERROR_EVENT.test(event)) logger.error(event, detail);
    else logger.info(event, detail);
  };
}

/** The diagnostic channel, backed by the hardened logger. `service` is always `sidecar`. */
export function createSidecarLog(opts: SidecarLogOptions = {}): Diagnostic {
  return diagnosticFor(createSidecarLogger(opts));
}

/**
 * An HTTP method token, or the fact that it was refused.
 *
 * `method` is on `ALLOWED_FIELDS`, so the logger emits it as free text — and on this transport it
 * is CLIENT-SUPPLIED. `host.ts` logs `request_failed` from a `catch` that includes
 * `decodeRequest` throwing, which is precisely the path a malformed `header.method` takes, so by
 * the time it is logged it has NOT been through `new Request()`'s token validation. This is the
 * same technique `log.ts` uses for `event` and `service`: a channel that is an identifier is held
 * to an identifier grammar. It runs BEFORE the logger and adds to it; it replaces nothing.
 */
export function describeMethod(method: unknown): string {
  return typeof method === "string" && /^[A-Z]{3,7}$/.test(method.toUpperCase())
    ? method.toUpperCase()
    : INVALID;
}

/**
 * A request's route, or the fact that it was refused. THE QUERY STRING IS DISCARDED FIRST. `host.ts`
 * used to log `url: header.url`, but under the hardened logger `url` is a `SECRET_NAME_SUBSTRINGS`
 * fragment, so that field would emit `[redacted]` — safe and useless. The path is what an operator
 * needs and is safe for a checkable reason: every route pattern takes at most an opaque `:id` (94
 * patterns, zero free-text segments), so user content only ever arrives in the QUERY, which is
 * dropped before the grammar runs (the grammar then refuses `%`, `@`, `:` and whitespace). `route`
 * rather than `url` is also the census name for exactly this fact.
 */
export function describeRoute(url: unknown): string {
  if (typeof url !== "string") return INVALID;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    // A relative URL. `decodeRequest` would reject it too, but this runs on the failure path.
    path = url.split(/[?#]/)[0] ?? "";
  }
  return /^\/[A-Za-z0-9/_.-]{0,119}$/.test(path) ? path : INVALID;
}
