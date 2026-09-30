import { MimeParseError, MimeTooLargeError, type NativeLocator } from "@trafficflow/core/mail";
import { epochOf, parseRef, sameEpoch } from "@trafficflow/core/adapters/imap";

/**
 * A throw that came out of THIS PROCESS'S DATABASE, whatever code it carries. {@link isDatabaseFault}
 * answers "is this the database's" from `code`, and must stay narrow: measured against real Postgres on
 * :5433, a down database throws `ECONNREFUSED`/`EPERM`/`ETIMEDOUT`/`ENOTFOUND` — byte-identical to a
 * dead IMAP host — while `CONNECTION_ENDED`, `57014`, `3D000` are its own. The information is in WHERE
 * THE CALL WAS MADE, so the worker records origin there (`db-fault.ts`) and the cycle loop exempts BY
 * CLASS. The tag names ORIGIN only: Postgres answering `23505`/`22021` is per-message, so
 * {@link classifyIngestFault} unwraps this class first and {@link isSharedDatabaseFault} subtracts those
 * SQLSTATE classes back out. `cause` is always the original (`log.ts#describeCause` publishes
 * `causeClass`/`causeCode`). Lives here because this module is in the desktop engine's published closure. */
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
 * THE PER-MESSAGE TERMINAL-FAILURE LEDGER. A throw out of `planChange(P)`/`commitChange(P)` used to exit
 * the ingest loop, so message B and everything behind P was never processed — one malformed message
 * stopped organizing a mailbox permanently. The fix was not a retry but a way to record a failure and
 * MOVE PAST IT, now durable (mail 0041): `message_failures` is the durable half, this class the in-cycle
 * half, joined by {@link hydrate} once per cycle. It closed a mail-loss defect where a Sent UID watermark
 * (`UID FETCH <uidNext>:*`) let a process-local skip advance the cursor past `own_copy` mail with no
 * `messages` row. Two safety properties: the watermark still advances (retry is BY UID,
 * `MailboxAdapter.fetchByUid`), and the durable write is not best-effort (a failed write becomes
 * {@link DeadLetterLedger.revoke} `retry`; the `audit_log` row stays best-effort). The skipped UID joins {@link knownFor} via `buildCursor`, so its body leaves the batch and `hasBacklog` does not spin. */

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
    // A SERVER-CEILING BREACH IS THE HOST'S, NOT THE MESSAGE'S. `EIMAPBOUND` is the adapter's refusal
    // when the mailbox's IMAP server exceeds a ceiling IT chose (folders in a LIST, UIDs, SEARCH hits,
    // `RFC822.SIZE`, a clock); usually no message was read and the ones that were are fine. Without
    // this arm it fell to the catch-all (`domain: "message"`, `"unclassified"`), retried twice then
    // WRITTEN OFF — up to {@link MAX_DEAD_LETTERS_PER_CYCLE} durable failure rows/cycle against readable
    // mail. The infrastructure domain is correct (neither socket is the message's fault), so the row is
    // left as-is and the cycle fails; the mailbox's quarantine cadence makes it visible. Duck-typed on
    // the code, not by importing the error class. NOT every bound: this also backs `sync.ts`'s
    // `isTransportFailure`, and `candidate_body_probes` (a Message-ID the pre-check cannot disambiguate)
    // keeps the message domain so it enters the reconciler's widening backoff rather than re-SEARCHing.
    if (code === "EIMAPBOUND" && (err as { bound?: unknown }).bound !== "candidate_body_probes") {
      return { domain: "infrastructure" };
    }
    // ── AN UNKNOWN UIDVALIDITY IS THE MAILBOX'S CONDITION, BY THE SAME ARGUMENT ─────────────
    //
    // `EIMAPEPOCHUNKNOWN` is the adapter refusing a locator-addressed command because the server
    // named no UIDVALIDITY for the selected folder (or named zero, which RFC 3501 forbids). No
    // message has been read and none is at fault: the mailbox's own host cannot answer the one
    // question that makes a UID mean anything. Left to the catch-all it would be retried twice
    // and then written off as a durable failure of mail that is still on the server, which is the
    // lie this module exists to prevent. Duck-typed on the code, like the bound above.
    if (code === "EIMAPEPOCHUNKNOWN") return { domain: "infrastructure" };
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
 * Is this throw UNAMBIGUOUSLY THE DATABASE'S — not one mailbox's provider? `attach()` is the consumer,
 * and the credential read sits inside its isolation boundary, so without an exemption one database blip
 * would quarantine every mailbox of the shard (`status='error'`). Deliberately NARROWER than
 * {@link classifyIngestFault}: SQLSTATEs and postgres.js's own code names only, never a raw errno (at
 * this seam an `ECONNREFUSED` is more likely the customer's IMAP host than our database). The residual:
 * postgres.js surfaces a bare `ECONNREFUSED` when Postgres is down, so a total outage reads as a per-
 * mailbox connect failure (self-clearing). The cycle path closed that via origin tagging
 * ({@link isSharedDatabaseFault}, `db-fault.ts`); the one call this seam makes, `loadMailboxCreds`, is
 * not wrapped (a credential that will not decrypt is the most per-mailbox failure there is). */
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
 * Is this throw about a dependency THE WHOLE SHARD SHARES — never about the mailbox mid-cycle when it
 * landed? The cycle loop's question, deliberately not {@link classifyIngestFault}'s (that calls the
 * customer's IMAP host "infrastructure", right there and wrong here — a provider that will not answer is
 * what quarantine is for). Widening this to that domain is the inverse defect (it dissolves mailbox
 * isolation; `connection-error.e2e.test.ts` and `mailbox-failure.e2e.test.ts` go red). Two arms: TAGGED
 * — from `SyncDeps.repo` or the fence's transaction, so shared UNLESS Postgres named a data class
 * (per-message cadence); UNTAGGED — back to {@link isDatabaseFault}'s narrow code-only question, so an
 * ambiguous timeout stays a per-mailbox fault (a missed exemption costs a self-clearing quarantine, a
 * wrong one costs isolation). */
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
 * THE SAFETY VALVE: how many messages ONE cycle may terminally skip. Without it a bug in our own
 * pipeline that throws for every message would — after {@link DEFAULT_MAX_MESSAGE_ATTEMPTS} cycles —
 * write off the whole batch, advance the cursor and report SUCCESS, the mailbox green while dropping
 * every message. Beyond this cap the surplus stays deferred (not consumed), the folder cursor is held
 * and the cycle fails, so `maxSyncFailures` quarantines the mailbox. Five, not one, because a mailbox
 * with a handful of genuinely poison messages must still drain: the cap bounds how much one cycle can
 * write off, not how much ever can.
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
 * Three, chosen against the retry schedule: a deterministic failure gets exactly one attempt per
 * deployed build (see {@link nextAttemptAfter}), so three attempts is three separate builds that could
 * not read the message — the point where "the next deploy might fix it" has stopped being plausible. A
 * non-deterministic one reaches it inside a day on the backoff. Escalation does NOT stop the retrying:
 * a message the product cannot read must become VISIBLE, not abandoned, because the deploy that fixes
 * it may be weeks away and one targeted probe per build is a size fetch.
 */
export const ESCALATE_AFTER_ATTEMPTS = 3;

/**
 * WHEN a failed UID is next owed a CLOCK-scheduled look, or `null` for "not on a clock". Deterministic
 * failures are `null`: `MimeTooLargeError` and `MimeParseError` carry "the same source fails the same
 * way every time", so no future instant is better than now — an hourly backoff would re-download a body
 * it is about to refuse for the life of the account. The only event that changes the answer is NEW CODE,
 * which is the version arm of the due predicate in `claimMessageFailures` (no timestamp needed). The
 * non-deterministic pair (`constraint_violation`, `unclassified`) does get a clock, doubling from an hour
 * and capped at a day: `23505` can be a concurrent second ingest and `unclassified` our own transient
 * bug, both worth re-trying without a deploy; capped so a permanent one is still probed occasionally.
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
 * The codes whose failure is a function of the MESSAGE BYTES — retrying on a clock re-runs the identical
 * computation on identical input, so their `next_attempt_at` is NULL and their next look is a NEW BUILD
 * (the `attempted_version` arm of `claimMessageFailures`' due-predicate). Exported because the CLAIM
 * needs the same list: `claimMessageFailures` stamps the next clock instant in the statement that claims
 * the row, and for years it stamped the generic hourly schedule regardless of code — so a
 * `mime_too_large` message was size-probed hourly for ever (a production row reached 297 attempts). The
 * repo method cannot import this app's types, so the caller passes this list; this is its one definition.
 */
export const DETERMINISTIC_MESSAGE_FAILURE_CODES = [
  "mime_too_large", "mime_unparseable", "data_exception",
] as const satisfies readonly MessageFailureCode[];

/**
 * The ledger's in-memory identity for one message coordinate — DELIMITED, because the three parts are
 * variable-length and a folder name is chosen by the mail server. The first version was
 * `${folder}${uidValidity}${uid}`, and concatenating variable-length parts with no separator is
 * ambiguous: `("Notes1","2",34)` and `("Notes","12",34)` both make `Notes1234`. That decides whether a
 * message is SKIPPED — `has()` answers `terminal`, `runSyncCycle` skips it, and on a UID-watermarked
 * folder such as Sent nothing enumerates it again — so one malformed message could make a good one
 * permanently invisible. `JSON.stringify` of the tuple, not a chosen separator, because every separator
 * legal in an IMAP folder name can appear IN one; a Map key only (never persisted, parsed or shown), so
 * the encoding is free to be verbose. */
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
   * Load the DURABLE rows for this mailbox into the ledger — the join between the two halves, called
   * once at the top of every cycle from `runSyncCycle`. Every hydrated row is `terminal: true` (a row
   * exists only for a UID a cursor was already allowed to cross), which puts it in {@link knownFor} and
   * keeps its body out of the main batch. It NEVER lowers an attempt count — a row held in memory keeps
   * the higher (`max`), because the in-memory count can legitimately be ahead and taking the database's
   * number would reset a spent budget, earning a poison message unlimited attempts one restart at a
   * time. Called for its side effect on the known-set, not a return: `buildCursor` reads the ledger
   * afterwards, so `runSyncCycle` lets a hydration THROW rather than publish a watermark on the
   * assumption that nothing is owed. */
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
   * TAKE BACK a terminal decision, because the durable record of it could not be written. The one
   * caller is `sync.ts`, on a failed `recordMessageFailure`. Without this the ledger would hold
   * `terminal: true` for a UID no table knows about, the folder cursor would be allowed to cross it, and
   * the loss this durable record exists to close would be back — reachable through a database hiccup
   * instead of a restart. The per-cycle cap slot is returned with it: a decision that did not stick did
   * not spend one, and charging for it would make a run of write failures silently lower how many
   * genuine write-offs a cycle can make.
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
      if (it.terminal && it.folder === folder && sameEpoch(epochOf(it.uidValidity), epochOf(uidValidity))) {
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
