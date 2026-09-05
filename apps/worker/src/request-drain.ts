import { createHash } from "node:crypto";
import {
  applyScreenerDecision, AccountErasedError, validateRequestPayload, claimIdempotencyKey,
  readIdempotencyKey, IDEMPOTENCY_TTL_MS, readAccountErasedAt,
  listPendingRequests, listSentRequests, markRequestsSent, markRequestsApplied,
  listStaleSentRequests, markRequestsExpired, markRequestsRefused,
  type Tx,
} from "@trafficflow/db";
import {
  parseRequestEnvelope, isMalformedRequest, formatRequest, formatAck, canonicalRequest,
  requestEnvelopesIn, acksIn, verifyRequestEnvelope, decodeRequestPayload,
  REQUEST_PROTOCOL, MetaFolderTruncatedError,
  type RequestReaderIo, type RequestOrganizerIo, type RawMetaMessage,
  type RequestEnvelope, type RequestRecord, type AckRecord, type OrganizerKind,
  type RequestRefusalReason,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";

/**
 * `Tx` (`@trafficflow/db`'s `PgDatabase<any, any, any>`), NOT the hosted worker's own narrower
 * `WorkerDb` (`ReturnType<typeof makeDb>` from `@trafficflow/db/cloud`, the FULL combined
 * schema over a real `postgres` connection). Both callers of this module reach it: the hosted
 * worker's own database and the desktop engine's PGlite-backed `LocalDb` (the mail-only schema)
 * are structurally different drizzle instances, and this module's actual needs —
 * `db.transaction(...)`, threaded into functions that already accept `Tx` — are satisfied by
 * either one. Typing this narrowly to `WorkerDb` (which this file used to do) compiled for the
 * worker and failed the desktop engine's typecheck the moment it called in, for the same reason
 * `OrganizerProfileSync`'s callers pass `db as unknown as Tx` rather than a real shared type.
 */
type WorkerDb = Tx;

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE ORGANIZER'S DRAIN — apply what a reader decided, or refuse it and SAY SO (0.14.1)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE PAYLOAD IS UNTRUSTED, AND SO IS THE RECORD ITSELF ───────────────────────────────────
 *
 * A request record is an RFC822 message another install appended to a folder this process now
 * reads. Until 0090 the drain trusted that the message came from a reader of the same ohmail
 * account, and nothing established that: `ohmail/_meta` is an ordinary IMAP folder, so anyone with
 * APPEND rights on the mailbox — a shared-folder ACL, a sieve `fileinto`, a leaked device
 * credential, any mail client the person ever signed into — could write one, and this drain would
 * have applied it. A forged record buys a `promoted` rule, a `contacts` whitelist (a permanent
 * Screener bypass) and a mark-read pushed to the server, all indistinguishable in the product from
 * the account owner's own press.
 *
 * So the ORDER of the checks below is the security property, not an implementation detail:
 *
 *   1. read the headers and BOUND them            (`parseRequestEnvelope`, no decode yet)
 *   2. refuse a protocol or kind this build does not know   — LEAVE STANDING, never expunge
 *   3. VERIFY THE SIGNATURE                       (`verifyRequestEnvelope`, before any decode)
 *   4. check the record names THIS mailbox        (inside the signed body, so it cannot be moved)
 *   5. refuse a decision older than the stale window
 *   6. only now DECODE the payload                (`decodeRequestPayload`)
 *   7. validate the decoded content               (`validateRequestPayload`)
 *   8. apply, under a content-bound idempotency key
 *
 * Nothing between steps 1 and 3 parses base64 or JSON, so a hostile record costs a header read and
 * an HMAC and no more.
 *
 * ── NO KEY MEANS NO CHANNEL, AND THAT IS THE OFF-SWITCH ─────────────────────────────────────
 *
 * An organizer with no request key applies nothing and advertises no `requests` capability, so
 * readers are refused honestly at their own door. The key is HKDF over the mailbox PASSWORD
 * (`deriveRequestKey`), so "no key" means an OAuth mailbox, where each install holds its own token
 * and there is no shared secret to derive from — a real state with an honest answer, not a gap.
 *
 * There is no separate feature flag any more, and there must not be one again. The containment
 * 0.14.1 shipped with was a boolean constant standing in for exactly this condition, plus an
 * unguarded twin of each function behind it — and a stand-in for a real precondition is worse than
 * the precondition, because it can be true when the precondition is false. The gate is now a FACT
 * the drain reads. `request-drain-host-census.test.ts` holds that the retired names stay retired.
 *
 * ── AFTER `runSyncCycle`, UNDER A TIME BUDGET ───────────────────────────────────────────────
 *
 * This ran BEFORE the sync cycle in 0.14.1's first cut, so a decision would govern mail arriving
 * in the same pass. That ordering is inverted deliberately: the folder is attacker-writable, and a
 * drain that runs first lets anyone who can append to `ohmail/_meta` starve a mailbox's MAIL by
 * flooding it with records. Reading mail is the product; applying a queued decision one cycle
 * later is not a regression anybody can perceive. At most {@link REQUEST_DRAIN_MAX_PER_CYCLE}
 * records are handled per pass, oldest decision first, and the rest wait for the next one.
 *
 * ── IT PERFORMS NO PHYSICAL MOVE ────────────────────────────────────────────────────────────
 *
 * `applyScreenerDecision` writes `folder_state` rows with `reconcile_status: 'pending'`, exactly
 * the shape its HTTP twin (`ScreenerService.applyAsOrganizer`) leaves for the worker's own
 * reconciler. `reconcileFolders` is what actually MOVES the mail, and it runs unconditionally
 * every cycle. So this function writes the database exactly as the HTTP door does and lets the
 * pass that was always going to run do the rest — now the NEXT one, given the ordering above.
 *
 * ── IDEMPOTENCY IS BOUND TO THE CONTENT, NOT JUST THE ID ────────────────────────────────────
 *
 * `claimIdempotencyKey`, keyed `meta-request:<request id>`, is claimed inside the same transaction
 * as the apply. A LOST claim used to mean "already done, clean up" — but the id is a header a
 * forger chooses, so a second record REUSING a genuine id with different content would have been
 * silently skipped, and the genuine decision would have been consumed by the impostor's key. The
 * stored `requestHash` is now COMPARED: same content is a replay (clean up, ack `applied`),
 * different content is a `conflict` (refuse the impostor, and the genuine record still applies).
 */

/**
 * WHAT EITHER ROLE NEEDS TO WORK ON ONE MAILBOX.
 *
 * `requestKey` is passed IN rather than read here, and that is the shape the derivation forces: the
 * key is HKDF over the mailbox PASSWORD (`deriveRequestKey`), so it comes from the credential the
 * host already decrypted to open IMAP at all. This module has no credential and no business
 * decrypting one.
 *
 * `null` means there is no shared secret for this mailbox — an OAuth mailbox, where each install
 * holds its own token and there is nothing to derive from. Both roles stop on it, which is the
 * honest degraded mode rather than an error: no records are written, none are applied, and the
 * organizer advertises no `requests` capability, so a reader is refused at its own door.
 */
export interface RequestRuntime {
  mailboxId: string;
  accountId: string;
  adapter: MailboxAdapter;
  requestKey: string | null;
}

/** How long a decision may sit before both sides give up on it. ONE window, read by both roles. */
export const REQUEST_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * THE STALE WINDOW MUST BITE NO LATER THAN THE IDEMPOTENCY KEY EXPIRES, and that is a real
 * safety property rather than a tidy coincidence — `request-drain.test.ts` asserts it.
 *
 * The key at `meta-request:<id>` is what stops a second drain re-applying a record whose expunge
 * failed. It has a TTL (`IDEMPOTENCY_TTL_MS`). Once it expires, a record still sitting in the
 * folder would be claimable again — and a drain that re-claimed it would apply the same decision
 * a second time, writing a second promoted rule for a press that happened once.
 *
 * What closes that is this inequality. A record old enough for its key to have expired is, by
 * then, older than the stale window too, so step 5 refuses it as `stale` before step 8 can ever
 * re-claim it. Widen this constant past the TTL and the double-apply comes back.
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
  requestOrganizerIo(): RequestOrganizerIo;
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
  /** Left for a retry — the apply or the expunge itself failed transiently. */
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
class AlreadyAppliedError extends Error {
  constructor(readonly requestId: string) {
    super(`request ${requestId} was already applied on an earlier cycle`);
    this.name = "AlreadyAppliedError";
  }
}

/**
 * HOW FULL THE FOLDER WAS, when that is why a read failed — and `null` when it is not.
 *
 * The truncation is raised by the shared bounded read and reaches a drain WRAPPED in a
 * `RequestUnavailableError`, so the count lives one level down in `cause`. Reading only the outer
 * error found it never, which is worse than not logging it: a field that is always `null` reads as
 * "this was never a full folder" on exactly the incident where it always is.
 */
function recordsPresentIn(err: unknown): number | null {
  if (err instanceof MetaFolderTruncatedError) return err.total;
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  return cause instanceof MetaFolderTruncatedError ? cause.total : null;
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
  if (!hasRequestOrganizerIo(rt.adapter)) return EMPTY_RESULT;

  let io: RequestOrganizerIo;
  try {
    io = rt.adapter.requestOrganizerIo();
  } catch {
    // A retired adapter — the cycle raced a reconnect or a shutdown. `requestOrganizerIo()` throws
    // on one by design (`ImapAdapter`'s own `assertUsable`), and outside this try that throw
    // reaches the host as an ERROR-level drain failure. It is not one: nothing was owed and
    // nothing was lost, and the next cycle has a live connection.
    return EMPTY_RESULT;
  }

  // ── NO KEY, NO CHANNEL ──────────────────────────────────────────────────────────────────────
  //
  // Read BEFORE the folder is listed, so an organizer with no request channel costs no IMAP round
  // trip at all. A NULL key is the resting state of every account that has never used a second
  // install, and it is silent by design — logging it per mailbox per cycle would be a line about
  // nothing, forever.
  const key = rt.requestKey;
  if (key === null) return EMPTY_RESULT;

  /* ── THE SWEEP RUNS BEFORE THE READ, BECAUSE THE READ IS WHAT IT UNBLOCKS ─────────────────
   *
   * The organizer's ack sweep is the only thing that ever makes `ohmail/_meta` SMALLER, and it used
   * to sit after the bounded read below — which refuses a folder over the ceiling. So a folder that
   * crossed the ceiling BY ACKS could never come back down: the read refused, the sweep never ran,
   * the acks stayed, and every drain refused from then on. The compactor was locked behind the door
   * it exists to open, and nothing about that state is self-healing.
   *
   * Asked of the server by header and date, so it costs integers in and an expunge out — no FETCH,
   * no window, and nothing that a full folder can refuse. It was already a sweep "by AGE alone",
   * and INTERNALDATE of an ack this organizer appended is its `ackedAt` to the day.
   *
   * Failure is logged and swallowed: a sweep that could not run is exactly where this was before,
   * and it must not stop a drain that might still succeed.
   */
  if (typeof io.sweepStaleAcks === "function") {
    try {
      const swept = await io.sweepStaleAcks(new Date(now.getTime() - REQUEST_STALE_AFTER_MS));
      if (swept > 0) {
        log("meta_ack_sweep", { mailboxId: rt.mailboxId, accountId: rt.accountId, swept });
      }
    } catch (err) {
      log("meta_ack_sweep_failed", {
        mailboxId: rt.mailboxId, accountId: rt.accountId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let records: RawMetaMessage[];
  try {
    records = await io.listMetaRecords();
  } catch (err) {
    // Mirrors the lease peek's own rule: an unreadable folder is a look that failed, not evidence
    // of anything. The next cycle tries again.
    log("meta_requests_list_failed", {
      mailboxId: rt.mailboxId, accountId: rt.accountId,
      err: err instanceof Error ? err.message : String(err),
      // A FOLDER TOO FULL TO READ IN ONE WINDOW is the one thing that lands here and does not
      // clear on its own, so its count rides as a field rather than only inside the sentence.
      // Nothing is expunged on this path — a partial view of the folder is not evidence about
      // any record in it.
      records: recordsPresentIn(err),
    });
    return EMPTY_RESULT;
  }

  const envelopes = requestEnvelopesIn(records);

  /* ══ MATCHING IS PER-MAILBOX. COLLECTING IS NOT — AND THE TWO USED TO SHARE ONE FILTER ══════
   *
   * `acksIn` verifies under the ACCOUNT key, so everything here is this account's own bookkeeping,
   * written by one of its own organizers. Which mailbox an ack NAMES decides whether it is an
   * answer to anything in THIS folder, and that filter is load-bearing for the matching below: an
   * ack signed for one mailbox must never be read as an answer in another's folder.
   *
   * It is the wrong question for the SWEEP. `staleAckRefs` fed the only path that expunges an ack,
   * and it inherited the mailbox filter — so an ack that verifies under the account key but names
   * some other mailbox id could never be collected by anybody. Not by this drain, which had just
   * filtered it out; not by the drain for the mailbox it names, which reads a different folder.
   * It sat in the customer's folder for ever, counting against the read ceiling on every cycle of
   * every host.
   *
   * That is not hypothetical bookkeeping: a mailbox removed and re-added gets a NEW id, so an ack
   * written moments before the removal names an id no mailbox has any more, in a folder that is
   * still being read. The same shape covers an ack left behind by an older install and one
   * misfiled by a copy between folders.
   *
   * So the sweep is by AGE alone. Past the stale window the reader has given up on the row and no
   * ack can still be an answer to anything, whichever mailbox it names — while the matching below
   * keeps the mailbox filter exactly as it was. */
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
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return EMPTY_RESULT;
  }

  // Which ids already carry an ack from a previous cycle whose expunge failed. Re-acking them
  // would put a second ack in the folder for one request; the record still needs removing.
  const alreadyAcked = new Set(existingAcks.map((a) => a.requestId));

  /* ══ ORDER, THEN BOUND — AND THE TWO KINDS DO NOT SHARE A BUDGET ═══════════════════════════
   *
   * Well-formed records are sorted BEFORE the ceiling is applied, so "the first 200" means the 200
   * oldest decisions rather than whatever order the IMAP server happened to list them in.
   *
   * ── WHY THE CEILINGS ARE SEPARATE, WHICH THEY WERE NOT ───────────────────────────────────
   *
   * Malformed records used to be taken FIRST and out of the SAME 200, with the well-formed slice
   * computed as the remainder. That let the cheapest possible record starve the most expensive
   * guarantee: a malformed record needs no signature and no key — it need only carry
   * `X-Ohmail-Request: 1` and then be unreadable — so anyone with APPEND rights on the folder could
   * hold 200 of them in the read window and every genuine, SIGNED decision would be deferred, every
   * cycle, for as long as they cared to keep appending. The drain's own counters would report it as
   * healthy work: 200 refused, 0 applied, some deferred.
   *
   * The two kinds cost different things, so they get different allowances. Handling a malformed
   * record is one ref in a batch that is already being sent — no transaction, no idempotency claim,
   * no database work of any kind. Handling a well-formed one is a verify, a decode and a
   * transaction. There is no reason for the cheap one to consume the expensive one's ceiling, and
   * one very good reason for it not to.
   *
   * Both are still bounded, which is the point of a ceiling: an unbounded malformed sweep would
   * hand the same attacker an unbounded expunge instead.
   *
   * ── AND EXPUNGING AN UNVERIFIABLE RECORD IS THE CORRECT DISPOSITION, NOT AN EXCEPTION ────
   *
   * A malformed record is removed WITHOUT a signature check, and that does not contradict the rule
   * that a permanent disposition requires verification — it is the other side of it. That rule
   * exists because LEAVING A RECORD STANDING is a courtesy: it reserves the folder, and a record
   * that reaches it by merely SAYING `X-Ohmail-Protocol: 2` is a denial of service anyone can
   * mount. So standing is extended only to records that proved where they came from.
   *
   * Removal is the default, not the courtesy. A malformed record has no signature to check — the
   * fields the canonical form is taken over cannot be read — so verification is not something being
   * skipped here, it is something that does not exist for this record. The alternatives are to keep
   * it for ever (which is the reserved-folder attack, with extra steps) or to remove it. It is also
   * unambiguously OURS to remove: it carries this build's own discriminator, which nothing but this
   * build's writer emits, so it is either our own record gone wrong or a forgery — never somebody
   * else's mail, which is what the "not its to destroy" rule protects. */
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
  let deferred = budget - takeMalformed.length - takeWellFormed.length;

  let applied = 0;
  let refused = 0;
  let standing = 0;

  /** Refusals and applies both end in "remove this record", batched into ONE STORE+EXPUNGE. */
  const toRemove: unknown[] = [...staleAckRefs];
  /** Acks to append, one per record whose outcome is decided this cycle. */
  const toAck: Array<{ requestId: string; outcome: "applied" | "refused"; reason?: RequestRefusalReason }> = [];

  const settle = (
    e: { requestId?: string; ref?: unknown },
    outcome: "applied" | "refused",
    reason?: RequestRefusalReason,
  ): void => {
    if (e.ref !== undefined) toRemove.push(e.ref);
    if (e.requestId !== undefined && !alreadyAcked.has(e.requestId)) {
      toAck.push({ requestId: e.requestId, outcome, reason });
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

    // ── (2) A FUTURE PROTOCOL, OR A KIND WITH NO APPLIER: LEAVE IT STANDING ───────────────────
    //
    // The claim path's `c.protocol > ourProtocol` rule, one layer down. A record this build does
    // not understand is not evidence of anything and is not this build's to destroy: a newer
    // reader may be talking to an older organizer, and the record becomes applicable the moment
    // that organizer updates. Refusing it would be a lie (it is not invalid) and expunging it
    // would lose a decision a person made.
    //
    // ── (3) THE SIGNATURE, BEFORE ANY DECODE — AND BEFORE THE LEAVE-STANDING BRANCHES ───────
    //
    // The two "leave it standing" cases below USED TO SIT ABOVE THIS CHECK, on the reasoning that
    // a future protocol might sign over fields this build cannot reconstruct, so a verification
    // failure would mean "cannot check" rather than "forged". That reasoning is sound and the
    // ordering it produced was a hole big enough to switch the feature off from outside:
    //
    // leaving a record standing means never expunging it, and an unverified record could reach
    // that disposition by SAYING `X-Ohmail-Protocol: 2` — no key required. Two hundred such
    // messages, dated 1970 so they sort first, permanently occupy the per-cycle ceiling. Every
    // genuine decision falls outside the slice for ever, the folder grows without bound, and
    // nothing pages anybody, because a nonzero `standing` is documented as normal.
    //
    // So authenticity comes first, and "leave it standing" is a courtesy extended only to records
    // that PROVED they came from a holder of the account's key. The forward-compatibility cost is
    // real and is a constraint on the next protocol rather than a defect in this one: **a protocol
    // bump must keep the signature verifiable under this canonical form**, or must ship to
    // organizers before any reader emits it. That is a cheaper promise to keep than an
    // unauthenticated record with a permanent right to sit in someone's mailbox.
    if (!verifyRequestEnvelope(e, key)) {
      // ── REMOVED, BUT NOT ACKNOWLEDGED, AND THE ASYMMETRY IS DELIBERATE ────────────────────
      //
      // Every other refusal answers, because every other refusal is about a record this account's
      // own reader wrote and is waiting on. This one is not: a record that does not verify did not
      // come from a holder of the key, so there is no reader to answer TO — and writing one ack
      // per forged record would hand a flooder an amplifier, making this organizer APPEND once for
      // every message the attacker appends.
      //
      // The one honest case that lands here is our own reader's record after a key rotation. It
      // gets no ack and expires on the reader's own window instead, which is the behaviour
      // rotation is documented to have: old records refuse and expire.
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
    if (e.kind !== "screener.decide") {
      standing++;
      log("organizer_request_standing", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: e.requestId,
        reason: "unhandled_kind", kind: e.kind,
      });
      continue;
    }

    // ── (4) IT MUST NAME THE MAILBOX WHOSE FOLDER IT WAS READ FROM ───────────────────────────
    //
    // The id is inside the signed body, so a genuine record cannot be lifted out of one mailbox's
    // `_meta` and replayed into another's — the signature still verifies (same account key) but
    // the mailbox no longer matches, and this is the check that catches it.
    if (e.mailboxId !== rt.mailboxId) {
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

    // ── (7) AND VALIDATE WHAT CAME OUT ───────────────────────────────────────────────────────
    const decision = validateRequestPayload((decoded as RequestRecord).payload);
    if (!decision) {
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
      await db.transaction(async (tx) => {
        // FENCE FIRST, as the FIRST statement of this transaction — `erasure-fence.ts`'s own rule,
        // and NOT redundant with `applyScreenerDecision`'s own internal fence: a write before the
        // fence is exactly the lock order `deleteAccount` depends on to close its own race
        // (`accounts FOR SHARE` first, always). Read here too, so the CATCH below sees it before
        // any other write in this transaction has touched a row.
        const erasedAt = await readAccountErasedAt(tx, rt.accountId);
        if (erasedAt != null) throw new AccountErasedError(rt.accountId);

        // THE CONTENT COMPARISON, and it happens before the claim so the common conflict is
        // caught without a write. A live row for this id whose hash differs is an id being reused
        // for different content — refused, and the genuine record (a different id, or this same id
        // arriving with its original content) is untouched.
        const existing = await readIdempotencyKey(tx, rt.accountId, idemKey, now);
        if (existing !== null) {
          if (existing.requestHash !== hash) throw new RequestConflictError(e.requestId);
          throw new AlreadyAppliedError(e.requestId);
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
        // ── LOST THE CLAIM TO A CONCURRENT DRAIN, AND THE CONTENT STILL HAS TO BE COMPARED ──
        //
        // This used to step aside here, reasoning that "the winner already answered whether the
        // content matched". It does not follow, and REAL POSTGRES CAUGHT IT: the read above and
        // this claim are two statements, so two cycles can both see no key and then race the
        // unique index. The loser learns only that it lost — not what it lost TO. Stepping aside
        // reported the loser's record as `applied` when the winner may have applied entirely
        // different content under the same id, which is the substitution attack succeeding by
        // timing alone, and it is invisible under PGlite.
        //
        // So the loser re-reads. Under READ COMMITTED this statement takes a fresh snapshot and
        // therefore sees the winner's committed row: same hash is a genuine replay, a different
        // hash is the `conflict` the sequential path already refuses.
        if (!claimed) {
          const winner = await readIdempotencyKey(tx, rt.accountId, idemKey, now);
          if (winner !== null && winner.requestHash !== hash) {
            throw new RequestConflictError(e.requestId);
          }
          throw new AlreadyAppliedError(e.requestId);
        }

        await applyScreenerDecision(tx, {
          accountId: rt.accountId,
          mailboxId: rt.mailboxId,
          scope: decision.scope,
          address: decision.address,
          appliedFolder: decision.appliedFolder,
          decision: decision.decision,
          triggeringActionId: `screener:request:${e.requestId}`,
          now,
          // The drain never stamps `screening_baseline_at`. See
          // `ApplyScreenerDecisionInput.stampBaseline`'s own doc comment for why.
          stampBaseline: false,
        });
      });
      settle(e, "applied");
      applied++;
    } catch (err) {
      if (err instanceof AlreadyAppliedError) {
        // Exactly as done as one applied this cycle. The reader is owed the same `applied` ack.
        settle(e, "applied");
        applied++;
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
        err: err instanceof Error ? err.message : String(err),
      });
      deferred++;
    }
  }

  // ── THE ACKS, THEN THE ONE EXPUNGE ──────────────────────────────────────────────────────────
  //
  // Acks are appended BEFORE the records they answer are removed, and the order is load-bearing:
  // if the expunge fails after the acks land, the next cycle re-reads the same records, finds the
  // acks already there (`alreadyAcked`), and retries only the removal. The reverse order would
  // remove the record and then possibly fail to acknowledge it, leaving the reader with a decision
  // that vanished with no outcome — the exact ambiguity acks exist to remove.
  //
  // An ack that fails to append is NOT a reason to skip the expunge of a record that was applied:
  // the effect is committed, and re-applying next cycle is prevented by the key, so leaving the
  // record would only produce a permanent refusal loop. The reader falls back to its stale window.
  let ackFailures = 0;
  for (const a of toAck) {
    try {
      await io.ack(formatAck({
        requestId: a.requestId, mailboxId: rt.mailboxId,
        outcome: a.outcome, reason: a.reason, ackedAt: now, key,
      }));
    } catch (err) {
      ackFailures++;
      log("organizer_ack_append_failed", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: a.requestId,
        err: err instanceof Error ? err.message : String(err),
        reason: "the outcome is not carried back this cycle; the reader falls back to its window",
      });
    }
  }

  if (toRemove.length > 0) {
    try {
      await io.remove(toRemove);
    } catch (err) {
      // The records stay in the folder. Everything applied is still applied (the key holds), and
      // everything refused will be refused identically next cycle — so the counters are re-derived
      // rather than lost. Reported as deferred work, because from a reader's point of view nothing
      // has resolved yet.
      log("meta_request_expunge_failed", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, count: toRemove.length,
        err: err instanceof Error ? err.message : String(err),
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
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE READER'S OWN CYCLE — append pending decisions, and read what the organizer ANSWERED
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── ABSENCE IS NOT EVIDENCE, AND THAT WAS THE BUG ───────────────────────────────────────────
 *
 * 0.14.1's first cut moved a row to `applied` when its record was no longer in the folder. But an
 * organizer removes a record for two OPPOSITE reasons — it applied it, or it refused it — and in
 * both cases the record is gone. So a person who screened a sender out was told "done" whether
 * their decision had been carried out or thrown away as malformed, stale, or about the wrong
 * mailbox. No amount of care on this side could turn absence into evidence, because absence does
 * not carry the outcome.
 *
 * An ACK does. The organizer appends one naming the request and what became of it, signed under
 * the same account key, and this cycle moves a row only on an ack it can verify. A `sent` row with
 * no ack stays `sent` until {@link REQUEST_STALE_AFTER_MS} expires it — which is the honest thing
 * to say when nobody has answered: not "applied", not "refused", but "nobody took this".
 *
 * This is the ONLY function on a reader's side that writes to `ohmail/_meta`, and it writes exactly
 * one thing: an APPEND. A reader never expunges — that is the organizer's exclusive act, and since
 * 0090 the reader's IO object does not even have the verb (`RequestReaderIo`).
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

  /* ── THE ROWS THAT COULD NOT BE HANDED OVER AGE OUT FIRST, KEY OR NO KEY ──────────────────
   *
   * Before the key check, deliberately. Every other expiry predicate requires `sent`, so a
   * `pending` row used to be IMMORTAL — and immortal is worse than it sounds, because the Screener
   * list EXCLUDES a sender with an outstanding decision: the sender disappeared from the person's
   * queue for ever while nothing was coming.
   *
   * The case that reaches it is precisely the one that returns below. The door decides whether to
   * queue from the HOLDER's advertised capability, which is copied out of a claim anyone with
   * append rights on the folder can write; a forged claim on a mailbox this install has no shared
   * secret for (OAuth) gets a row queued that no cycle will ever append. The signature makes that
   * harmless for the ORGANIZER. This makes it harmless for the READER.
   *
   * Aged from `decidedAt` — when the person actually pressed, which is the clock they would
   * measure by — on the same window as everything else in this file.
   */
  const expiredUnsent = await expireNeverSent(db, rt, now, log);

  const key = rt.requestKey;
  if (key === null) return { sent: 0, applied: 0, refused: 0, expired: expiredUnsent };

  /* ── THE FOLDER IS READ ONCE, BEFORE ANYTHING IS WRITTEN, AND BOTH HALVES USE IT ───────────
   *
   * It feeds two questions that would otherwise each cost a round trip: which of this install's
   * records are ALREADY in the folder (so a re-append is skipped), and which acks are waiting.
   *
   * READING FIRST IS ALSO WHAT MAKES THE APPEND SAFE TO RETRY. A cycle that appended a record and
   * then failed to mark its row `sent` leaves the row `pending` with its record already in the
   * mailbox; without this read the next cycle would append the same signed decision AGAIN, and the
   * one after that, for ever — a growing pile of genuine records the organizer would dutifully
   * apply. So a `pending` row whose id is already present is not re-appended; it is simply marked.
   *
   * A read that FAILS stops the cycle before it writes. Appending without being able to check for
   * a duplicate is exactly the loop above, so "I could not look" must not be a reason to write.
   */
  let records: RawMetaMessage[];
  try {
    records = await io.listMetaRecords();
  } catch (err) {
    // An ABSENT FOLDER lands here too, by design: `listMetaRecords` raises rather than answering
    // `[]`, because a missing folder used to read as "every record is gone" and therefore as
    // "everything was applied".
    log("outstanding_requests_list_failed", {
      mailboxId: rt.mailboxId, accountId: rt.accountId,
      err: err instanceof Error ? err.message : String(err),
      // As above: a full folder is the failure worth naming with a number, and appending without
      // being able to check for a duplicate is the loop this read exists to prevent.
      records: recordsPresentIn(err),
    });
    return EMPTY_DRIVE_RESULT;
  }

  /* ── AND THE SET IS VERIFIED, NOT MERELY PARSED ───────────────────────────────────────────
   *
   * This decides whether a queued row is treated as already handed over. Built from unverified
   * envelopes it was a suppression primitive: an attacker who can read the shared folder learns a
   * request id, waits for the genuine record to go, and appends an UNSIGNED message carrying that
   * id. The next cycle would take the already-in-folder branch, mark the row `sent`, and never
   * append the real record — and since an unverifiable record earns no acknowledgement, the row
   * would sit until the window reported "nobody took this". The decision is discarded silently.
   *
   * So the id must come off a record that verifies under this mailbox's key AND names this
   * install: another install's genuine record is no reason for THIS one to stop appending its own.
   */
  const alreadyInFolder = new Set(
    requestEnvelopesIn(records)
      .filter((e): e is RequestEnvelope => !isMalformedRequest(e))
      .filter((e) => verifyRequestEnvelope(e, key)
        && e.mailboxId === rt.mailboxId
        && e.installId === self.installId)
      .map((e) => e.requestId),
  );
  /* ── AN ACK IS ONLY AN ANSWER FOR THE MAILBOX IT NAMES ────────────────────────────────────
   *
   * The mailbox is inside the ack's signed body, so an acknowledgement genuinely produced for one
   * of the account's mailboxes cannot be copied into another's folder and read as an answer there.
   * Without this filter it could: the signature verifies (same account key), and arriving at a
   * lower uid than the real answer it would win the first-wins match below — showing a person a
   * refusal for a decision that was applied, and inviting a second press that writes a second rule.
   */
  const ackById = new Map<string, AckRecord>();
  for (const a of acksIn(records, key)) {
    if (a.mailboxId !== rt.mailboxId) continue;
    if (!ackById.has(a.requestId)) ackById.set(a.requestId, a);
  }

  const pending = await db.transaction((tx) => listPendingRequests(tx, rt.mailboxId));

  const stillQueued = pending.filter(
    (r) => r.decidedAt.getTime() >= now.getTime() - REQUEST_STALE_AFTER_MS,
  );

  let sentCount = 0;
  for (const req of stillQueued) {
    // Only `screener.decide` has an appender today. A row of an unrecognised kind is left
    // `pending` rather than appended malformed — it is THIS install's own insert, so an
    // unrecognised kind here is a build mismatch to investigate, not evidence to act on.
    if (req.kind !== "screener.decide") {
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
          err: err instanceof Error ? err.message : String(err),
          reason: "the record is already in the folder; the row is retried next cycle",
        });
      }
      continue;
    }

    try {
      const raw = formatRequest({
        requestId: req.id,
        kind: "screener.decide",
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
        err: err instanceof Error ? err.message : String(err),
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
        err: err instanceof Error ? err.message : String(err),
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

  if (appliedIds.length > 0) await db.transaction((tx) => markRequestsApplied(tx, appliedIds, now));
  for (const r of refusedRows) {
    await db.transaction((tx) => markRequestsRefused(tx, [r.id], r.reason, now));
  }
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
 * THE ROLE FLIP, AND THE ROWS THAT WOULD OTHERWISE BE IMMORTAL.
 *
 * Rows this install queued while it was a reader do not disappear when it takes the mailbox over.
 * They sit `pending` — no cycle appends them any more — or `sent`, waiting for an acknowledgement
 * from an organizer that is now this very process and will never write one to itself. Both leave
 * the person looking at "waiting for …" for ever, and a `pending` row is worse than that: the
 * Screener list EXCLUDES a sender with an outstanding decision, so the sender vanishes from the
 * queue permanently while nothing is coming.
 *
 * ── THEY ARE EXPIRED, NOT APPLIED, AND THE FIRST VERSION OF THIS APPLIED THEM ────────────────
 *
 * Applying looked obviously right — the decision was a human's, on this install, and this install
 * now has the standing to carry it out — and it is wrong twice:
 *
 *  · **It can double-apply.** A `pending` row's record may ALREADY be in the folder: the reader's
 *    append can succeed and the row update fail, which is the state `alreadyInFolder` exists to
 *    recognise. The drain then applies that record, and this loop applies the same decision again.
 *    Sharing the drain's idempotency key does not fix it either, because the two paths cannot
 *    compute the same content hash — this one holds a row, not a record — so whichever wrote first
 *    would make the other read a hash mismatch and refuse a genuine record as a `conflict`.
 *  · **It can apply decisions the person has moved on from.** These rows accumulate for as long as
 *    the install could not hand them over, and applying them oldest-first lets the OLDEST decision
 *    win the final state for a sender who has since been decided the other way.
 *
 * Expiring loses nothing: the sender returns to the queue, where the person decides again on the
 * install that now organizes the mailbox — which is the honest offer, and one press rather than a
 * silent guess about what they meant weeks ago. It is also the same ending a reader's own cycle
 * gives an unanswered decision, so there is one story for "nobody took this" rather than two.
 *
 * Called from the ORGANIZER branch, so it runs precisely when the flip has happened.
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
