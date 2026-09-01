import { MimeParseError, MimeTooLargeError, type NativeLocator } from "@trafficflow/core/mail";
import { parseRef } from "@trafficflow/core/adapters/imap";

/**
 * A throw that came out of THIS PROCESS'S DATABASE, whatever code it carries.
 *
 * ── WHY AN ORIGIN TAG EXISTS AT ALL ───────────────────────────────────────────────────────────
 *
 * {@link isDatabaseFault} below answers "is this the database's" from the error's `code`, and its
 * header records why that answer has to stay narrow. The limit is not fixable by enumerating more
 * codes. Measured against the real Postgres on :5433 while this tag was designed:
 *
 *   | injected fault                        | what postgres.js throws                        |
 *   |---------------------------------------|------------------------------------------------|
 *   | Postgres not listening                | `AggregateError`, `code: "ECONNREFUSED"`       |
 *   | pool `end()` under a live statement   | `Error`, `code: "CONNECTION_ENDED"`            |
 *   | `statement_timeout`                   | `PostgresError`, `code: "57014"`               |
 *   | dial into a blackhole                 | `Error`, `code: "EPERM"` / `"ETIMEDOUT"`       |
 *   | DNS gone                              | `Error`, `code: "ENOTFOUND"`                   |
 *   | wrong database name                   | `PostgresError`, `code: "3D000"`               |
 *
 * Rows 1, 4 and 5 are byte-identical, in `name` AND in `code`, to what a dead IMAP host throws —
 * and rows 1 and 4 are precisely "the database is down", the case the taxonomy exists for. The
 * information is not in the error; it is in WHERE THE CALL WAS MADE. So the hosted worker records
 * it there (`db-fault.ts`), and the cycle loop exempts BY CLASS.
 *
 * ── WHAT THE TAG DOES *NOT* DECIDE ────────────────────────────────────────────────────────────
 *
 * It names the ORIGIN and nothing else. "It came out of the database" is not "the database is at
 * fault": Postgres answering `23505` or `22021` is the database telling us about the VALUE this
 * mailbox's mail carried, which is per-message evidence and keeps its per-message verdict.
 * {@link classifyIngestFault} therefore unwraps this class before classifying, and
 * {@link isSharedDatabaseFault} subtracts exactly those two SQLSTATE classes back out. Tagging the
 * origin makes the domain question ANSWERABLE; it does not answer it.
 *
 * `cause` is always set and is always the original error, which is what makes the wrapper free to
 * log: `packages/core/src/log.ts#describeCause` walks the chain to the first layer carrying a
 * `code` and publishes `causeClass`/`causeCode` beside `errorClass`. An outage therefore reads
 * `errorClass: "DatabaseFaultError", causeClass: "AggregateError", causeCode: "ECONNREFUSED"` —
 * the wrapper says whose fault domain it is, the cause says what happened. That logger never
 * publishes a message, only those two grammars, which is why this one carries no detail.
 *
 * IT LIVES HERE RATHER THAN BESIDE THE WRAPPER because this module is in the desktop engine's
 * published source closure and the wrapper's module is not — see the header of `db-fault.ts`.
 */
export class DatabaseFaultError extends Error {
  /** Which database call threw — `"repo.commitChange"`, `"fence.transaction"`. Built from our own
   *  method names, never from anything a server chose. */
  readonly op: string;

  constructor(op: string, cause: unknown) {
    super(`the database failed at ${op}`, { cause });
    this.name = "DatabaseFaultError";
    this.op = op;
  }
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PER-MESSAGE TERMINAL-FAILURE LEDGER
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A batch contains ordinary message A, unprocessable message P, and later message B. Until this
 * file existed, a throw out of `planChange(P)` or `commitChange(P)` exited the ingest `for` loop:
 * no folder cursor advanced, nothing recorded that P had failed, and nothing declared it consumed.
 * The next cycle re-selected the same P and threw again, for ever. **B and every message behind it
 * were never processed** — one malformed message stopped organizing a mailbox permanently.
 *
 * THE MISSING PIECE WAS NOT A RETRY. Most of the failure paths a review of this loop examined
 * already retry; retrying is
 * precisely what turns a one-message defect into an indefinite outage. What was missing is a way
 * to record that something could not be done and MOVE PAST IT.
 *
 * ── THE RECORD IS DURABLE NOW (mail 0041), AND THAT CLOSED A MAIL-LOSS DEFECT ──────────────
 *
 * This header used to say the record was process-local, that a durable table was owed, and that a
 * restart re-attempting every skipped UID once was "a FEATURE" for five folders and "the one place
 * this design loses a message rather than delaying it" for the sixth. All three sentences were
 * true, and the last one was the bug:
 *
 *   The Sent folder's cursor is a UID WATERMARK — steady state is `UID FETCH <uidNext>:*`. A
 *   terminal skip puts the UID in the known-set, so the pass leaves nothing unknown, so the adapter
 *   publishes `mb.uidNext` PAST it. A restart empties this ledger; the UID is now below the
 *   watermark and is never enumerated again; and `own_copy` mail legitimately produces no
 *   `messages` row, so nothing else in the system can notice. A message the user actually sent left
 *   their mail client's view permanently, while the mailbox reported healthy throughout. Reproduced
 *   against a real IMAP server and a real database, not argued from the code.
 *
 * So this class is now the IN-CYCLE half of a two-part mechanism, and `message_failures` is the
 * durable half. What lives here is what must not be re-read per message: the attempt budget, the
 * per-cycle safety valve, and the known-set. What lives in the table is everything that has to
 * survive the process: the coordinate, the reason, the attempt count and when the UID is next owed
 * a look. {@link hydrate} is the join, run once at the top of every cycle.
 *
 * Two properties are worth stating because they are what make the durable half safe rather than
 * merely present:
 *
 *  · **The watermark still advances.** The retry is targeted BY UID
 *    (`MailboxAdapter.fetchByUid`), never by rescanning a folder, so the cursor is free to move and
 *    one bad message still cannot wedge a mailbox. Holding the watermark below the UID instead
 *    would re-fetch the poison body on every cycle for ever, which is the alternative that was
 *    rejected.
 *  · **The durable write is not best-effort.** `sync.ts` may only let a folder cursor cross a UID
 *    once the row is committed; a failed write turns the verdict back into `retry` (see
 *    {@link DeadLetterLedger.revoke}), which holds the cursor and fails the cycle. The `audit_log`
 *    row beside it stays best-effort, because losing evidence is not the same as losing mail.
 *
 * ── THE SKIPPED UID JOINS THE KNOWN-SET, AND THAT IS NOT AN OPTIMISATION ──────────────────
 *
 * `buildCursor` merges {@link DeadLetterLedger.knownFor} into each folder's known-set. Without it
 * the skipped UID stays "unknown" for ever, so the adapter re-FETCHES its body every cycle and
 * spends the batch budget on it; at the batch cap that sets `hasBacklog` on every pass and the
 * worker re-kicks itself in a tight loop. Joining the known-set is what makes "moved past" true
 * of the fetch as well as of the commit — and it is why hydrated rows join it too, including the
 * ones this cycle is about to retry: the targeted fetch asks for those bodies explicitly, and the
 * main batch must not ask for them again.
 */

/**
 * WHY A MESSAGE COULD NOT BE INGESTED — a CLOSED set, and never free text.
 *
 * Same contract `mailboxes.error_detail` is held to, and for the same reason — an account's mail
 * belongs to that account and to nobody else: a throw out of the ingest path can
 * embed RFC822 header bytes, a Postgres data-exception message quotes the offending row, and both
 * reach an `audit_log` payload the account owner's own tooling reads. Membership cannot be forged
 * by a mail server; a shape test can.
 */
export type MessageFailureCode =
  /** Raw source over {@link MimeTooLargeError}'s ceiling. Deterministic in the bytes. */
  | "mime_too_large"
  /** mailparser refused the source. Deterministic in the bytes. */
  | "mime_unparseable"
  /** Postgres class 22 — a VALUE the message carried is unstorable (a NUL, a bad date). */
  | "data_exception"
  /** Postgres class 23 — a constraint refused the row. NOT assumed deterministic. */
  | "constraint_violation"
  /** Anything we cannot name. Retried before it is ever skipped. */
  | "unclassified";

/** One terminally-skipped, or still-retrying, message. Content-free by construction. */
export interface MessageFailure {
  folder: string;
  uidValidity: string;
  uid: number;
  code: MessageFailureCode;
  attempts: number;
  firstFailedAt: Date;
  lastFailedAt: Date;
  /** True once the item has been declared consumed and the cursor may cross it. */
  terminal: boolean;
}

/**
 * WHOSE FAULT IS THIS THROW — the message's, or the infrastructure's?
 *
 * Getting this wrong in either direction loses something. Call a database outage "message-local"
 * and a shared incident silently writes off everybody's mail (blaming one mailbox for a shared
 * outage is the mailbox-level version of the same mistake). Call a poison message "infrastructure" and it is retried for ever,
 * which is the bug this whole file exists to end.
 */
export type IngestFault =
  | { domain: "infrastructure" }
  | { domain: "message"; code: MessageFailureCode; deterministic: boolean };

/**
 * Postgres SQLSTATE prefixes that mean OUR storage or connection failed.
 *
 * Deliberately by CLASS and not by individual code, the way `index.ts` exempts
 * `ClassifierFaultError` by class: a new member of class 08 that nobody has enumerated must land
 * on the infrastructure side by default, because the failure mode of guessing wrong there is
 * discarding somebody's mail.
 */
const INFRA_SQLSTATE_CLASSES: readonly string[] = [
  "08",   // connection_exception
  "25",   // invalid_transaction_state
  "40",   // transaction_rollback (serialization failure, deadlock) — retryable, never terminal
  "53",   // insufficient_resources (disk_full 53100 — an early production outage)
  "54",   // program_limit_exceeded (kept on the infra side; see `STORAGE_SQLSTATES`, mailboxes.ts)
  "57",   // operator_intervention (query_canceled, admin_shutdown)
  "58",   // system_error
  "XX",   // internal_error
];

/**
 * postgres.js's OWN non-SQLSTATE codes — unambiguously the database, whoever is asking.
 *
 * `CONNECT_TIMEOUT` is deliberately NOT here: imapflow@1.5.0 uses that exact string for a provider
 * dial that timed out (see `TIMEOUT_ERRNOS`, mailboxes.ts), so it cannot identify a domain on its
 * own.
 */
const PG_DRIVER_CODES: ReadonlySet<string> = new Set([
  "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "CONNECTION_CONNECT_TIMEOUT",
  "NOT_TAGGED_ERROR", "MAX_PARAMETERS_EXCEEDED",
]);

/**
 * Raw socket errnos. THESE DO NOT NAME A DOMAIN BY THEMSELVES, and that is the whole reason
 * {@link isDatabaseFault} exists separately from {@link classifyIngestFault}.
 *
 * On the INGEST path the only socket in play is the database's, so treating them as infrastructure
 * is right. At `attach()` the socket in play is the CUSTOMER'S PROVIDER, and an `ECONNREFUSED` from
 * a mailbox's own host is the most ordinary per-mailbox failure there is — `classifyMailboxError`
 * has always called it `connect` and quarantined that mailbox. Four worker tests caught exactly
 * this confusion the first time the two questions shared one predicate.
 */
const TRANSPORT_ERRNOS: ReadonlySet<string> = new Set([
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ESOCKETTIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "CONNECT_TIMEOUT",
]);

const sqlStateClass = (code: string): string | null =>
  /^[0-9A-Z]{5}$/.test(code) ? code.slice(0, 2) : null;

const codeOf = (err: unknown): string => {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : "";
};

/**
 * Classify one ingest throw. It MAY read the error's message; it may never store it — the output
 * is a five-value enum, exactly as `classifyMailboxError` is a seven-value one.
 *
 * Note what is NOT here: `ClassifierFaultError` and `LeaseUnavailableError`. Those are exempted BY
 * CLASS at their own arms in `index.ts` and must keep propagating untouched, so `sync.ts` rethrows
 * them before this function is ever called. Adding them here would convert a model outage into a
 * write-off of the mail it was asked to route.
 */
export function classifyIngestFault(err: unknown): IngestFault {
  // THE ORIGIN TAG IS UNWRAPPED FIRST, AND THIS LINE IS LOAD-BEARING.
  //
  // Since the worker wraps its repo (see `db-fault.ts`), every throw from a database call arrives
  // as a `DatabaseFaultError` whose `code` is undefined. Without this unwrap the fall-through at
  // the bottom would call each of them `{ message, unclassified }` — so an outage would spend two
  // attempts per message and then DECLARE THE MAIL CONSUMED. Tagging the origin would have
  // converted a database blip into mail loss, which is the exact failure this file exists to
  // prevent, reintroduced by the fix for a different one. The tag says WHERE the throw came from;
  // the domain question below is unchanged and still answered from what the database said.
  if (err instanceof DatabaseFaultError) return classifyIngestFault(err.cause);

  // Deterministic in the raw bytes, by the contract on `mime.ts`'s two typed errors: "the same
  // source fails the same way every time … what makes them safe for a quarantine record to treat
  // as permanent". This is the first consumer that contract was written for.
  if (err instanceof MimeTooLargeError) {
    return { domain: "message", code: "mime_too_large", deterministic: true };
  }
  if (err instanceof MimeParseError) {
    return { domain: "message", code: "mime_unparseable", deterministic: true };
  }

  const code = codeOf(err);
  if (code) {
    // ── A SERVER-CEILING BREACH IS THE HOST'S, NOT THE MESSAGE'S ─────────────────────────────
    //
    // `EIMAPBOUND` is the adapter's refusal when the mailbox's own IMAP server exceeds a ceiling
    // on a value IT chose — folders in a LIST, UIDs in an enumeration, hits in a SEARCH, bytes
    // past a declared `RFC822.SIZE`, or a wall clock. Nothing about it is evidence about a
    // message: usually no message has been read at all, and the ones that were are fine.
    //
    // Without this arm it fell to the catch-all at the bottom — `domain: "message"`,
    // `"unclassified"`, `deterministic: false`. That is retried twice and then WRITTEN OFF, so a
    // server tripping a ceiling every cycle would earn up to {@link MAX_DEAD_LETTERS_PER_CYCLE}
    // durable failure rows per cycle against messages that are still sitting on the server and
    // still perfectly readable — the durable lie this module's own contract exists to prevent.
    //
    // The infrastructure domain is what that outcome should be, by this file's own definition: it
    // "covers both sockets in play here — the customer's IMAP host and our own database — because
    // neither is the message's fault", so the row is left exactly as it was and the cycle fails.
    // Which is the correct answer: the MAILBOX is the unit of this failure, and the mailbox's
    // ordinary quarantine cadence is what makes it visible.
    //
    // Duck-typed on the code rather than by importing the error class, which is why that class
    // publishes one: this module has no business linking the IMAP adapter.
    //
    // ── NOT EVERY BOUND, AND THE EXCLUSION IS NOT TIDINESS ───────────────────────────────────
    //
    // This function ALSO backs `sync.ts`'s `isTransportFailure`, so the mapping changes
    // RECONCILIATION as well as ingest — and the transport arm leaves a `folder_state` row
    // immediately due with its attempt count unchanged, which is right for a host that is down
    // and wrong for a condition that will not clear on its own.
    //
    // `candidate_body_probes` is exactly such a condition: the destination holds more messages
    // sharing one Message-ID than the pre-check can disambiguate. Nothing about waiting fixes
    // that. Routed to transport it would re-run the same SEARCH every cycle for ever, never
    // entering the widening backoff the reconciler has for precisely this. It keeps the message
    // domain, where it earns retries and then a durable record an operator can see.
    //
    // Every other bound IS the host misbehaving — a flood, an over-large body, a clock — and
    // those are transport by the same argument the errno set above is.
    if (code === "EIMAPBOUND" && (err as { bound?: unknown }).bound !== "candidate_body_probes") {
      return { domain: "infrastructure" };
    }
    // Both sets, because on the ingest path the only socket is the database's.
    if (PG_DRIVER_CODES.has(code) || TRANSPORT_ERRNOS.has(code)) return { domain: "infrastructure" };
    const cls = sqlStateClass(code);
    if (cls) {
      if (INFRA_SQLSTATE_CLASSES.includes(cls)) return { domain: "infrastructure" };
      // Class 22 is a DATA exception: the value this message carried cannot be stored (a decoded
      // NUL in a subject, a date outside the timestamp range). Deterministic in the bytes, so it
      // needs no second attempt to prove itself.
      if (cls === "22") return { domain: "message", code: "data_exception", deterministic: true };
      // Class 23 is a constraint. `23505` can also be a concurrent second ingest of the same mail
      // rather than a defect in it, so this one earns its retries before it is written off.
      if (cls === "23") return { domain: "message", code: "constraint_violation", deterministic: false };
    }
  }

  // Everything else, INCLUDING a bug in our own pipeline. Retried first, and skipped only under
  // {@link MAX_DEAD_LETTERS_PER_CYCLE} — see the cap for why a broken build must not go green.
  return { domain: "message", code: "unclassified", deterministic: false };
}

/**
 * Is this throw UNAMBIGUOUSLY THE DATABASE'S — not one mailbox's provider?
 *
 * `attach()` is the consumer. The credential read now sits inside that function's
 * isolation boundary, so without an exemption one database blip would quarantine every mailbox of the
 * shard in turn and write `status='error'` on each — a measured incident's shape.
 *
 * It is deliberately NARROWER than {@link classifyIngestFault}'s infrastructure domain, and the
 * narrowness is load-bearing: SQLSTATEs and postgres.js's own code names only, never a raw errno.
 * At this seam an `ECONNREFUSED` is far more likely to be the customer's IMAP host than our
 * database, and treating it as ours would stop quarantining genuinely unreachable mailboxes.
 *
 * The residual, stated: postgres.js surfaces a bare `ECONNREFUSED` when Postgres itself is down, so
 * a total database outage at this line is still rendered as a per-mailbox connect failure. It is
 * self-clearing, and mis-blaming a reachable mailbox for our outage is strictly less harmful than
 * refusing to quarantine an unreachable one.
 *
 * THE ORIGIN-TAGGING FIX CLOSED THAT RESIDUAL ON THE CYCLE PATH AND DELIBERATELY LEFT IT HERE.
 * The cycle path's
 * database calls all go through a wrapped repo, so their origin is recorded and no code has to be
 * guessed at ({@link isSharedDatabaseFault}, `db-fault.ts`). The one call this seam makes —
 * `loadMailboxCreds` — is not wrapped, because it reads a row AND decrypts the envelope in it, and
 * a credential that will not decrypt is the most per-mailbox failure there is: tagging the whole
 * call would promote a bad envelope to a shard-wide condition, which is this defect wearing the
 * opposite sign. So this function keeps the narrow question, and this paragraph stays true of
 * `attach()` alone.
 */
export function isDatabaseFault(err: unknown): boolean {
  // An ORIGIN tag outranks any code, because it is the one thing a code cannot say. See
  // `db-fault.ts` for the measurement: three of the six database faults this worker can suffer
  // are byte-identical, in `name` and in `code`, to a dead IMAP host.
  if (err instanceof DatabaseFaultError) return true;
  const code = codeOf(err);
  if (!code) return false;
  if (PG_DRIVER_CODES.has(code)) return true;
  const cls = sqlStateClass(code);
  return cls !== null && INFRA_SQLSTATE_CLASSES.includes(cls);
}

/**
 * SQLSTATE classes in which Postgres is answering about the VALUE WE SENT, not about itself.
 *
 * The same two {@link classifyIngestFault} maps to the message domain, and named here rather than
 * derived from it because the two questions are genuinely different: that one asks "may this
 * message be written off", this one asks "may this mailbox be quarantined". They agree today, and
 * a change to either must be an explicit change to both.
 */
const DATA_SQLSTATE_CLASSES: readonly string[] = [
  "22",   // data_exception — a decoded NUL in a subject, a timestamp out of range
  "23",   // integrity_constraint_violation
];

/**
 * Is this throw about a dependency THE WHOLE SHARD SHARES — and therefore never about the mailbox
 * that happened to be mid-cycle when it landed?
 *
 * This is the cycle loop's question and it is deliberately not
 * {@link classifyIngestFault}'s. That one calls the customer's IMAP host "infrastructure" too,
 * which is right where it is used — neither socket is the MESSAGE's fault — and would be wrong
 * here, because a provider that will not answer is exactly what quarantine is for. Widening this
 * predicate to `classifyIngestFault(err).domain === "infrastructure"` is the inverse defect: it
 * dissolves mailbox isolation — the property quarantine exists to protect — and `connection-error.e2e.test.ts` and
 * `mailbox-failure.e2e.test.ts` are the two guards that go red when it is tried.
 *
 * Two arms, and the asymmetry between them is the conservative boundary:
 *
 *  · TAGGED — the throw came out of `SyncDeps.repo` or the fence's transaction, so the origin is
 *    settled. It is shared UNLESS Postgres named a data class, which is the database reporting on
 *    this mailbox's own mail and keeps its per-message cadence.
 *  · UNTAGGED — no origin, so back to {@link isDatabaseFault}'s NARROW code-only question, which
 *    admits SQLSTATEs and postgres.js's own names and refuses every raw errno. An ambiguous
 *    timeout therefore stays a per-mailbox fault, which is the status quo and the safe direction:
 *    a missed exemption costs a self-clearing quarantine, a wrong one costs isolation.
 */
export function isSharedDatabaseFault(err: unknown): boolean {
  if (err instanceof DatabaseFaultError) {
    const cls = sqlStateClass(codeOf(err.cause));
    return cls === null || !DATA_SQLSTATE_CLASSES.includes(cls);
  }
  return isDatabaseFault(err);
}

/**
 * How many times a NON-deterministic message-local failure is retried before it is written off.
 *
 * Two, not three, and the arithmetic is deliberate: `DEFAULT_MAX_SYNC_FAILURES` is 3, so a poison
 * message that defers on cycle 1 and goes terminal on cycle 2 never reaches the mailbox-level
 * quarantine threshold. At three attempts the terminal cycle and the quarantine cycle collide and
 * whether the mailbox is detached depends on which counter is compared first.
 */
export const DEFAULT_MAX_MESSAGE_ATTEMPTS = 2;

/**
 * THE SAFETY VALVE: how many messages ONE cycle may terminally skip.
 *
 * Without it, a bug in our own pipeline that throws for every message would — after
 * {@link DEFAULT_MAX_MESSAGE_ATTEMPTS} cycles — write off the entire batch, advance the cursor,
 * and report SUCCESS. The mailbox would go green in Settings while dropping every message that
 * arrived. Beyond this cap the surplus stays deferred (not consumed), the folder cursor is held,
 * and the cycle fails — so `maxSyncFailures` quarantines the mailbox and an operator sees it.
 *
 * Five and not one, because a mailbox with a handful of genuinely poison messages must still
 * drain: the cap bounds how much a single cycle can write off, not how much ever can.
 */
export const MAX_DEAD_LETTERS_PER_CYCLE = 5;

/**
 * How many written-off UIDs ONE cycle may re-read by UID.
 *
 * Small on purpose, and for a different reason from {@link MAX_DEAD_LETTERS_PER_CYCLE}. That cap
 * bounds how much a broken build may WRITE OFF; this one bounds how much a cycle spends looking
 * BACKWARDS. A mailbox with a thousand owed UIDs must not spend its cycle re-reading history while
 * new mail waits behind it — the retry rides at the end of the cycle, after the cursors are
 * written, so the mailbox drains regardless and the backlog of owed UIDs clears at five a cycle.
 */
export const MAX_MESSAGE_RETRIES_PER_CYCLE = 5;

/**
 * Attempts after which a still-failing message is ESCALATED — reported rather than merely retried.
 *
 * Three, and the number is chosen against the retry schedule rather than picked: a deterministic
 * failure gets exactly one attempt per deployed build (see {@link nextAttemptAfter}), so three
 * attempts is three separate builds that could not read the message. That is the point at which
 * "the next deploy might fix it" has stopped being a plausible explanation and somebody should be
 * told. A non-deterministic one reaches it inside a day on the backoff below.
 *
 * Escalation does NOT stop the retrying, and that distinction is deliberate: a message the product
 * cannot read must become VISIBLE, not abandoned, because the deploy that fixes it may still be
 * weeks away and the cost of one targeted probe per build is a size fetch.
 */
export const ESCALATE_AFTER_ATTEMPTS = 3;

/**
 * WHEN a failed UID is next owed a CLOCK-scheduled look, or `null` for "not on a clock".
 *
 * Deterministic failures are `null`, and that is the whole schedule decision. `MimeTooLargeError`
 * and `MimeParseError` carry the contract that "the same source fails the same way every time", so
 * no instant in the future is a better time to try than now was — an hourly backoff over them would
 * re-download a body it is about to refuse, on a schedule, for the life of the account. The only
 * event that can change the answer is NEW CODE, and that is the version arm of the due predicate in
 * `claimMessageFailures`, which needs no timestamp.
 *
 * The non-deterministic pair (`constraint_violation`, `unclassified`) does get a clock, doubling
 * from an hour and capped at a day: `23505` can be a concurrent second ingest rather than a defect,
 * and `unclassified` may be our own transient bug, so both are worth re-trying without waiting for
 * a deploy. Capped at a day so a permanent one is still probed occasionally rather than
 * exponentiating into never.
 */
export function nextAttemptAfter(
  code: MessageFailureCode, attempts: number, now: Date,
): Date | null {
  if ((DETERMINISTIC_MESSAGE_FAILURE_CODES as readonly string[]).includes(code)) {
    return null;
  }
  const hours = Math.min(24, 2 ** Math.max(0, attempts - 1));
  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

/**
 * The codes whose failure is a function of the MESSAGE BYTES — retrying them on a clock re-runs
 * the identical computation on identical input, so their `next_attempt_at` is NULL and their next
 * look is a NEW BUILD (the `attempted_version` arm of `claimMessageFailures`' due-predicate).
 *
 * Exported because the CLAIM needs the same list: `claimMessageFailures` stamps the next clock
 * instant in the same statement that claims the row, and for years it stamped the generic hourly
 * schedule onto every row regardless of code — so a `mime_too_large` message was size-probed once
 * an hour for ever (a production row reached 297 attempts; its comment promised "null for the
 * deterministic codes" while the code passed the hourly date unconditionally). The repo method
 * cannot import this app's types, so the caller passes this list and this is its one definition.
 */
export const DETERMINISTIC_MESSAGE_FAILURE_CODES = [
  "mime_too_large", "mime_unparseable", "data_exception",
] as const satisfies readonly MessageFailureCode[];

/**
 * The ledger's in-memory identity for one message coordinate — and it is DELIMITED, because the
 * three parts are variable-length and a folder name is chosen by the mail server.
 *
 * The first version was `${folder}${uidValidity}${uid}`, and concatenating variable-length parts
 * with no separator is ambiguous by construction: `("Notes1", "2", 34)` and `("Notes", "12", 34)` both
 * produce `Notes1234`. That is not a theoretical collision, because it decides whether a message is
 * SKIPPED — `has()` answers `terminal` for the colliding entry, `runSyncCycle` skips the message
 * without parsing or committing it, and on a UID-watermarked folder such as Sent nothing
 * enumerates it again. So one malformed message could make a perfectly good one at an unrelated
 * coordinate permanently invisible, and the durable failure row would describe the other message.
 *
 * `JSON.stringify` of the tuple rather than a chosen separator character: every separator that is
 * legal in an IMAP folder name is a separator an adversarial or merely unusual server can put IN
 * the folder name, and JSON escapes what it must. The key is a Map key and nothing else — it is
 * never persisted, never parsed back, and never shown — so the encoding is free to be verbose.
 */
const keyOf = (folder: string, uidValidity: string, uid: number): string =>
  JSON.stringify([folder, uidValidity, uid]);

/**
 * The ledger itself: per mailbox, held on the `MailboxRuntime`'s `SyncDeps` so it lives as long as
 * the attachment does.
 */
export class DeadLetterLedger {
  private readonly items = new Map<string, MessageFailure>();
  private readonly maxAttempts: number;
  private readonly perCycleCap: number;
  /** Terminal decisions taken in the CURRENT cycle; reset by {@link beginCycle}. */
  private thisCycle = 0;

  constructor(opts: { maxAttempts?: number; perCycleCap?: number } = {}) {
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_MESSAGE_ATTEMPTS);
    this.perCycleCap = Math.max(1, opts.perCycleCap ?? MAX_DEAD_LETTERS_PER_CYCLE);
  }

  /** Called once at the top of every sync cycle, so the per-cycle cap is per cycle. */
  beginCycle(): void { this.thisCycle = 0; }

  /**
   * Load the DURABLE rows for this mailbox into the ledger — the join between the two halves,
   * called once at the top of every cycle from `runSyncCycle`.
   *
   * Every hydrated row is `terminal: true`, because a row exists only for a UID a cursor has
   * already been allowed to cross. That is what puts it in {@link knownFor} and keeps its body out
   * of the main batch.
   *
   * ── IT NEVER LOWERS AN ATTEMPT COUNT, AND THE `max` IS THE REASON ──────────────────────────
   *
   * A row already held in memory keeps the higher of the two counts. The in-memory count can be
   * ahead legitimately — a non-deterministic failure that has failed twice this process and not yet
   * been written off has no row at all — and taking the database's number would reset a budget the
   * process has already spent, which is how a poison message earns unlimited attempts one restart
   * at a time.
   *
   * ── AND IT IS CALLED FOR ITS SIDE EFFECT ON THE KNOWN-SET, NOT FOR A RETURN VALUE ──────────
   *
   * The caller does not read what this loaded. `buildCursor` reads the ledger afterwards, so a
   * hydration that silently loaded nothing looks exactly like a mailbox with no failures — which is
   * why `runSyncCycle` lets a hydration THROW rather than catching it. A cycle that cannot read this
   * table must not proceed to publish a watermark on the assumption that nothing is owed.
   */
  hydrate(rows: ReadonlyArray<{
    folder: string; uidValidity: string; uid: number; code: string; attempts: number;
  }>): void {
    for (const r of rows) {
      const key = keyOf(r.folder, r.uidValidity, r.uid);
      const prev = this.items.get(key);
      const now = new Date();
      this.items.set(key, {
        folder: r.folder,
        uidValidity: r.uidValidity,
        uid: r.uid,
        code: isMessageFailureCode(r.code) ? r.code : "unclassified",
        attempts: Math.max(r.attempts, prev?.attempts ?? 0),
        firstFailedAt: prev?.firstFailedAt ?? now,
        lastFailedAt: prev?.lastFailedAt ?? now,
        terminal: true,
      });
    }
  }

  /**
   * TAKE BACK a terminal decision, because the durable record of it could not be written.
   *
   * The one caller is `sync.ts`, on a failed `recordMessageFailure`. Without this the ledger would
   * hold `terminal: true` for a UID no table knows about, the folder cursor would be allowed to
   * cross it, and the loss this durable record exists to close would be back — reachable through a
   * database hiccup instead of through a restart.
   *
   * The per-cycle cap slot is returned with it: a decision that did not stick did not spend one, and
   * charging for it would make a run of write failures silently lower the number of genuine
   * write-offs a cycle can make.
   */
  revoke(locator: NativeLocator): void {
    const { uidValidity, uid } = parseRef(locator.ref);
    const item = this.items.get(keyOf(locator.folder, uidValidity, uid));
    if (!item?.terminal) return;
    item.terminal = false;
    if (this.thisCycle > 0) this.thisCycle--;
  }

  /** Close an item out: it was ingested, or the server no longer has it, or its epoch is void. */
  forget(folder: string, uidValidity: string, uid: number): void {
    this.items.delete(keyOf(folder, uidValidity, uid));
  }

  /**
   * Record one failed change. Returns `"skip"` when the item is now CONSUMED — the batch may
   * continue past it and the folder cursor may cross it — or `"retry"` when it is not, in which
   * case the caller must hold that folder's cursor and fail the cycle.
   */
  record(locator: NativeLocator, fault: { code: MessageFailureCode; deterministic: boolean }): "skip" | "retry" {
    const { uidValidity, uid } = parseRef(locator.ref);
    const key = keyOf(locator.folder, uidValidity, uid);
    const now = new Date();
    const prev = this.items.get(key);
    const item: MessageFailure = prev
      ? { ...prev, code: fault.code, attempts: prev.attempts + 1, lastFailedAt: now }
      : {
        folder: locator.folder, uidValidity, uid: Number.isFinite(uid) ? uid : 0,
        code: fault.code, attempts: 1, firstFailedAt: now, lastFailedAt: now, terminal: false,
      };
    this.items.set(key, item);

    if (item.terminal) return "skip";                       // already written off; do not re-count
    const exhausted = fault.deterministic || item.attempts >= this.maxAttempts;
    if (!exhausted) return "retry";
    if (this.thisCycle >= this.perCycleCap) return "retry";  // the safety valve, above
    this.thisCycle++;
    item.terminal = true;
    return "skip";
  }

  /** Is this UID already written off? */
  has(folder: string, uidValidity: string, uid: number): boolean {
    return this.items.get(keyOf(folder, uidValidity, uid))?.terminal === true;
  }

  /**
   * The terminally-skipped UIDs of one folder AT ONE EPOCH, shaped for the adapter's known-set.
   *
   * Epoch-filtered for the same reason `buildCursor` filters real locators (finding 2): a UID
   * number written off under one UID epoch must not silence a different message that reuses that
   * number under a later epoch.
   *
   * `messageId: null` deliberately — we never parsed the message, so we have no Message-ID, and
   * inventing one would let `correlateMoves` pair a skipped UID with an unrelated create.
   */
  knownFor(folder: string, uidValidity: string): Array<{ uid: number; messageId: string | null }> {
    const out: Array<{ uid: number; messageId: string | null }> = [];
    for (const it of this.items.values()) {
      if (it.terminal && it.folder === folder && it.uidValidity === uidValidity) {
        out.push({ uid: it.uid, messageId: null });
      }
    }
    return out;
  }

  /** How many messages this mailbox has written off. Evidence for `/health` and the logs. */
  get skipped(): number {
    let n = 0;
    for (const it of this.items.values()) if (it.terminal) n++;
    return n;
  }

  /**
   * How many of them have now failed {@link ESCALATE_AFTER_ATTEMPTS} times — the number an operator
   * needs, and the one `/health` publishes as `escalatedMessages`.
   *
   * Derived from `attempts` rather than stored as a flag, so it cannot disagree with the counter it
   * is about. It is a count of the CURRENT mailbox's attachment: the health endpoint sums it across
   * `runtimes`, which is also why this reads memory and issues no query — `startHealthServer`
   * touches no database by design, so a probe can never add load or block on Postgres.
   */
  get escalated(): number {
    let n = 0;
    for (const it of this.items.values()) {
      if (it.terminal && it.attempts >= ESCALATE_AFTER_ATTEMPTS) n++;
    }
    return n;
  }

  entries(): MessageFailure[] { return [...this.items.values()]; }
}

/** Is `code` a member of the closed set? A stored value outside it reads as `unclassified`. */
function isMessageFailureCode(code: string): code is MessageFailureCode {
  return code === "mime_too_large" || code === "mime_unparseable"
    || code === "data_exception" || code === "constraint_violation" || code === "unclassified";
}
