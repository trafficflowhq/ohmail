import { createLogger, type Logger, type LogLevel, type LogSink } from "@trafficflow/core/mail";

/**
 * THE SIDECAR'S DIAGNOSTIC CHANNEL — `packages/core/src/log.ts`, on stderr.
 *
 * ── WHAT THIS REPLACED, AND WHY A COMMENT WAS THE BUG ──────────────────────────────────────
 *
 * `main.ts` used to hand-roll its own sink, and its doc line claimed "one JSON object per line,
 * on stderr — same shape the worker's logger emits". The SHAPE matched. The CONTROLS did not,
 * and that is exactly how a second implementation outlived the hardening of the first:
 * `JSON.stringify` over an arbitrary `Record<string, unknown>` has no allowlist, no value
 * patterns, no string bound and no error discipline of any kind. Two defects had already been
 * found and fixed in the shared logger — redaction keyed on exact field names, so credentials,
 * keys, tokens and message bodies reached the line under any other name; and top-level channels
 * such as the event name that bypassed redaction altogether — and both were still live here,
 * where the sink wrote `err.message` verbatim at eight call sites, wrote a request's full `url`,
 * and carried an event named `ephemeral_kek`.
 *
 * A comment documenting an invariant is the claim under test, not evidence for it. The claim is
 * now true because the bytes come from `createLogger`, not because a sentence says they do: one
 * test asserts the exact line handed to the sink, and a second walks every `log(...)` call in
 * this package and asserts each field name it passes is one the logger will emit.
 *
 * ── THE DESKTOP TIER CHANGES THE BLAST RADIUS, NOT THE SHAPE ───────────────────────────────
 *
 * The KEK here is local, so a leaked line reaches one machine rather than a hosted log drain.
 * That is a smaller radius and the same defect: `packages/core/src/crypto.ts` has no forward
 * secrecy, so a KEK on one line retroactively decrypts every byte ever wrapped under it, with no
 * end date. And the errors quoted at these call sites are IMAP and Postgres driver messages,
 * which carry server responses, folder names, addresses and — on a login path — the credential.
 *
 * ── THE SEAM IS A TWO-ARGUMENT FUNCTION, AND THAT IS FORCED ────────────────────────────────
 *
 * {@link Diagnostic} is `(event, detail) => void` rather than a `Logger`, because
 * `readMailboxLease` in `@trafficflow/worker/lease` takes exactly that shape and `engine.ts`
 * hands it this function — there is ONE reading of the lease decision table and both this engine
 * and Cloud run it. A third `level` parameter would make this unassignable there, so the level is
 * DERIVED from the event name by {@link ERROR_EVENT} instead. Nothing about the redaction depends
 * on that derivation: `level` is authored by the logger and can never be supplied by a caller.
 *
 * ── `err` IS PASSED WHOLE, AND THAT IS NOT A WEAKENING ─────────────────────────────────────
 *
 * Every call site in this package now passes the THROWN VALUE under `err` and never a message.
 * `createLogger`'s `emit` special-cases that key into `describeError`, so the line carries
 * `errorClass` + `errorCode` and the message is discarded before anything is written — which is
 * the property `packages/api/src/middleware.ts:175` already relies on, and the house style.
 *
 * `packages/core/src/adapters/organizer-lease.ts` deliberately does the opposite at its two
 * `lease_*_failed` sites, reducing to a bare string so there is "no object for a future redactor
 * bug to walk". The two are not in tension. That file is a LIBRARY whose `log` is injected by
 * hosts it does not know, and its `err` is unambiguously an ImapFlow driver object. Here the
 * seam's only production implementation is this file. And in the worst case the two choices
 * order the other way round: handed to a naive `JSON.stringify` sink, an `Error` serialises to
 * `{}` because `message` and `stack` are non-enumerable, while `String(err)` publishes the
 * message in full. Passing the value whole is never the more dangerous of the two.
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
 * The hardened logger itself, `service: sidecar`, on stderr.
 *
 * ── WHY THIS IS EXPOSED SEPARATELY FROM {@link createSidecarLog} ────────────────────────────
 *
 * The two-argument {@link Diagnostic} is forced by `readMailboxLease` (see the header) and it is
 * the right seam for this package's own call sites, whose severity is a naming convention. It is
 * the WRONG seam for code this package merely HOSTS: `@trafficflow/worker/sync` is written
 * against `Logger` and states its own severity per line — `log?.warn(...)` for a host that
 * refused a `STORE`, `log?.error(...)` for bookkeeping that did not commit. Passing those
 * through a `Diagnostic` would re-derive the level from the event name and flatten both to
 * `info`, because the worker's vocabulary was never written to the sidecar's convention
 * (`reconcile_flag_transport_failure` ends in `_failure`, which {@link ERROR_EVENT} does not
 * match, and there is no reason it should — that regex is a claim about THIS package).
 *
 * So the sync loop gets the `Logger` and this package keeps the `Diagnostic`, and both are the
 * same object underneath: one construction, one sink, one allowlist. `createSidecarLog` is now
 * literally `diagnosticFor(createSidecarLogger(...))`, so there is no second configuration to
 * drift — the thing `log.ts` exists to prevent.
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
 * A request's route, or the fact that it was refused. THE QUERY STRING IS DISCARDED FIRST.
 *
 * `host.ts` used to log `url: header.url`. Under the hardened logger `url` is a
 * `SECRET_NAME_SUBSTRINGS` fragment, so that field would now emit `[redacted]` — safe and
 * useless. The path is the part an operator needs, and it is safe to keep for a checkable reason:
 * every route pattern in `packages/api/src/routes/**` takes at most an opaque `:id` (94 patterns,
 * zero free-text segments), so user content can only ever arrive in the QUERY — `/search?q=…`
 * carries the search terms, which on this product are mail. The query is dropped before the
 * grammar runs, and the grammar then refuses `%`, `@`, `:` and whitespace, which is what
 * percent-encoded content would carry. `route` rather than `url` is also the census name for
 * exactly this fact (`packages/api/src/middleware.ts:175` passes `route: route.pattern`); the
 * difference on this host is that a path may carry an id where the API's carries `:id`.
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
