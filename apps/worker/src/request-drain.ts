import { createHash } from "node:crypto";
import {
  applyScreenerDecision, AccountErasedError, validateRequestPayload, claimIdempotencyKey,
  applyMessageMove, validateMovePayload, type MoveRefusal,
  applyProfileUpdate, validateProfileUpdatePayload,
  applyRuleRequest, validateRulePayload, settleReaderRuleRows, type RuleRefusal,
  readIdempotencyKey, IDEMPOTENCY_TTL_MS, readAccountErasedAt,
  listPendingRequests, listSentRequests, markRequestsSent, markRequestsApplied,
  listStaleSentRequests, markRequestsExpired, markRequestsRefused, mailboxRowsHeld,
  type Tx,
} from "@trafficflow/db";
import { carryDialect, dialect } from "@trafficflow/db/dialect";
import {
  parseRequestEnvelope, isMalformedRequest, formatRequest, formatAck, canonicalRequest, isRequestKind,
  requestEnvelopesIn, acksIn, verifyRequestEnvelope, decodeRequestPayload,
  REQUEST_PROTOCOL, requestAppendHeadroom,
  type RequestReaderIo, type RequestOrganizerIo, type RawMetaMessage,
  type RequestEnvelope, type RequestRecord, type AckRecord, type OrganizerKind,
  type RequestRefusalReason, isRequestRefusalReason, LeaseUnavailableError,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";

/**
 * The dispatch table — one entry per kind this build carries out: `screener.decide`, `message.move`,
 * the three `rule.*` kinds and `profile.update` (mail 0094). Each entry RETURNS A CLOSURE: the handler
 * validates the payload and hands back the applier already bound to it, so "this kind's applier
 * receives that kind's payload" is not expressible. `null` means the payload failed validation,
 * answered `invalid_payload`. A kind with no entry (a newer install's) LEAVES THE RECORD STANDING,
 * so it applies once this organizer updates.
 */
interface HandlerContext {
  accountId: string;
  mailboxId: string;
  requestId: string;
  now: Date;
}

/** Applied, or not applied for a named reason the reader is told. */
type ApplyOutcome = { applied: true } | { applied: false; reason: RequestRefusalReason };

/** Runs inside the drain's own transaction, after the fence and the idempotency claim. */
type BoundApplier = (tx: Tx) => Promise<ApplyOutcome>;

/** Validate this kind's payload and bind its applier, or `null` for `invalid_payload`. */
type KindHandler = (payload: unknown, ctx: HandlerContext) => BoundApplier | null;

/**
 * An applier that ran and could not carry the action out. THROWN rather than returned so the
 * enclosing transaction rolls back — the idempotency key claimed moments earlier must not outlive
 * an apply that wrote nothing, or the next cycle reads the key, concludes the record was already
 * taken, and acks the reader `applied` for something that never happened.
 */
class ApplierRefusedError extends Error {
  constructor(readonly reason: RequestRefusalReason) {
    super(`the applier refused: ${reason}`);
    this.name = "ApplierRefusedError";
  }
}

/**
 * The applier's own word, mapped onto the channel's closed vocabulary. A `Record` over `MoveRefusal`
 * rather than a cast or passthrough: the applier's outcomes and the wire's refusal words are two closed
 * sets that happen to agree today, and a new applier outcome without a decision about what the reader
 * is told would otherwise compile. Both members are `REQUEST_REFUSAL_REASONS` members since mail 0094,
 * and the database's own CHECK holds that true — `request-refusal-closed.pg.test.ts` reads the
 * vocabulary from this code, so a word added here and not to the constraint is red on a real server
 * rather than a row rejected at the moment the drain tries to record a refusal.
 */
const MOVE_REFUSAL_REASON: Readonly<Record<MoveRefusal, RequestRefusalReason>> = {
  no_such_message: "no_such_message",
  no_trash_folder: "no_trash_folder",
};

/** The rule applier's own word, mapped the same way and for the same reason. */
const RULE_REFUSAL_REASON: Readonly<Record<RuleRefusal, RequestRefusalReason>> = {
  no_such_rule: "no_such_rule",
};

/**
 * ONE HANDLER FOR THE THREE `rule.*` KINDS, because they share one applier and one table — which
 * is also why they share one capability. The kind is passed through to the validator, so a
 * `rule.delete` carrying a create's body is refused rather than half-read.
 */
const ruleHandler = (kind: string): KindHandler => (payload, ctx) => {
  const req = validateRulePayload(kind, payload);
  if (!req) return null;
  return async (tx) => {
    const r = await applyRuleRequest(tx, { accountId: ctx.accountId, payload: req, now: ctx.now });
    if (r.applied) return { applied: true };
    return { applied: false, reason: RULE_REFUSAL_REASON[r.refusal] };
  };
};

const KIND_HANDLERS: Readonly<Record<string, KindHandler | undefined>> = {
  "screener.decide": (payload, ctx) => {
    const decision = validateRequestPayload(payload);
    if (!decision) return null;
    return async (tx) => {
      // Account-wide since the 0.20 scope ruling: the apply re-routes every mailbox THIS install
      // organizes and returns the rest as `heldElsewhere`, which the drain deliberately drops —
      // the requesting install already queued to every holder it could name, and a drain that
      // re-queued for mailboxes it reads as foreign would ping-pong two installs for ever.
      await applyScreenerDecision(tx, {
        accountId: ctx.accountId,
        scope: decision.scope,
        address: decision.address,
        appliedFolder: decision.appliedFolder,
        decision: decision.decision,
        triggeringActionId: `screener:request:${ctx.requestId}`,
        now: ctx.now,
        // The drain never stamps `screening_baseline_at`. See
        // `ApplyScreenerDecisionInput.stampBaseline`'s own doc comment for why.
        stampBaseline: false,
        // The reader's own past-mail answer, carried across the install boundary rather than
        // re-defaulted here: a decline made on one install must not become consent on another.
        applyRetro: decision.applyRetro,
        // A READER's press, carried across the install boundary: still the person's decision,
        // and it converges the sender's existing rule as the press does on its own install.
        decidedBy: "person", overExisting: "converge",
      });
      return { applied: true };
    };
  },

  "message.move": (payload, ctx) => {
    const move = validateMovePayload(payload);
    if (!move) return null;
    return async (tx) => {
      const r = await applyMessageMove(tx, {
        accountId: ctx.accountId, mailboxId: ctx.mailboxId, payload: move, now: ctx.now,
      });
      if (r.applied) return { applied: true };
      /* The applier's two outcomes are not refusals OF THE RECORD — the record was valid and
         verified — they are facts about this organizer's own store that the reader could not have
         known when it decided. They are still `refused` to the reader, because the alternative is
         a record that quietly disappears and leaves them unable to tell "done" from "never
         happened". Mapped by name below. */
      return { applied: false, reason: MOVE_REFUSAL_REASON[r.refusal] };
    };
  },

  /**
   * Mail 0094. The kind that existed to close a SUCCESS THAT CHANGED NOTHING: before it, a reader
   * editing an away responder, a signature, a dormancy window or a screening posture got `200`, the
   * write landed in the reader's own row, and the organizer's pass never read it. It has no refusal
   * arm, a property of the action rather than an omission: a move can fail to find its message, a
   * configuration write has nothing to look up (the rows are the account's and the mailbox's,
   * established before the record was drained). Every outcome that is not `applied` is an exception,
   * and the enclosing transaction turns one into a record left standing for the next cycle.
   */
  "rule.create": ruleHandler("rule.create"),
  "rule.update": ruleHandler("rule.update"),
  "rule.delete": ruleHandler("rule.delete"),

  "profile.update": (payload, ctx) => {
    const update = validateProfileUpdatePayload(payload);
    if (!update) return null;
    return async (tx) => {
      await applyProfileUpdate(tx, {
        accountId: ctx.accountId, mailboxId: ctx.mailboxId, payload: update, now: ctx.now,
      });
      return { applied: true };
    };
  },
};


/**
 * `Tx` (`@trafficflow/db`'s `PgDatabase<any, any, any>`), NOT the hosted worker's narrower `WorkerDb`
 * (the FULL combined schema over a real `postgres` connection). Both callers reach this module: the
 * hosted worker's own database and the desktop engine's PGlite-backed `LocalDb` (the mail-only schema)
 * are structurally different drizzle instances, and this module's actual needs (`db.transaction(...)`,
 * threaded into functions that already accept `Tx`) are satisfied by either. Typing this narrowly to
 * `WorkerDb` (which this file used to) compiled for the worker and failed the desktop engine's
 * typecheck the moment it called in — the reason `OrganizerProfileSync`'s callers pass `db as unknown
 * as Tx` rather than a real shared type.
 */
type WorkerDb = Tx;

/**
 * The organizer's drain — apply what a reader decided, or refuse it and SAY SO (0.14.1). The payload
 * is UNTRUSTED and so is the record itself: a request record is an RFC822 message another install
 * appended to `ohmail/_meta`, an ordinary IMAP folder, so anyone with APPEND rights could write one
 * (a forged record buys a `promoted` rule, a `contacts` whitelist, a mark-read). So the ORDER of the
 * checks is the security property: bound the headers, refuse an unknown protocol/kind (LEAVE STANDING),
 * VERIFY THE SIGNATURE before any decode, refuse one naming ANOTHER row this store holds, refuse a
 * stale decision, only then decode/validate, and apply under a content-bound idempotency key. No key
 * means no channel. After `runSyncCycle` under a time budget (the folder is attacker-writable), and the drain performs no physical move.
 */

/**
 * What either role needs to work on one mailbox. `requestKey` is passed IN rather than read here, the
 * shape the derivation forces: the key is HKDF over the mailbox PASSWORD (`deriveRequestKey`), so it
 * comes from the credential the host already decrypted to open IMAP — this module has no credential and
 * no business decrypting one. `null` means there is no shared secret (an OAuth mailbox, each install
 * holding its own token), and both roles stop on it, the honest degraded mode: no records written, none
 * applied, and the organizer advertises no `requests` capability so a reader is refused at its own door.
 */
export interface RequestRuntime {
  mailboxId: string;
  accountId: string;
  /**
   * WHICH INSTALL THIS IS. Required, and required as a VALUE rather than something read off the
   * connection: what a process remembers about a mailbox — where a walk got to, which record it
   * wrote — belongs to one install on one mailbox, and a memory keyed by anything coarser answers
   * another install's question. The organizer side had no install to hand at all, which is why
   * this had to be threaded before that memory could be keyed correctly.
   */
  installId: string;
  adapter: MailboxAdapter;
  requestKey: string | null;
}

/** Thrown when a caller builds a runtime without a usable identity. */
export class RequestIdentityError extends Error {
  constructor(what: string) {
    super(`the request drain was given no usable ${what}, so nothing it remembers could be `
      + "attributed to one install on one mailbox");
    this.name = "RequestIdentityError";
  }
}

/**
 * THE SEAM'S OWN CHECK, because the compiler does not cover the callers that matter most.
 *
 * The tests in this package and in core are not typechecked, so adding a required field to the
 * runtime above does NOT fail a build for the hundred-odd places that construct one — they bind
 * `undefined` and carry on, and a memory keyed on `undefined` is shared by every mailbox in the
 * process. That is silent and it is exactly the class of defect this field exists to remove, so
 * the check is here at run time where it will actually fire.
 */
function assertIdentity(rt: RequestRuntime): void {
  if (typeof rt.installId !== "string" || rt.installId.trim() === "") {
    throw new RequestIdentityError("install id");
  }
  if (typeof rt.mailboxId !== "string" || rt.mailboxId.trim() === "") {
    throw new RequestIdentityError("mailbox id");
  }
}

/** How long a decision may sit before both sides give up on it. ONE window, read by both roles. */
export const REQUEST_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * The stale window must bite no later than the idempotency key expires — a real safety property, not a
 * coincidence (`request-drain.test.ts` asserts it). The key at `meta-request:<id>` is what stops a
 * second drain re-applying a record whose expunge failed, and it has a TTL (`IDEMPOTENCY_TTL_MS`).
 * Once it expires, a record still in the folder would be claimable again, and a drain that re-claimed
 * it would apply the same decision twice. What closes that is this inequality: a record old enough for
 * its key to have expired is, by then, older than the stale window too, so step 5 refuses it as `stale`
 * before step 8 can re-claim it. Widen this constant past the TTL and the double-apply comes back.
 */
export const REQUEST_STALE_MUST_NOT_EXCEED_MS = IDEMPOTENCY_TTL_MS;

/**
 * AT MOST THIS MANY RECORDS PER CYCLE, oldest decision first. A folder anyone can append to must
 * not be able to turn one mailbox's pass into unbounded work; the rest are deferred, not dropped,
 * and the next cycle takes the next batch in the same order.
 */
export const REQUEST_DRAIN_MAX_PER_CYCLE = 200;

/**
 * AND A WALL-CLOCK CEILING BESIDE THE COUNT, because the two bound different things. The count
 * bounds how many records are read; this bounds how long applying them may take when each one is
 * a real transaction against a database that is having a bad day. Checked between records, so a
 * record already begun always finishes — a half-applied decision is the one outcome worse than a
 * slow cycle.
 */
export const REQUEST_DRAIN_TIME_BUDGET_MS = 10_000;

/** An adapter that can hand out the ORGANIZER's half of the request IO. */
export interface RequestOrganizerIoCapableAdapter {
  requestOrganizerIo(identity: { installId: string; mailboxId: string }): RequestOrganizerIo;
}

/** An adapter that can hand out the READER's half. Separate type, separate capability. */
export interface RequestReaderIoCapableAdapter {
  requestReaderIo(): RequestReaderIo;
}

export function hasRequestOrganizerIo(
  adapter: MailboxAdapter,
): adapter is MailboxAdapter & RequestOrganizerIoCapableAdapter {
  return typeof (adapter as Partial<RequestOrganizerIoCapableAdapter>).requestOrganizerIo === "function";
}

export function hasRequestReaderIo(
  adapter: MailboxAdapter,
): adapter is MailboxAdapter & RequestReaderIoCapableAdapter {
  return typeof (adapter as Partial<RequestReaderIoCapableAdapter>).requestReaderIo === "function";
}

export interface ApplyMetaRequestsResult {
  /** Applied here, or already applied on an earlier cycle and now cleaned up and acknowledged. */
  applied: number;
  /** Refused, acknowledged with a reason, and expunged. */
  refused: number;
  /** Left for a retry — the apply, its acknowledgement or the expunge failed transiently. */
  deferred: number;
  /**
   * LEFT STANDING and deliberately not acted on: a future protocol version, or a kind this build
   * has no applier for. Neither applied nor refused nor destroyed. Counted separately
   * because a nonzero value here is normal (a newer reader talking to this organizer) while a
   * nonzero `refused` is not.
   */
  standing: number;
}

const EMPTY_RESULT: ApplyMetaRequestsResult = { applied: 0, refused: 0, deferred: 0, standing: 0 };

/**
 * THE CONTENT AN IDEMPOTENCY KEY STANDS FOR — `sha256` over the record's own signed fields.
 *
 * NOT `JSON.stringify(payload)`, which is what this was: key reuse with a different MAILBOX or a
 * different `decidedAt` would have produced the same hash and read as a replay. The hash covers
 * everything the signature covers, so "the same request" means the same request.
 */
function requestContentHash(e: RequestEnvelope): string {
  // `canonicalRequest` rather than a join of the same fields: it is the EXACT byte string the
  // signature is taken over, so "the same content" here cannot drift from "the same content" there
  // — and it is length-prefixed, so no field's content can impersonate a separator and make two
  // different records hash alike. A hand-rolled join needs a separator that cannot appear in any
  // field, and the obvious choice (a NUL) makes this source file binary, at which point `grep`
  // silently skips it.
  return createHash("sha256").update(canonicalRequest({
    requestId: e.requestId, kind: e.kind, mailboxId: e.mailboxId, installId: e.installId,
    decidedAt: e.decidedAtRaw, protocol: e.protocol, encodedPayload: e.encodedPayload,
  }), "utf8").digest("hex");
}

/** A refusal decided before any database work — carries the reason its ack will name. */
interface Refusal {
  refusal: RequestRefusalReason;
}

/** Thrown inside the apply transaction when a spent key stands for DIFFERENT content. */
class RequestConflictError extends Error {
  constructor(readonly requestId: string) {
    super(`request ${requestId} reuses a spent id with different content`);
    this.name = "RequestConflictError";
  }
}

/** Thrown inside the apply transaction when the key was spent by THIS EXACT request already. */
class AlreadyAnsweredError extends Error {
  constructor(readonly requestId: string, readonly answer: RecordedAnswer) {
    super(`request ${requestId} was already answered on an earlier cycle`);
    this.name = "AlreadyAnsweredError";
  }
}

/** What an organizer answered one request, as its `meta-request:<id>` key records it. */
type RecordedAnswer = { applied: true } | { applied: false; reason: RequestRefusalReason };

/** An apply's key says `applied`; a refusal's key carries `applied: false` and its reason. */
function recordedAnswerOf(json: unknown): RecordedAnswer {
  const j = typeof json === "object" && json !== null ? json as { applied?: unknown; reason?: unknown } : {};
  return j.applied === false && isRequestRefusalReason(j.reason) ? { applied: false, reason: j.reason } : { applied: true };
}

/** The enumeration's refusal code behind a failed read (`over_ceiling`, `bytes`, …), else `null`. */
function enumCodeOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * WHAT A REFUSAL CONTRIBUTES TO A LOG LINE — the thrown VALUE, and the operation it names.
 *
 * `err` is a logger-owned slot: it takes the thrown value and derives `errorClass`/`errorCode`
 * from it, never its text. Eleven sites here handed it `err.message` instead, so every line read
 * `errorClass="String"` — asserting a thrown string that never existed — while the class that
 * names the fault was thrown away. Measured in production: 118 `meta_ack_sweep_failed` lines in
 * one morning, all of them blaming a String for a `RequestUnavailableError`. `op` is the call
 * site's own fact rather than the logger's, and it is what tells two refusals of one class apart.
 */
function refusalFields(err: unknown): { err: unknown; op?: string } {
  const op = (err as { op?: unknown } | null | undefined)?.op;
  return { err, ...(typeof op === "string" ? { op } : {}) };
}

/**
 * KEEP `ohmail/_meta` SMALL ENOUGH TO READ: the stale-record sweep, then the compaction. Moved
 * verbatim out of {@link applyMetaRequests} so it runs with no request key and on the lease-refused
 * arm ({@link shrinkMetaOnRefusal}). Neither reads the folder whole, so a folder past the read
 * ceiling still shrinks; the compaction stays the holder's and refuses without a live claim.
 */
export async function shrinkMeta(
  io: RequestOrganizerIo, now: Date, log: (event: string, detail: Record<string, unknown>) => void,
): Promise<{ ran: boolean; swept: number; moved: number }> {
  let swept = 0;
  let moved = 0;

  /* The sweep runs before the read, because the read is what it unblocks. The organizer's ack sweep is
   * the only thing that ever makes `ohmail/_meta` SMALLER, and it used to sit after the bounded read,
   * which refuses a folder over the ceiling — so a folder that crossed the ceiling BY ACKS could never
   * come back down: the read refused, the sweep never ran, and every drain refused from then on, with
   * nothing self-healing. Asked of the server by header and date where the server takes that form,
   * and by a uid-range fetch of the same window where it does not — iCloud refuses the compound term
   * outright. Failure is logged and swallowed: a sweep that could not run is where this was before,
   * and must not stop a drain that might still succeed. */
  const sweep = async (): Promise<void> => {
    if (typeof io.sweepStaleAcks !== "function") return;
    try {
      swept = await io.sweepStaleAcks(new Date(now.getTime() - REQUEST_STALE_AFTER_MS));
      if (swept > 0) {
        log("meta_ack_sweep", { swept });
      }
    } catch (err) {
      log("meta_ack_sweep_failed", {
        ...refusalFields(err),
      });
    }
  };
  await sweep();

  /* And the other half of keeping the folder readable, immediately after it and for the same
   * reason. The sweep makes `ohmail/_meta` smaller; nothing made it SHALLOWER, and a uid is spent
   * per renewal and never returned — so a folder holding a handful of records ends up with its
   * records ten thousand uids below the top of its space, where no bounded read reaches them.
   * Every gate then refuses and the mailbox is organized by nobody. The organizer moves them back
   * up; the ordinary answer is 0 and costs one probe. Failure is logged and swallowed exactly as
   * the sweep's is: a compaction that could not run leaves the folder as it was, and must not stop
   * a drain that might still succeed. */
  if (typeof io.compactMeta === "function") {
    try {
      moved = await io.compactMeta(now);
      if (moved > 0) {
        log("meta_compacted", { moved });
      }
    } catch (err) {
      log("meta_compact_failed", {
        ...refusalFields(err),
      });
    }
  }

  return { ran: typeof io.sweepStaleAcks === "function", swept, moved };
}

/**
 * THE LEASE-REFUSED ARM'S SHRINK — only for a folder too full to read (`meta_folder_full`). A dead
 * socket, a wrong clock or a folder that takes no delete is not cured by sweeping, so those run
 * nothing. Keyless, and it reads no request. Never throws; says `meta_shrink` when it ran.
 */
export async function shrinkMetaOnRefusal(
  refusal: unknown,
  rt: { mailboxId: string; accountId: string; installId: string; adapter: MailboxAdapter },
  now: Date,
  log: (event: string, detail: Record<string, unknown>) => void,
): Promise<boolean> {
  if (!(refusal instanceof LeaseUnavailableError) || refusal.op !== "meta_folder_full") return false;
  if (!hasRequestOrganizerIo(rt.adapter)) return false;
  let io: RequestOrganizerIo;
  try {
    io = rt.adapter.requestOrganizerIo({ installId: rt.installId, mailboxId: rt.mailboxId });
  } catch {
    return false;
  }
  const ids = { mailboxId: rt.mailboxId, accountId: rt.accountId };
  const done = await shrinkMeta(io, now, (event, detail) => { log(event, { ...ids, ...detail }); });
  log("meta_shrink", { ...ids, phase: "lease_refused", ...done });
  return true;
}

/**
 * DRAIN `ohmail/_meta` OF EVERY REQUEST THIS ORGANIZER CAN VERIFY, applying each in `decided_at`
 * then id order — two doors deciding one sender in one cycle land in the order the human made them.
 *
 * The one entry point every host calls. There is no unguarded twin any more: the precondition is
 * "this account has a request key", which is a fact rather than a flag, and it is checked here.
 */
export async function applyMetaRequests(
  db: WorkerDb,
  rt: RequestRuntime,
  now: Date,
  log: (event: string, detail: Record<string, unknown>) => void,
): Promise<ApplyMetaRequestsResult> {
  assertIdentity(rt);
  if (!hasRequestOrganizerIo(rt.adapter)) return EMPTY_RESULT;

  let io: RequestOrganizerIo;
  try {
    io = rt.adapter.requestOrganizerIo({ installId: rt.installId, mailboxId: rt.mailboxId });
  } catch {
    // A retired adapter — the cycle raced a reconnect or a shutdown. `requestOrganizerIo()` throws
    // on one by design (`ImapAdapter`'s own `assertUsable`), and outside this try that throw
    // reaches the host as an ERROR-level drain failure. It is not one: nothing was owed and
    // nothing was lost, and the next cycle has a live connection.
    return EMPTY_RESULT;
  }

  /* THE FOLDER IS KEPT SMALL WHETHER OR NOT THIS ACCOUNT HAS A REQUEST CHANNEL — ahead of the key,
   * which gates only the request read below. Keyless organizers are most of them, and their own
   * claims and acks pile up the same (META-SHRINK-AHEAD-OF-THE-GATE). */
  await shrinkMeta(io, now, (event, detail) => {
    log(event, { mailboxId: rt.mailboxId, accountId: rt.accountId, ...detail });
  });

  // ── NO KEY, NO CHANNEL ──────────────────────────────────────────────────────────────────────
  //
  // Read BEFORE the folder is listed, so an organizer with no request channel reads no request.
  // A NULL key is the resting state of every account that has never used a second install, and
  // it is silent by design — logging it per mailbox per cycle would be a line about nothing.
  const key = rt.requestKey;
  if (key === null) return EMPTY_RESULT;

  /* THE WHOLE FOLDER, through the one door: complete past the 500-record window, or refused by name
   * (past the enumeration's ceiling, `over_ceiling` or `bytes`). A refusal is a look that failed:
   * nothing is settled, acked or removed, and the next cycle tries again. In production the lease
   * stands this organizer down before a folder past the ceiling reaches here; the arm is driven. */
  let records: RawMetaMessage[];
  try {
    records = (await io.listMetaRecords()).records;
  } catch (err) {
    log("meta_requests_list_failed", {
      mailboxId: rt.mailboxId, accountId: rt.accountId,
      ...refusalFields(err), code: enumCodeOf(err),
    });
    return EMPTY_RESULT;
  }

  const envelopes = requestEnvelopesIn(records);

  /* Matching is per-mailbox. Collecting is not — and the two used to share one filter. `acksIn`
   * verifies under the ACCOUNT key, so everything is this account's own bookkeeping; which mailbox an
   * ack NAMES decides whether it answers anything in THIS folder, and that filter is load-bearing for
   * the matching. It is the wrong question for the SWEEP: `staleAckRefs` fed the only path that expunges
   * an ack and inherited the mailbox filter, so an ack that verifies under the account key but names
   * another mailbox could never be collected by anybody — it sat in the folder for ever counting against
   * the read ceiling (a mailbox removed and re-added gets a NEW id, so an ack written moments before the
   * removal names an id no mailbox has). So the sweep is by AGE alone: past the stale window no ack can
   * be an answer, whichever mailbox it names, while the matching keeps the mailbox filter. */
  const verifiedAcks = acksIn(records, key);
  const existingAcks = verifiedAcks.filter((a) => a.mailboxId === rt.mailboxId);
  const staleAckRefs = verifiedAcks
    .filter((a) => now.getTime() - a.ackedAt.getTime() > REQUEST_STALE_AFTER_MS)
    .map((a) => a.ref)
    .filter((r) => r !== undefined);

  if (envelopes.length === 0) {
    // Acks outlive the requests they answer, so somebody has to collect them, and only the
    // organizer may expunge. Past the stale window the reader has already given up on the row, so
    // a surviving ack answers a question nobody is still asking.
    if (staleAckRefs.length > 0) {
      try {
        await io.remove(staleAckRefs);
      } catch (err) {
        log("meta_ack_sweep_failed", {
          mailboxId: rt.mailboxId, accountId: rt.accountId,
          ...refusalFields(err),
        });
      }
    }
    return EMPTY_RESULT;
  }

  // Which ids already carry an ack from a previous cycle whose expunge failed. Re-acking them
  // would put a second ack in the folder for one request; the record still needs removing.
  const alreadyAcked = new Set(existingAcks.map((a) => a.requestId));

  /* Order, then bound — and the two kinds do not share a budget. Well-formed records are sorted BEFORE
   * the ceiling, so "the first 200" means the 200 oldest decisions. The ceilings are separate because
   * they were not: malformed records used to be taken FIRST out of the SAME 200, so the cheapest record
   * (one that carries `X-Ohmail-Request: 1` and is then unreadable — no signature, no key) could hold
   * 200 slots and defer every genuine SIGNED decision every cycle while the counters reported healthy
   * work. Handling a malformed record is one ref in a batch already being sent; a well-formed one is a
   * verify, decode and transaction. Both are still bounded. Expunging an unverifiable record is the
   * DEFAULT, not an exception: leave-standing is a courtesy extended only to records that proved where
   * they came from, and a malformed one carries this build's own discriminator (ours to remove). */
  const malformed = envelopes.filter(isMalformedRequest);
  const wellFormed = envelopes
    .filter((e): e is RequestEnvelope => !isMalformedRequest(e))
    .sort((a, b) => {
      const byTime = a.decidedAt.getTime() - b.decidedAt.getTime();
      if (byTime !== 0) return byTime;
      return a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0;
    });

  const budget = malformed.length + wellFormed.length;
  const takeMalformed = malformed.slice(0, REQUEST_DRAIN_MAX_PER_CYCLE);
  const takeWellFormed = wellFormed.slice(0, REQUEST_DRAIN_MAX_PER_CYCLE);

  /* ── THE WALK ADVANCES UNLESS THE CAP STOPPED IT MID-PAGE ────────────────────────────────
   *
   * Work this pass declined to reach is the only reason to read the same window again. Work it
   * CANNOT reach — a record standing for a protocol this build does not implement — is not work
   * pending here at all, and treating it as such is what pinned the walk above every older
   * request. So the page's own bound is taken whenever the slice consumed everything it was
   * offered, and held only when the cap truly bit. */
  let deferred = budget - takeMalformed.length - takeWellFormed.length;

  let applied = 0;
  let refused = 0;
  let standing = 0;

  /* Which of the batch's other mailbox ids are rows of THIS store — one read, before the loop.
     `null` when the read failed: those records wait for the next cycle rather than be judged. */
  let otherRowsHere: Set<string> | null = new Set();
  const otherIds = new Set(takeWellFormed.map((e) => e.mailboxId).filter((id) => id !== rt.mailboxId));
  if (otherIds.size > 0) {
    try {
      otherRowsHere = await db.transaction((tx) => mailboxRowsHeld(tx, otherIds));
    } catch (err) {
      otherRowsHere = null;
      log("organizer_request_apply_failed", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, ...refusalFields(err),
      });
    }
  }

  /** Refusals and applies both end in "remove this record", batched into ONE STORE+EXPUNGE. */
  const toRemove: unknown[] = [...staleAckRefs];
  /** Acks to append, one per record whose outcome is decided this cycle. `resend`: answered earlier. */
  const toAck: Array<{
    requestId: string; outcome: "applied" | "refused"; reason?: RequestRefusalReason;
    ref?: unknown; resend: boolean; hash: string;
  }> = [];

  const settle = (
    e: RequestEnvelope,
    outcome: "applied" | "refused",
    reason?: RequestRefusalReason,
    resend = false,
  ): void => {
    if (e.ref !== undefined) toRemove.push(e.ref);
    if (!alreadyAcked.has(e.requestId)) {
      toAck.push({ requestId: e.requestId, outcome, reason, ref: e.ref, resend, hash: requestContentHash(e) });
    }
  };

  /**
   * WHAT THIS ORGANIZER ANSWERED THIS CONTENT — the `meta-request:<id>` key holding the same hash,
   * an apply's or a refusal's. It lives a full window, so it outlives the reader's wait. `"none"`:
   * no answer yet. `null`: the read failed, which says nothing, and the record stays for next pass.
   */
  const answeredEarlier = async (e: RequestEnvelope): Promise<RecordedAnswer | "none" | null> => {
    try {
      const held = await db.transaction((tx) =>
        readIdempotencyKey(tx, rt.accountId, `meta-request:${e.requestId}`, now));
      if (held === null || held.erasedAt !== null || held.requestHash !== requestContentHash(e)) return "none";
      return recordedAnswerOf(held.responseJson);
    } catch (err) {
      log("organizer_request_apply_failed", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: e.requestId,
        ...refusalFields(err),
      });
      return null;
    }
  };

  for (const m of takeMalformed) {
    // A malformed record has no readable id, so there is nobody to acknowledge TO — the reader
    // that wrote it (if a reader wrote it at all) cannot match an ack to a row it cannot name.
    // It is removed and counted, and the log line is the only account of it.
    if (m.ref !== undefined) toRemove.push(m.ref);
    refused++;
    log("organizer_request_refused", {
      mailboxId: rt.mailboxId, accountId: rt.accountId,
      reason: "malformed", detail: m.reason,
    });
  }

  const startedAt = Date.now();

  for (const e of takeWellFormed) {
    // Checked BETWEEN records, never inside one: a record already begun finishes, because a
    // half-applied decision is worse than a slow cycle. What is left is deferred, in order, and
    // the next pass starts where this one stopped.
    if (Date.now() - startedAt > REQUEST_DRAIN_TIME_BUDGET_MS) {
      deferred++;
      continue;
    }

    // (2) A future protocol, or a kind with no applier: LEAVE IT STANDING — the claim path's
    // `c.protocol > ourProtocol` rule one layer down. A record this build does not understand is not
    // evidence and not ours to destroy: a newer reader may be talking to an older organizer, and it
    // becomes applicable the moment that organizer updates. (3) THE SIGNATURE, before any decode AND
    // before the leave-standing branches. Those branches USED TO SIT ABOVE this check, on the reasoning
    // that a future protocol might sign over fields this build cannot reconstruct — sound, and a hole:
    // an unverified record could reach "leave standing" by merely SAYING `X-Ohmail-Protocol: 2`, so 200
    // such messages dated 1970 permanently occupy the ceiling. So authenticity comes first, and a
    // protocol bump must keep the signature verifiable under this canonical form, or ship to organizers first.
    if (!verifyRequestEnvelope(e, key)) {
      // Removed, but not acknowledged, and the asymmetry is deliberate. Every other refusal answers,
      // because every other refusal is about a record this account's own reader wrote and is waiting on.
      // This one is not: a record that does not verify did not come from a holder of the key, so there
      // is no reader to answer TO — and writing one ack per forged record would hand a flooder an
      // amplifier, making this organizer APPEND once for every message the attacker appends. The one
      // honest case that lands here is our own reader's record after a key rotation; it gets no ack and
      // expires on the reader's own window instead, the behaviour rotation is documented to have.
      if (e.ref !== undefined) toRemove.push(e.ref);
      refused++;
      log("organizer_request_refused", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: e.requestId,
        reason: "unauthenticated",
      });
      continue;
    }

    // ── (3b) VERIFIED, BUT NOT SOMETHING THIS BUILD UNDERSTANDS: LEAVE IT STANDING ───────────
    //
    // A future protocol version or a kind with no applier here is not invalid — it is unreadable
    // BY THIS BUILD. A newer install on the same account wrote it, and it becomes applicable the
    // moment this organizer updates. Refusing it would be a lie, and expunging it would lose a
    // decision a person made.
    //
    // Reachable only by a holder of the account's key (see the block above), so the number of
    // records that can sit here is bounded by the account's own installs rather than by whoever
    // can append to the folder.
    if (e.protocol > REQUEST_PROTOCOL) {
      standing++;
      log("organizer_request_standing", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: e.requestId,
        reason: "protocol_ahead", protocol: e.protocol,
      });
      continue;
    }
    /* (3c) Which applier runs — one table, keyed by kind (mail 0094). This was
     * `if (e.kind !== "screener.decide")` while there was one applier. The table is the same statement
     * for N of them and keeps the property the `if` had: a kind this build has no entry for LEAVES THE
     * RECORD STANDING rather than refusing or expunging it — a decision a person made, written by a
     * newer install on the same account, applicable the moment this organizer updates.
     * Every kind in `REQUEST_KINDS` has an entry here now, and the reader appends all of them; a
     * kind with no entry is a NEWER install's, and leaving its record standing is what lets this
     * organizer apply it after an update rather than refusing a decision a person made. */
    const handler = KIND_HANDLERS[e.kind];
    if (!handler) {
      standing++;
      log("organizer_request_standing", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: e.requestId,
        reason: "unhandled_kind", kind: e.kind,
      });
      continue;
    }

    // ── (3d) ANSWERED ALREADY: a record whose ack was lost is answered from its key ──────────
    //
    // The same answer, logged once: an applied record is never applied twice, and a refused one
    // is not re-derived on the next pass, where a refusal that depends on time could change.
    const earlier = await answeredEarlier(e);
    if (earlier === null) { deferred++; continue; }
    if (earlier !== "none") {
      if (earlier.applied) {
        settle(e, "applied", undefined, true);
        applied++;
      } else {
        settle(e, "refused", earlier.reason, true);
        refused++;
      }
      continue;
    }

    // ── (4) IT MAY NOT NAME ANOTHER ROW THIS STORE HOLDS ─────────────────────────────────────
    //
    // Every install mints its own row id, so a reader's id is one this store has usually never
    // seen, and the record is about the mailbox whose folder it was read from (the key is that
    // mailbox's). Refused: a record naming another row held HERE, such as a removed-and-re-added
    // mailbox's old id or a second account's row. The password is the boundary, not this id.
    const anotherRowHere = e.mailboxId === rt.mailboxId ? false
      : otherRowsHere === null ? null : otherRowsHere.has(e.mailboxId);
    if (anotherRowHere === null) {
      deferred++;
      continue;
    }
    if (anotherRowHere) {
      settle(e, "refused", "wrong_mailbox");
      refused++;
      log("organizer_request_refused", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: e.requestId,
        reason: "wrong_mailbox", named: e.mailboxId,
      });
      continue;
    }

    // ── (5) OLDER THAN THE WINDOW THE READER ITSELF GAVE UP AT ───────────────────────────────
    //
    // An organizer that was offline for two days comes back to decisions the person has already
    // been told expired, and may well have made again. Applying them would resurrect a queue they
    // have moved on from — and, with the newer decision also in the folder, would apply BOTH in
    // `decidedAt` order, leaving the older one as the final state. Refusing the stale one leaves
    // exactly the rule the person last asked for.
    if (now.getTime() - e.decidedAt.getTime() > REQUEST_STALE_AFTER_MS) {
      /* `stale` refuses a decision nobody answered: one applied HERE whose ack was lost was
         answered from its key at (3d), `applied`, never a refusal of mail that moved. */
      settle(e, "refused", "stale");
      refused++;
      log("organizer_request_refused", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: e.requestId,
        reason: "stale", decidedAt: e.decidedAt.toISOString(),
      });
      continue;
    }

    // ── (6) NOW, AND ONLY NOW, DECODE ────────────────────────────────────────────────────────
    const decoded = decodeRequestPayload(e);
    if (isMalformedRequest(decoded)) {
      settle(e, "refused", "invalid_payload");
      refused++;
      log("organizer_request_refused", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: e.requestId,
        reason: "invalid_payload", detail: decoded.reason,
      });
      continue;
    }

    /* ── (7) AND VALIDATE WHAT CAME OUT, BY THE KIND'S OWN RULES ────────────────────────────
     *
     * The handler returns the APPLIER BOUND TO ITS VALIDATED VALUE, not the value — so the
     * validated payload cannot be separated from the function entitled to read it, and a kind
     * whose applier is handed another kind's payload is not expressible here. `null` is
     * `invalid_payload` for every kind, exactly as before.
     */
    const runApply = handler(
      (decoded as RequestRecord).payload,
      { accountId: rt.accountId, mailboxId: rt.mailboxId, requestId: e.requestId, now },
    );
    if (!runApply) {
      settle(e, "refused", "invalid_payload");
      refused++;
      log("organizer_request_refused", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: e.requestId,
        reason: "invalid_payload",
      });
      continue;
    }

    // ── (8) APPLY, UNDER A KEY BOUND TO THIS CONTENT ─────────────────────────────────────────
    const hash = requestContentHash(e);
    const idemKey = `meta-request:${e.requestId}`;
    try {
      await db.transaction(async (txRaw) => {
        /* CARRIED. A transaction object has no dialect brand of its own, and
           `applyScreenerDecision` below reaches the learning-signal write, which resolves
           one. Handed the parent's — a transaction cannot be on a different store from the
           connection that opened it. */
        const tx = carryDialect(db, txRaw as object) as typeof txRaw;
        // FENCE FIRST, as the FIRST statement of this transaction — `erasure-fence.ts`'s own rule,
        // and NOT redundant with `applyScreenerDecision`'s own internal fence: a write before the
        // fence is exactly the lock order `deleteAccount` depends on to close its own race
        // (`accounts FOR SHARE` first, always). Read here too, so the CATCH below sees it before
        // any other write in this transaction has touched a row.
        const erasedAt = await readAccountErasedAt(tx, dialect(tx), rt.accountId);
        if (erasedAt != null) throw new AccountErasedError(rt.accountId);

        // THE CONTENT COMPARISON, and it happens before the claim so the common conflict is
        // caught without a write. A live row for this id whose hash differs is an id being reused
        // for different content — refused, and the genuine record (a different id, or this same id
        // arriving with its original content) is untouched.
        const existing = await readIdempotencyKey(tx, rt.accountId, idemKey, now);
        if (existing !== null) {
          if (existing.requestHash !== hash) throw new RequestConflictError(e.requestId);
          throw new AlreadyAnsweredError(e.requestId, recordedAnswerOf(existing.responseJson));
        }

        const claimed = await claimIdempotencyKey(tx, {
          accountId: rt.accountId,
          key: idemKey,
          requestHash: hash,
          responseStatus: 200,
          responseJson: { applied: true, requestId: e.requestId },
          seq: null,
          now,
        });
        // Lost the claim to a concurrent drain, and the content still has to be compared. This used to
        // step aside, reasoning "the winner already answered whether the content matched". It does not
        // follow, and REAL POSTGRES CAUGHT IT: the read above and this claim are two statements, so two
        // cycles can both see no key and then race the unique index — the loser learns only that it
        // lost, not what it lost TO. Stepping aside reported the loser's record as `applied` when the
        // winner may have applied entirely different content under the same id (the substitution attack
        // by timing alone, invisible under PGlite). So the loser re-reads: under READ COMMITTED this
        // takes a fresh snapshot and sees the winner's row — same hash a replay, a different hash the `conflict`.
        if (!claimed) {
          const winner = await readIdempotencyKey(tx, rt.accountId, idemKey, now);
          if (winner !== null && winner.requestHash !== hash) {
            throw new RequestConflictError(e.requestId);
          }
          throw new AlreadyAnsweredError(e.requestId, recordedAnswerOf(winner?.responseJson));
        }

        /* THE KIND'S OWN APPLIER, inside the SAME idempotency arm every kind shares. The fence,
           the content comparison, the claim and the lost-claim re-read above are properties of
           the CHANNEL rather than of any one action, so a kind that brought its own copy of them
           would be a second answer to "has this record already been taken". */
        const outcome = await runApply(tx);
        /* A REFUSAL FROM THE APPLIER ROLLS THE TRANSACTION BACK, and that is the point: the
           idempotency key claimed a few lines above must not survive an apply that did nothing,
           or the next cycle would read the key, conclude the record was already taken, and ack
           the reader `applied` for a move that never happened. Thrown rather than returned for
           exactly that reason — the throw is what undoes the claim. */
        if (!outcome.applied) throw new ApplierRefusedError(outcome.reason);
      });
      settle(e, "applied");
      applied++;
    } catch (err) {
      if (err instanceof AlreadyAnsweredError) {
        // Exactly as done as one answered this cycle: the reader is owed the same answer, and
        // when that cycle's ack was lost this is its retry.
        if (err.answer.applied) {
          settle(e, "applied", undefined, true);
          applied++;
        } else {
          settle(e, "refused", err.answer.reason, true);
          refused++;
        }
        continue;
      }
      if (err instanceof RequestConflictError) {
        settle(e, "refused", "conflict");
        refused++;
        log("organizer_request_refused", {
          mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: e.requestId,
          reason: "conflict",
        });
        continue;
      }
      if (err instanceof ApplierRefusedError) {
        /* THE RECORD WAS PERFECTLY VALID AND THE ACTION COULD NOT BE CARRIED OUT — a message this
           organizer never synced, a mailbox with no Trash discovered. Acked with the applier's own
           word so the person is told which of those it was, rather than left to infer it from a
           record that quietly went away. */
        settle(e, "refused", err.reason);
        refused++;
        log("organizer_request_refused", {
          mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: e.requestId,
          reason: err.reason, kind: e.kind,
        });
        continue;
      }
      if (err instanceof AccountErasedError) {
        settle(e, "refused", "account_erased");
        refused++;
        log("organizer_request_refused", {
          mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: e.requestId,
          reason: "account_erased",
        });
        continue;
      }
      // Any other failure: leave the record standing and acknowledge nothing. The idempotency key
      // was NOT committed (the throw rolled the transaction back), so the next cycle's claim
      // succeeds and retries the apply cleanly — this is not a partial-apply state.
      log("organizer_request_apply_failed", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: e.requestId,
        ...refusalFields(err),
      });
      deferred++;
    }
  }

  /* A REFUSAL IS RECORDED BEFORE IT IS ANSWERED, under the key an apply claims, in its own
     transaction (the apply's rolled back). When its ack is then lost the record stays, and the
     next pass answers it from the key at (3d). A refusal that could not be recorded is re-derived
     next pass; the fence first, so an erased account gets no key. */
  for (const a of toAck) {
    if (a.outcome !== "refused" || a.resend || a.reason === undefined) continue;
    const reason = a.reason;
    try {
      await db.transaction(async (txRaw) => {
        const tx = carryDialect(db, txRaw as object) as typeof txRaw;
        if (await readAccountErasedAt(tx, dialect(tx), rt.accountId) != null) return;
        await claimIdempotencyKey(tx, {
          accountId: rt.accountId, key: `meta-request:${a.requestId}`, requestHash: a.hash,
          responseStatus: 200, responseJson: { applied: false, requestId: a.requestId, reason },
          seq: null, now,
        });
      });
    } catch (err) {
      log("organizer_request_refusal_unrecorded", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: a.requestId,
        ...refusalFields(err),
        reason: "the refusal is acknowledged now; if that fails too, the next pass decides it again",
      });
    }
  }

  /* The acks, then the one expunge: acks first, so a failed expunge leaves each answer beside its
     record (`alreadyAcked` next cycle). A RECORD LEAVES ONLY WITH ITS ANSWER, applied or refused:
     when its ack fails the record stays, and a later pass finds its key and acks from it — the key
     forbids a second apply and a second verdict, and its life covers the reader's window. One line
     per request for the loss and one for the resend, however many passes lie between. */
  let ackFailures = 0;
  const keep = new Set<unknown>();
  let keptApplied = 0;
  let keptRefused = 0;
  for (const a of toAck) {
    try {
      await io.ack(formatAck({
        requestId: a.requestId, mailboxId: rt.mailboxId,
        outcome: a.outcome, reason: a.reason, ackedAt: now, key,
      }));
      if (a.resend) {
        log("organizer_ack_resent", {
          mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: a.requestId,
          reason: "answered on an earlier pass; its acknowledgement is appended now",
        });
      }
    } catch (err) {
      ackFailures++;
      const held = a.ref !== undefined;
      if (held) {
        keep.add(a.ref);
        if (a.outcome === "applied") keptApplied++; else keptRefused++;
      }
      if (!a.resend) {
        log("organizer_ack_append_failed", {
          mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: a.requestId,
          ...refusalFields(err),
          reason: held
            ? "the record stays in the folder and a later pass acknowledges it from its recorded answer"
            : "the outcome is not carried back; the reader falls back to its window",
        });
      }
    }
  }
  // Kept for its answer: from the reader's side nothing has resolved yet.
  applied -= keptApplied;
  refused -= keptRefused;
  deferred += keep.size;
  const removing = toRemove.filter((r) => !keep.has(r));

  if (removing.length > 0) {
    try {
      await io.remove(removing);
    } catch (err) {
      // The records stay in the folder. Everything applied is still applied (the key holds), and
      // everything refused will be refused identically next cycle — so the counters are re-derived
      // rather than lost. Reported as deferred work, because from a reader's point of view nothing
      // has resolved yet.
      log("meta_request_expunge_failed", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, count: removing.length,
        ...refusalFields(err),
        reason: "the records stay in the folder; the next cycle's drain retries them",
      });
      deferred += applied + refused;
      applied = 0;
      refused = 0;
    }
  }

  if (applied > 0 || refused > 0 || deferred > 0 || standing > 0) {
    log("organizer_requests_drained", {
      mailboxId: rt.mailboxId, accountId: rt.accountId,
      applied, refused, deferred, standing, ackFailures,
    });
  }

  return { applied, refused, deferred, standing };
}

/**
 * The reader's own cycle — append pending decisions, and read what the organizer ANSWERED. ABSENCE IS
 * NOT EVIDENCE, and that was the bug: 0.14.1's first cut moved a row to `applied` when its record was
 * no longer in the folder, but an organizer removes a record for two OPPOSITE reasons (applied, or
 * refused), so a person who screened a sender out was told "done" whether their decision was carried
 * out or thrown away. An ACK does carry it: the organizer appends one naming the request and its
 * outcome, signed under the same account key, and this cycle moves a row only on an ack it can verify.
 * A `sent` row with no ack stays `sent` until {@link REQUEST_STALE_AFTER_MS} — "nobody took this", not
 * "applied". This is the ONLY reader-side function that writes to `ohmail/_meta`, and it writes exactly an APPEND.
 */

export interface DriveOutstandingRequestsResult {
  sent: number;
  applied: number;
  refused: number;
  expired: number;
}

const EMPTY_DRIVE_RESULT: DriveOutstandingRequestsResult = { sent: 0, applied: 0, refused: 0, expired: 0 };

/**
 * WHAT ONE `sent` ROW SHOULD BECOME THIS CYCLE — the state machine, as a pure function.
 *
 * Extracted so it can be exercised as ONE table rather than inferred from the IO-shaped function
 * around it. Every transition a row can make lives here, and the two that must NOT exist are as
 * much the point as the three that must:
 *
 *   · absence of the record is NOT `applied` (that was the defect)
 *   · absence of an ack is NOT `refused` either — it is silence, and silence times out
 */
export type ReaderOutcome =
  | { next: "applied" }
  | { next: "refused"; reason: RequestRefusalReason | null }
  | { next: "expired" }
  | { next: null };

export function readerOutcomeFor(input: {
  /** The ack naming this row's id, if one was found AND verified. */
  ack: AckRecord | null;
  /** When the record was appended. `null` cannot happen for a `sent` row; treated as "just now". */
  sentAt: Date | null;
  now: Date;
  staleAfterMs?: number;
}): ReaderOutcome {
  const { ack, sentAt, now } = input;
  const staleAfterMs = input.staleAfterMs ?? REQUEST_STALE_AFTER_MS;

  // AN ACK OUTRANKS THE CLOCK. A row that is past its window AND has an answer gets the answer:
  // the organizer did in fact respond, and "expired" would discard a real outcome in favour of a
  // timeout that only means "we had heard nothing yet".
  if (ack !== null) {
    if (ack.outcome === "applied") return { next: "applied" };
    return { next: "refused", reason: ack.reason };
  }

  // No ack. The ONLY other transition is the timeout, and it is measured from when the record was
  // appended rather than from when the decision was made — the person's decision is not stale, the
  // ORGANIZER's silence is.
  const since = sentAt ?? now;
  if (now.getTime() - since.getTime() > staleAfterMs) return { next: "expired" };

  // Still waiting. Whether the record is in the folder or not changes nothing: an organizer that
  // has taken the record but not yet acknowledged it is mid-cycle, not finished.
  return { next: null };
}

/**
 * EXPIRE THE `pending` ROWS THIS INSTALL WILL NEVER HAND OVER, and return how many.
 *
 * Separate from the cycle because it must run on a path the cycle returns from early: a mailbox
 * with no shared secret never reaches the append at all, and that is exactly where these rows
 * collect. See the call site for the sequence that produces one.
 */
async function expireNeverSent(
  db: WorkerDb,
  rt: { mailboxId: string; accountId: string },
  now: Date,
  log: (event: string, detail: Record<string, unknown>) => void,
): Promise<number> {
  const cutoff = new Date(now.getTime() - REQUEST_STALE_AFTER_MS);
  const pending = await db.transaction((tx) => listPendingRequests(tx, rt.mailboxId));
  const ids = pending.filter((r) => r.decidedAt.getTime() < cutoff.getTime()).map((r) => r.id);
  if (ids.length === 0) return 0;
  await db.transaction((tx) => markRequestsExpired(tx, ids, now, { from: "pending" }));
  log("outstanding_requests_never_sent", {
    mailboxId: rt.mailboxId, accountId: rt.accountId, expired: ids.length,
    reason: "queued but never handed over inside the window; the sender returns to the queue",
  });
  return ids.length;
}

/**
 * THE READER'S CYCLE. Appends what is `pending`, then settles what is `sent` against the acks.
 *
 * Gated on the account holding a request key, exactly as the organizer's drain is: a reader with
 * no key cannot SIGN a record, and an unsigned record is refused by every organizer — so appending
 * one would put an unverifiable message in a shared folder for nothing.
 */
export async function driveOutstandingRequests(
  db: WorkerDb,
  rt: RequestRuntime,
  /* `kind` is WRITTEN into the envelope this drain appends (`organizerKind: self.kind` below):
     a standalone phone stamps `mobile` here exactly as it does in the claim it renews. Nothing in
     this file RANKS a kind — the reading side of the envelope keeps its own `"unknown"` arm for a
     value a future build invents. */
  self: { installId: string; kind: OrganizerKind },
  now: Date,
  log: (event: string, detail: Record<string, unknown>) => void,
): Promise<DriveOutstandingRequestsResult> {
  if (!hasRequestReaderIo(rt.adapter)) return EMPTY_DRIVE_RESULT;
  let io: RequestReaderIo;
  try {
    io = rt.adapter.requestReaderIo();
  } catch {
    // A retired adapter — the cycle raced a reconnect or a shutdown. Not a drive failure: nothing
    // was owed and nothing was lost, and the next cycle has a live connection.
    return EMPTY_DRIVE_RESULT;
  }

  /* The rows that could not be handed over age out first, key or no key. Before the key check,
   * deliberately. Every other expiry predicate requires `sent`, so a `pending` row used to be
   * IMMORTAL — worse than it sounds, because the Screener list EXCLUDES a sender with an outstanding
   * decision, so the sender disappeared from the queue for ever while nothing was coming. The case
   * that reaches it is the one that returns below: the door queues from the HOLDER's advertised
   * capability, copied out of a claim anyone with append rights can write, so a forged claim on a
   * mailbox with no shared secret (OAuth) gets a row queued no cycle will ever append. The signature
   * makes that harmless for the ORGANIZER; this makes it harmless for the READER. Aged from `decidedAt`. */
  const expiredUnsent = await expireNeverSent(db, rt, now, log);

  const key = rt.requestKey;
  if (key === null) return { sent: 0, applied: 0, refused: 0, expired: expiredUnsent };

  /* The folder is read once, before anything is written, and both halves use it. It feeds two
   * questions that would otherwise each cost a round trip: which of this install's records are ALREADY
   * in the folder (so a re-append is skipped), and which acks are waiting. Reading first is also what
   * makes the append safe to retry: a cycle that appended a record and then failed to mark its row
   * `sent` leaves the row `pending` with its record already in the mailbox, and without this read the
   * next cycle would append the same signed decision AGAIN, and the one after that, for ever — a
   * growing pile of genuine records the organizer would dutifully apply. A read that FAILS stops the
   * cycle before it writes: appending without being able to check for a duplicate is exactly that loop. */
  let records: RawMetaMessage[];
  let folder: { count: number; bytes: number };
  try {
    const listed = await io.listMetaRecords();
    records = listed.records;
    folder = { count: listed.count, bytes: listed.bytes };
  } catch (err) {
    // An ABSENT FOLDER lands here too, by design: `listMetaRecords` raises rather than answering
    // `[]`, because a missing folder used to read as "every record is gone" and therefore as
    // "everything was applied". A folder past the enumeration's ceiling is named by its code.
    log("outstanding_requests_list_failed", {
      mailboxId: rt.mailboxId, accountId: rt.accountId,
      ...refusalFields(err), code: enumCodeOf(err),
    });
    return EMPTY_DRIVE_RESULT;
  }

  /* And the set is verified, not merely parsed. This decides whether a queued row is treated as
   * already handed over. Built from unverified envelopes it was a suppression primitive: an attacker
   * who can read the shared folder learns a request id, waits for the genuine record to go, and appends
   * an UNSIGNED message carrying that id — the next cycle takes the already-in-folder branch, marks the
   * row `sent`, and never appends the real record, which then earns no ack and sits until the window
   * reports "nobody took this". The decision is discarded silently. So the id must come off a record
   * that verifies under this mailbox's key AND names this install: another install's genuine record is
   * no reason for THIS one to stop appending its own. */
  const alreadyInFolder = new Set(
    requestEnvelopesIn(records)
      .filter((e): e is RequestEnvelope => !isMalformedRequest(e))
      .filter((e) => verifyRequestEnvelope(e, key)
        && e.mailboxId === rt.mailboxId
        && e.installId === self.installId)
      .map((e) => e.requestId),
  );
  /* ── AN ACK NAMING ANOTHER ROW OF THIS STORE IS NOT AN ANSWER HERE ────────────────────────
   *
   * The organizer signs ITS OWN row id into the ack, which this store has usually never minted,
   * so an unknown id is the organizer of this folder answering. An ack naming another row held
   * here was copied from that mailbox's folder, and would otherwise win the first-wins match
   * below: a refusal shown for a decision that was applied, and a second press. A failed read
   * drops the foreign acks this cycle; the rows stay `sent` and are matched on the next.
   */
  const verified = acksIn(records, key);
  const foreign = new Set(verified.map((a) => a.mailboxId).filter((id) => id !== rt.mailboxId));
  let otherRowsHere: Set<string> | null = new Set();
  if (foreign.size > 0) {
    try {
      otherRowsHere = await db.transaction((tx) => mailboxRowsHeld(tx, foreign));
    } catch (err) {
      otherRowsHere = null;
      log("outstanding_requests_list_failed", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, ...refusalFields(err),
      });
    }
  }
  const ackById = new Map<string, AckRecord>();
  for (const a of verified) {
    const answersHere = a.mailboxId === rt.mailboxId
      || (otherRowsHere !== null && !otherRowsHere.has(a.mailboxId));
    if (!answersHere) continue;
    if (!ackById.has(a.requestId)) ackById.set(a.requestId, a);
  }

  const pending = await db.transaction((tx) => listPendingRequests(tx, rt.mailboxId));

  const stillQueued = pending.filter(
    (r) => r.decidedAt.getTime() >= now.getTime() - REQUEST_STALE_AFTER_MS,
  );

  /* This install may not itself fill the folder past what its readers read. The appends are bounded
   * by the headroom measured this cycle over the folder's COUNT and BYTES (`requestAppendHeadroom`,
   * whose mixed-fleet rule is the invariant: at or under the 500-record window this install never
   * takes the folder past it, which builds up to 0.25.4 read claims by). Rows beyond it stay
   * `pending` and the shortfall is LOUD, naming the ceiling that bound it. Two writers CAN jointly
   * cross a ceiling; the ack sweep runs AHEAD of the read so the folder comes back down. */
  const room = requestAppendHeadroom(folder);
  const appendable = stillQueued.slice(0, room.headroom);
  if (appendable.length < stillQueued.length) {
    log("meta_request_append_deferred", {
      mailboxId: rt.mailboxId, accountId: rt.accountId,
      queued: stillQueued.length, appending: appendable.length,
      records: folder.count, bytes: folder.bytes, boundBy: room.boundBy ?? "window",
      ceiling: room.boundBy === "bytes" ? room.byteCeiling : room.recordCeiling,
      reason: appendable.length === 0
        ? "ohmail/_meta has no room for another request under its ceiling; these decisions stay "
          + "queued until the ack sweep makes room"
        : "the rest of this queue is appended on later cycles so the folder never crosses a "
          + "ceiling by this install's own records",
    });
  }

  let sentCount = 0;
  for (const req of appendable) {
    // EVERY KIND THE VOCABULARY ADMITS IS APPENDED. This read `req.kind !== "screener.decide"`
    // while the organizer's own apply table already carried `rule.*`, `message.move` and
    // `profile.update`, so a move, a rule edit, a signature or an away setting made on a reader was
    // written to the database, reported to the person as waiting for the organizing machine, and
    // appended nowhere that machine reads. A row of a kind this build does not know is still left
    // `pending` — it is THIS install's own insert, so an unknown kind is a build mismatch to
    // investigate, not evidence to act on.
    if (!isRequestKind(req.kind)) {
      log("outstanding_request_kind_unappendable", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: req.id, kind: req.kind,
      });
      continue;
    }

    // ── THE APPEND AND THE BOOKKEEPING ARE SEPARATE TRIES, AND THE READ ABOVE IS WHAT MAKES
    //    THE SPLIT SAFE ────────────────────────────────────────────────────────────────────────
    //
    // One try around both meant a database failure AFTER a successful APPEND was caught as "the
    // append failed", and the row stayed `pending`. Splitting them lets the two failures say
    // different things — but splitting ALONE does not fix the loop, because a `pending` row is
    // still a row the next cycle wants to append. `alreadyInFolder` is the half that closes it:
    // the record is out there, so this cycle skips straight to the bookkeeping.
    if (alreadyInFolder.has(req.id)) {
      try {
        await db.transaction((tx) => markRequestsSent(tx, [req.id], now));
        sentCount++;
      } catch (err) {
        log("outstanding_request_mark_sent_failed", {
          mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: req.id,
          ...refusalFields(err),
          reason: "the record is already in the folder; the row is retried next cycle",
        });
      }
      continue;
    }

    try {
      const raw = formatRequest({
        requestId: req.id,
        kind: req.kind,
        mailboxId: rt.mailboxId,
        installId: self.installId,
        organizerKind: self.kind,
        decidedAt: req.decidedAt,
        payload: req.payload,
        key,
      });
      await io.append(raw);
    } catch (err) {
      log("outstanding_request_append_failed", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: req.id,
        ...refusalFields(err),
        reason: "the request stays pending; the next cycle appends it",
      });
      continue;
    }

    try {
      await db.transaction((tx) => markRequestsSent(tx, [req.id], now));
      sentCount++;
    } catch (err) {
      // The record IS in the folder now. The row stays `pending`, and the NEXT cycle finds its id
      // in `alreadyInFolder` and marks it rather than appending a second copy. That is the whole
      // reason this branch can afford to do nothing but log.
      log("outstanding_request_mark_sent_failed", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: req.id,
        ...refusalFields(err),
        reason: "the record was appended; the next cycle marks the row without re-appending",
      });
    }
  }

  const sent = await db.transaction((tx) => listSentRequests(tx, rt.mailboxId));
  if (sent.length === 0) {
    if (sentCount > 0) {
      log("outstanding_requests_driven", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, sent: sentCount, applied: 0, refused: 0, expired: 0,
      });
    }
    return { sent: sentCount, applied: 0, refused: 0, expired: expiredUnsent };
  }

  // `ackById` was built from the SAME read that answered the duplicate-append question above —
  // one FETCH serves both halves of this cycle. A second list here would be a second round trip
  // per poll per mailbox for an answer already in hand, and it is what this shape replaced.
  const appliedIds: string[] = [];
  const expiredIds: string[] = [];
  const refusedRows: Array<{ id: string; reason: RequestRefusalReason | null }> = [];

  for (const row of sent) {
    const outcome = readerOutcomeFor({ ack: ackById.get(row.id) ?? null, sentAt: row.sentAt, now });
    if (outcome.next === "applied") appliedIds.push(row.id);
    else if (outcome.next === "refused") refusedRows.push({ id: row.id, reason: outcome.reason });
    else if (outcome.next === "expired") expiredIds.push(row.id);
  }

  const skipped: Array<{ requestId: string; reason: string }> = [];
  if (appliedIds.length > 0) {
    // An applied rule request is applied to this install's own rows in the same unit, once every
    // live holder its press went to has carried it out (for a delete, or holds nothing under the
    // key) — unless the person wrote the row again after deciding it (`settleReaderRuleRows`).
    const appliedRules = sent.filter((r) => appliedIds.includes(r.id) && r.kind.startsWith("rule."));
    await db.transaction(async (tx) => {
      await markRequestsApplied(tx, appliedIds, now);
      for (const r of appliedRules) {
        const out = await settleReaderRuleRows(tx, rt.accountId, r);
        if (out.skipped) skipped.push({ requestId: r.id, reason: out.skipped });
      }
    });
  }
  for (const r of refusedRows) {
    /* A delete refused `no_such_rule` FINISHES its leg: nothing under the key runs on that mailbox.
       It can be the press's last leg to answer, so the belt is asked here too, in the same unit. */
    const row = r.reason === "no_such_rule" ? sent.find((s) => s.id === r.id && s.kind === "rule.delete") : undefined;
    await db.transaction(async (tx) => {
      await markRequestsRefused(tx, [r.id], r.reason, now);
      if (!row) return;
      const out = await settleReaderRuleRows(tx, rt.accountId, row);
      if (out.skipped) skipped.push({ requestId: r.id, reason: out.skipped });
    });
  }
  for (const k of skipped) log("reader_rule_settle_skipped", { mailboxId: rt.mailboxId, accountId: rt.accountId, ...k });
  if (expiredIds.length > 0) await db.transaction((tx) => markRequestsExpired(tx, expiredIds, now));

  if (sentCount > 0 || appliedIds.length > 0 || refusedRows.length > 0 || expiredIds.length > 0) {
    log("outstanding_requests_driven", {
      mailboxId: rt.mailboxId, accountId: rt.accountId,
      sent: sentCount, applied: appliedIds.length, refused: refusedRows.length, expired: expiredIds.length,
    });
  }

  return {
    sent: sentCount, applied: appliedIds.length,
    refused: refusedRows.length, expired: expiredIds.length + expiredUnsent,
  };
}


/**
 * The role flip, and the rows that would otherwise be immortal. Rows this install queued while a
 * reader do not disappear when it takes the mailbox over: they sit `pending` (no cycle appends them) or
 * `sent` (waiting for an ack from an organizer that is now this process), leaving the person on
 * "waiting for …" for ever — and a `pending` row is worse, since the Screener list EXCLUDES a sender
 * with an outstanding decision. They are EXPIRED, not applied (applying is wrong twice: it can
 * double-apply — a `pending` record may already be in the folder — and it can apply decisions the
 * person has since reversed, oldest-first). Expiring loses nothing: the sender returns to the queue and
 * the person decides again on the install that now organizes it, the same ending an unanswered decision gets.
 */
export async function settleOwnOutstandingRequests(
  db: WorkerDb,
  rt: { mailboxId: string; accountId: string },
  now: Date,
  log: (event: string, detail: Record<string, unknown>) => void,
): Promise<{ expired: number }> {
  // `pending` — never handed over, and nothing here will hand it over now.
  const pending = await db.transaction((tx) => listPendingRequests(tx, rt.mailboxId));
  const pendingIds = pending.map((r) => r.id);
  if (pendingIds.length > 0) {
    await db.transaction((tx) => markRequestsExpired(tx, pendingIds, now, { from: "pending" }));
  }

  // `sent` past the window — its record is either gone or unreadable, and no acknowledgement is
  // coming from an organizer that is this process. Inside the window it is left alone: this
  // install's own drain may still be about to read the record and answer it properly.
  const staleCutoff = new Date(now.getTime() - REQUEST_STALE_AFTER_MS);
  const staleSent = await db.transaction((tx) => listStaleSentRequests(tx, rt.mailboxId, staleCutoff));
  const sentIds = staleSent.map((r) => r.id);
  if (sentIds.length > 0) {
    await db.transaction((tx) => markRequestsExpired(tx, sentIds, now));
  }

  const expired = pendingIds.length + sentIds.length;
  if (expired > 0) {
    log("own_requests_settled", {
      mailboxId: rt.mailboxId, accountId: rt.accountId,
      expired, fromPending: pendingIds.length, fromSent: sentIds.length,
    });
  }
  return { expired };
}

/** Re-exported so the host census and tests can name the parser the drain actually uses. */
export { parseRequestEnvelope };
