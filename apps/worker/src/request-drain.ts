import { createHash } from "node:crypto";
import {
  applyScreenerDecision, AccountErasedError, validateRequestPayload, claimIdempotencyKey,
  readAccountErasedAt,
  listPendingRequests, listSentRequests, markRequestsSent, markRequestsApplied,
  listStaleSentRequests, markRequestsExpired,
  type Tx,
} from "@trafficflow/db";
import {
  parseRequest, isMalformedRequest, formatRequest,
  type RequestIo, type RequestMessageRecord, type RequestRecord, type OrganizerKind,
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
 *  THE ORGANIZER'S DRAIN — apply what a reader decided, or refuse it (0.14.1)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `applyMetaRequests` runs in `visitMailbox`, AFTER the lease gate said `organize` and BEFORE
 * `runSyncCycle` — the ordering is load-bearing twice over:
 *
 *  · a reader's decision must land BEFORE this cycle's own classification runs, so a promoted
 *    rule this call creates governs mail arriving in the same pass;
 *  · this call writes `folder_state` rows with `reconcile_status: 'pending'`, exactly the shape
 *    `applyScreenerDecision`'s HTTP twin (`ScreenerService.applyAsOrganizer`) leaves for the
 *    worker's own reconciler — and `reconcileFolders` (`sync.ts`), called from `runSyncCycle`
 *    UNCONDITIONALLY every cycle via `reconcileMailbox`, is what actually MOVES the mail on IMAP.
 *    So this function performs NO physical move of its own: it writes the database exactly as
 *    the HTTP door does, and the cycle that follows it in the SAME pass is the reconciler that
 *    was always going to run anyway. There is nothing to duplicate.
 *
 * ── THE PAYLOAD IS UNTRUSTED ────────────────────────
 *
 * A request record is an RFC822 message another INSTALL appended to a folder this process now
 * reads. `parseRequest` is defensive about the WIRE FORMAT (malformed base64url, an unreadable
 * instant, a duplicate header); `validateRequestPayload` (`@trafficflow/db`) is defensive about
 * the DECODED CONTENT (a scope that is not `"sender"|"domain"`, a folder outside the decidable
 * five, a `dest`/`decision` disagreement, an address with no `@`). A record that fails either is
 * REFUSED — expunged from the folder and logged `organizer_request_refused` — never coerced into
 * a guess and never left standing silently.
 *
 * ── IDEMPOTENCY: A DUPLICATE DRAIN PRODUCES ONE RULE, NOT TWO ────────────────────────────────
 *
 * `claimIdempotencyKey` (`packages/db/src/idempotency.ts`), keyed `meta-request:<request id>`,
 * is claimed INSIDE the same transaction as `applyScreenerDecision` — before the effect, so a
 * lost claim means a concurrent or REPLAYED apply already committed and this one does nothing
 * further. The record is expunged EITHER WAY: a request whose apply this cycle skipped (because
 * an earlier cycle already claimed the key) is exactly as done as one this cycle just applied.
 * If the expunge itself fails — a driver refusal, a network drop — the record is left standing
 * and the NEXT cycle's drain sees it again: it re-attempts the claim, loses it (the key is
 * already spent), skips the apply, and tries the expunge again. That is what makes "a failed
 * expunge replays next cycle and the key refuses the duplicate" a safe loop rather than a
 * double-effect risk.
 */

/** An adapter that can hand out the request record IO. Mirrors `lease.ts#LeaseCapableAdapter`. */
export interface RequestIoCapableAdapter {
  requestIo(): RequestIo;
}

/** Does this adapter expose the request record IO? */
export function hasRequestIo(adapter: MailboxAdapter): adapter is MailboxAdapter & RequestIoCapableAdapter {
  return typeof (adapter as Partial<RequestIoCapableAdapter>).requestIo === "function";
}

export interface ApplyMetaRequestsResult {
  /** Requests successfully applied (or already applied on an earlier cycle, and now cleaned up). */
  applied: number;
  /** Requests refused — malformed wire format, invalid payload content, or an unhandled kind. */
  refused: number;
  /** Requests left standing for a retry — the apply or the expunge itself failed transiently. */
  deferred: number;
}

const EMPTY_RESULT: ApplyMetaRequestsResult = { applied: 0, refused: 0, deferred: 0 };

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE CHANNEL IS CONTAINED — REQUEST AUTHENTICITY IS NOT BUILT, SO THE DRAIN APPLIES NOTHING
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A request record has to be signed with a per-account key before this drain may trust it: what
 * it reads from `ohmail/_meta` is an RFC822 message ANY process with write access to the mailbox
 * could have appended, not necessarily this account's own reader install. Nothing in the wire
 * format tells those two apart, and a drain that cannot tell them apart is a drain that files a
 * stranger's mail on their say-so.
 *
 * That signing is OWED, not done: the per-account key and its delivery, the verification itself,
 * binding the mailbox INSIDE the signed body, an idempotency key bound to the content it stands
 * for, and bounds on how much one cycle will read. So the feature waits rather than shipping the
 * surface — and waiting is TWO changes, because either alone leaves a hole:
 *
 *  1. `apps/worker/src/lease.ts#ORGANIZER_CAPABILITIES` no longer advertises
 *     {@link CAPABILITY_REQUESTS} (`@trafficflow/db/organizer-role.js`) — a reader's own
 *     `readRequestEligibility` read (`packages/db/src/organizer-role.ts`) sees no organizer
 *     capable of `requests` and `ScreenerService.decide` throws `OrganizedElsewhereError` (409
 *     `organizer_outdated`) BEFORE a request row is ever queued.
 *  2. THIS GUARD — because (1) alone is insufficient: it stops THIS install from advertising the
 *     capability, but says nothing about a record some OTHER process wrote directly into
 *     `ohmail/_meta` regardless of what this organizer advertises. `applyMetaRequests` must
 *     refuse to apply — or even parse — anything it finds there until the signature exists to
 *     tell a genuine reader's request apart from a forged one. Every record found is left
 *     standing and never expunged: an unverifiable record is not evidence of anything, so it is
 *     not destroyed either — the same disposition an unknown kind or a future protocol version
 *     gets. Their COUNT is logged once per drain that finds any, so a nonzero count is a signal
 *     worth investigating rather than a silently swallowed one.
 *
 * Flip this back to `true` ONLY once signature verification is wired into
 * `parseRequest`/`validateRequestPayload` and reviewed as the untrusted-input boundary it is.
 */
const REQUEST_AUTHENTICITY_IMPLEMENTED = false as boolean;

/** `sha256(JSON.stringify(payload))` — a stable requestHash for the idempotency claim. Collisions cost nothing here: the KEY (`meta-request:<id>`) is what actually serializes, this is bookkeeping only. */
function payloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * THE ORGANIZER'S DRAIN AS THE HOSTS CALL IT — the the request-authenticity rule containment gate, and behind it
 * the machinery. See {@link REQUEST_AUTHENTICITY_IMPLEMENTED} for why the gate is shut.
 *
 * The gate is HERE, on the entry point every host reaches (`apps/worker/src/index.ts`,
 * `apps/worker/src/reconcile-cron.ts`, `apps/sidecar/src/engine.ts`), rather than repeated at each
 * of those three call sites: a fourth host added later inherits the containment by construction
 * instead of by remembering to copy a condition. `request-drain-host-census.test.ts` holds that
 * structurally — the hosts call THIS function and never {@link applyMetaRequestsUnguarded}.
 *
 * A suppressed cycle still LOOKS: it lists the folder so a nonzero count reaches the log, then
 * leaves every record exactly where it is — no parse, no apply, no expunge, the same disposition
 * an unknown kind or a future protocol version gets. An unverifiable record is not
 * evidence of anything, so it is not destroyed either.
 */
export async function applyMetaRequests(
  db: WorkerDb,
  rt: { mailboxId: string; accountId: string; adapter: MailboxAdapter },
  now: Date,
  log: (event: string, detail: Record<string, unknown>) => void,
): Promise<ApplyMetaRequestsResult> {
  if (REQUEST_AUTHENTICITY_IMPLEMENTED) return applyMetaRequestsUnguarded(db, rt, now, log);

  if (!hasRequestIo(rt.adapter)) return EMPTY_RESULT;
  let raw: Awaited<ReturnType<RequestIo["listRequests"]>>;
  try {
    raw = await rt.adapter.requestIo().listRequests();
  } catch {
    // An unreadable folder is a look that failed, and under containment there is nothing this
    // cycle would have done with the answer. Silent by design: the machinery's own
    // `meta_requests_list_failed` line tells an operator a DRAIN was missed, and no drain is owed
    // here.
    return EMPTY_RESULT;
  }
  if (raw.length === 0) return EMPTY_RESULT;
  log("organizer_requests_suppressed", {
    mailboxId: rt.mailboxId, accountId: rt.accountId, count: raw.length,
    reason: "request authenticity (the request-authenticity rule) is not yet implemented — nothing is applied",
  });
  return EMPTY_RESULT;
}

/**
 * DRAIN `ohmail/_meta` OF EVERY REQUEST RECORD THIS ORGANIZER CAN SEE, applying each in
 * `decided_at` then id order — two doors deciding one sender in one cycle land in the order the
 * human made them.
 *
 * **UNGUARDED, AND NO HOST MAY CALL IT WHILE THE GATE IS SHUT.** This is the machinery ruling
 * that rule contains: it trusts what it reads out of a folder any process with write access to the
 * mailbox could have appended to. It stays exported so its behaviour remains under test while the
 * channel is inert (`request-drain.test.ts`), and so enabling it later is one function rather
 * than a commented-out body to restore. `applyMetaRequests` above is the door; this is the room.
 */
export async function applyMetaRequestsUnguarded(
  db: WorkerDb,
  rt: { mailboxId: string; accountId: string; adapter: MailboxAdapter },
  now: Date,
  log: (event: string, detail: Record<string, unknown>) => void,
): Promise<ApplyMetaRequestsResult> {
  if (!hasRequestIo(rt.adapter)) return EMPTY_RESULT;
  const io = rt.adapter.requestIo();

  let raw: Awaited<ReturnType<RequestIo["listRequests"]>>;
  try {
    raw = await io.listRequests();
  } catch (err) {
    // Mirrors the lease peek's own rule: an unreadable folder is a look that failed, not
    // evidence of anything. The next cycle tries again.
    log("meta_requests_list_failed", {
      mailboxId: rt.mailboxId, accountId: rt.accountId,
      err: err instanceof Error ? err.message : String(err),
    });
    return EMPTY_RESULT;
  }
  if (raw.length === 0) return EMPTY_RESULT;

  const parsed = raw
    .map((m) => ({ ref: m.ref, record: parseRequest(m.raw, m.ref) }))
    .filter((p): p is { ref: unknown; record: RequestMessageRecord } => p.record !== null);
  if (parsed.length === 0) return EMPTY_RESULT;

  const removeSafely = async (refs: readonly unknown[]): Promise<boolean> => {
    if (refs.length === 0) return true;
    try {
      await io.removeRequests(refs);
      return true;
    } catch (err) {
      log("meta_request_expunge_failed", {
        mailboxId: rt.mailboxId, accountId: rt.accountId,
        err: err instanceof Error ? err.message : String(err),
        reason: "the request record stays in the folder; the next cycle's drain retries it",
      });
      return false;
    }
  };

  let applied = 0;
  let refused = 0;
  let deferred = 0;

  // Malformed wire records (evidence of a request that cannot be trusted) are refused
  // immediately, in no particular order — there is no `decided_at` to sort them by.
  for (const p of parsed) {
    if (!isMalformedRequest(p.record)) continue;
    const ok = await removeSafely([p.ref]);
    if (ok) {
      refused++;
      log("organizer_request_refused", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, reason: `malformed: ${p.record.reason}`,
      });
    } else {
      deferred++;
    }
  }

  // Valid records, oldest decision first — `decided_at` then `requestId` (a stable tiebreak for
  // two decisions the same instant, which is otherwise order-free across two doors).
  const valid = parsed
    .map((p) => (isMalformedRequest(p.record) ? null : { ref: p.ref, record: p.record as RequestRecord }))
    .filter((v): v is { ref: unknown; record: RequestRecord } => v !== null)
    .sort((a, b) => {
      const byTime = a.record.decidedAt.getTime() - b.record.decidedAt.getTime();
      if (byTime !== 0) return byTime;
      return a.record.requestId < b.record.requestId ? -1 : a.record.requestId > b.record.requestId ? 1 : 0;
    });

  for (const { ref, record } of valid) {
    if (record.kind !== "screener.decide") {
      // `rule.*` is shaped and CHECK-closed in Postgres but has no applier yet. An
      // organizer that meets one today refuses it exactly as it refuses a kind it has never
      // heard of — never applies it, never guesses.
      const ok = await removeSafely([ref]);
      if (ok) {
        refused++;
        log("organizer_request_refused", {
          mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: record.requestId,
          reason: `unhandled kind: ${record.kind}`,
        });
      } else {
        deferred++;
      }
      continue;
    }

    const decision = validateRequestPayload(record.payload);
    if (!decision) {
      const ok = await removeSafely([ref]);
      if (ok) {
        refused++;
        log("organizer_request_refused", {
          mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: record.requestId,
          reason: "invalid payload",
        });
      } else {
        deferred++;
      }
      continue;
    }

    try {
      await db.transaction(async (tx) => {
        // FENCE FIRST, as the FIRST statement of this transaction — `erasure-fence.ts`'s own
        // rule, and NOT redundant with `applyScreenerDecision`'s own internal fence: that read
        // comes after `claimIdempotencyKey` below if this one is skipped, and a write before the
        // fence is exactly the lock-order `deleteAccount` depends on to close its own race
        // (`accounts FOR SHARE` first, always). Read here too, so the CATCH below (which needs
        // `AccountErasedError` to decide whether to expunge) sees it before any other write in
        // this transaction has touched a row.
        const erasedAt = await readAccountErasedAt(tx, rt.accountId);
        if (erasedAt != null) throw new AccountErasedError(rt.accountId);

        const claimed = await claimIdempotencyKey(tx, {
          accountId: rt.accountId,
          key: `meta-request:${record.requestId}`,
          requestHash: payloadHash(record.payload),
          responseStatus: 200,
          responseJson: { applied: true, requestId: record.requestId },
          seq: null,
          now,
        });
        // NOT claimed = a previous cycle already applied this exact request (its expunge must
        // have failed, or the record is a re-append). Nothing to write again; only the cleanup
        // below is still owed.
        if (!claimed) return;
        await applyScreenerDecision(tx, {
          accountId: rt.accountId,
          mailboxId: rt.mailboxId,
          scope: decision.scope,
          address: decision.address,
          appliedFolder: decision.appliedFolder,
          decision: decision.decision,
          triggeringActionId: `screener:request:${record.requestId}`,
          now,
          // the request-authenticity rule.5 — "The drain never stamps `screening_baseline_at`". See
          // `ApplyScreenerDecisionInput.stampBaseline`'s own doc comment for why.
          stampBaseline: false,
        });
      });
    } catch (err) {
      if (err instanceof AccountErasedError) {
        const ok = await removeSafely([ref]);
        if (ok) {
          refused++;
          log("organizer_request_refused", {
            mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: record.requestId,
            reason: "account_erased",
          });
        } else {
          deferred++;
        }
        continue;
      }
      // Any other failure: leave the record standing. The idempotency key was NOT committed
      // (the throw rolled the transaction back), so the next cycle's claim succeeds and retries
      // the apply cleanly — this is not a partial-apply state.
      log("organizer_request_apply_failed", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: record.requestId,
        err: err instanceof Error ? err.message : String(err),
      });
      deferred++;
      continue;
    }

    const ok = await removeSafely([ref]);
    if (ok) {
      applied++;
    } else {
      // The apply committed (or was already committed); only the cleanup is owed now. Counted
      // as `deferred` rather than `applied` — the request is not YET fully handled from a
      // reader's point of view, which still sees it as `sent` until the record is gone.
      deferred++;
    }
  }

  if (applied > 0 || refused > 0 || deferred > 0) {
    log("organizer_requests_drained", {
      mailboxId: rt.mailboxId, accountId: rt.accountId, applied, refused, deferred,
    });
  }

  return { applied, refused, deferred };
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE READER'S OWN CYCLE — append pending decisions, observe what the organizer took (mail
 *  0088, 0.14.1)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * "The reader's cycle (both doors, after the peek): APPEND each `pending` → `sent`; any `sent`
 * whose id is absent from the folder → `applied`; `sent` older than 24 h and still present →
 * `expired`." (the ruling, verbatim). This is the ONLY function on a reader's side that writes to
 * `ohmail/_meta`, and it writes exactly one thing: an APPEND. A reader never expunges — that is
 * the organizer's exclusive act on this table, closing the loop
 * {@link applyMetaRequests} opens.
 *
 * `organizer_requests` is THIS install's own bookkeeping (see its own schema header): nothing
 * here reads or writes any OTHER install's rows, because there are none to see — a different
 * install's decisions about the same mailbox live in a database this one cannot reach.
 */

/** How long a `sent` request may sit in the mailbox before the reader gives up waiting. */
export const REQUEST_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface DriveOutstandingRequestsResult {
  sent: number;
  applied: number;
  expired: number;
}

const EMPTY_DRIVE_RESULT: DriveOutstandingRequestsResult = { sent: 0, applied: 0, expired: 0 };

export async function driveOutstandingRequests(
  db: WorkerDb,
  rt: { mailboxId: string; accountId: string; adapter: MailboxAdapter },
  self: { installId: string; kind: OrganizerKind },
  now: Date,
  log: (event: string, detail: Record<string, unknown>) => void,
): Promise<DriveOutstandingRequestsResult> {
  if (!hasRequestIo(rt.adapter)) return EMPTY_DRIVE_RESULT;
  const io = rt.adapter.requestIo();

  const pending = await db.transaction((tx) => listPendingRequests(tx, rt.mailboxId));
  let sentCount = 0;
  for (const req of pending) {
    // Only `screener.decide` has an appender today. A row of an unrecognised
    // kind is left `pending` rather than appended malformed — it is THIS install's own insert,
    // written by `ScreenerService.requestAsReader`, so an unrecognised kind here is a build
    // mismatch to investigate, not evidence to act on.
    if (req.kind !== "screener.decide") {
      log("outstanding_request_kind_unappendable", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: req.id, kind: req.kind,
      });
      continue;
    }
    try {
      const raw = formatRequest({
        requestId: req.id,
        kind: "screener.decide",
        installId: self.installId,
        organizerKind: self.kind,
        decidedAt: req.decidedAt,
        payload: req.payload,
      });
      await io.appendRequest(raw);
      await db.transaction((tx) => markRequestsSent(tx, [req.id], now));
      sentCount++;
    } catch (err) {
      log("outstanding_request_append_failed", {
        mailboxId: rt.mailboxId, accountId: rt.accountId, requestId: req.id,
        err: err instanceof Error ? err.message : String(err),
        reason: "the request stays pending; the next cycle appends it",
      });
    }
  }

  const sent = await db.transaction((tx) => listSentRequests(tx, rt.mailboxId));
  if (sent.length === 0) {
    if (sentCount > 0) log("outstanding_requests_driven", { mailboxId: rt.mailboxId, accountId: rt.accountId, sent: sentCount, applied: 0, expired: 0 });
    return { sent: sentCount, applied: 0, expired: 0 };
  }

  let presentIds: Set<string>;
  try {
    const raw = await io.listRequests();
    presentIds = new Set(
      raw
        .map((m) => parseRequest(m.raw, m.ref))
        .filter((r): r is RequestRecord => r !== null && !isMalformedRequest(r))
        .map((r) => r.requestId),
    );
  } catch (err) {
    // Could not look — leave every `sent` row exactly as it is. "I could not look" and "the
    // organizer took it" must not be reachable from one another, on the lease's own rule one
    // module over.
    log("outstanding_requests_list_failed", {
      mailboxId: rt.mailboxId, accountId: rt.accountId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { sent: sentCount, applied: 0, expired: 0 };
  }

  const goneNow = sent.filter((r) => !presentIds.has(r.id)).map((r) => r.id);
  if (goneNow.length > 0) {
    await db.transaction((tx) => markRequestsApplied(tx, goneNow, now));
  }

  // Only what is STILL present can be stale — a request the organizer already took is `applied`,
  // above, whatever its age.
  const staleCutoff = new Date(now.getTime() - REQUEST_STALE_AFTER_MS);
  const stillPresent = await db.transaction((tx) => listStaleSentRequests(tx, rt.mailboxId, staleCutoff));
  const expiredNow = stillPresent.filter((r) => presentIds.has(r.id)).map((r) => r.id);
  if (expiredNow.length > 0) {
    await db.transaction((tx) => markRequestsExpired(tx, expiredNow, now));
  }

  if (sentCount > 0 || goneNow.length > 0 || expiredNow.length > 0) {
    log("outstanding_requests_driven", {
      mailboxId: rt.mailboxId, accountId: rt.accountId,
      sent: sentCount, applied: goneNow.length, expired: expiredNow.length,
    });
  }

  return { sent: sentCount, applied: goneNow.length, expired: expiredNow.length };
}
