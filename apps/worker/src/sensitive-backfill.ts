import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import {
  applyBodyBytesDelta, auditLog, bodyBytesOf, mailboxes, messageBodies, messages, recordChange,
  type Tx,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import {
  classifySensitivity, fingerprintDedupKey, messageFingerprint, normalizeMessageId, normalizeMime,
  prepareHtmlForStorage, silentLogger,
  type Logger, type NativeLocator, type NormalizedMessage, type SensitivityResult,
} from "@trafficflow/core";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";

/* ══ PUTTING BACK THE HTML A CLASSIFIER FALSE POSITIVE THREW AWAY ══
 * This pass no longer gates any suggestion: `ScreenerService.suggest` screens the LIVE bytes with
 * `redactForModel` and no longer reads `messages.no_ai`. What it is still for: a bulk sender's click
 * tracker escaped `/` to `-2F`, whose `-` put word boundaries around `2Fa` and matched `2fa`, so
 * ordinary mail was judged sensitive and stored with `message_bodies.html` DELETED. The classifier is
 * fixed but nothing re-reads a stored body, so the only remaining copy is on the mail server. It READS
 * only — `fetchRaw` is `BODY.PEEK[]` (no `\Seen`) — moving/flagging/writing nothing
 * (`sensitive-backfill.no-routing.test.ts`); a pre-filter re-classifies STORED text first so only a
 * message that clears is fetched. The over-redaction edge is closed since the four scheme names need a
 * code-shaped run (`packages/core/src/sensitive.ts#schemeNameNearCode`); `sensitive-backfill.test.ts` watches it. */

/**
 * Categorised rows examined per SQL page.
 *
 * The same 100 as every other pass in this directory, and NOT for their reason — no transaction
 * spans a page here (see {@link repairOne}). It is the read that is paged: a page is held in
 * memory while the messages in it are fetched one at a time over the network, and a thousand-row
 * page would be a thousand rows of state kept alive across minutes of I/O for no benefit.
 */
export const SENSITIVE_FP_BATCH = 100;

/**
 * Messages this pass may RE-READ from the mail server for one mailbox in one worker cycle. The bound
 * is about the CYCLE: `beat()` is the last statement and the leader is stale after two minutes, so a
 * pass sitting on a slow connection for a hundred fetches would miss the heartbeat and page an
 * operator. 25 is deliberately small and close to right — at this budget the cycle ran ~50 s against a
 * 30 s roster interval and logged `roster_pass_delayed` (a warning, not the 120 s outage). It self-
 * terminates (once the mailbox is marked, one indexed read per cycle), so the cost is transient. Re-
 * measure before raising for a much larger damaged set. Nothing is SKIPPED by being budgeted:
 * {@link refusedByMailbox} spends each cycle's budget on messages the last did not decide.
 */
export const SENSITIVE_FP_FETCHES_PER_CYCLE = 25;

/**
 * SQL pages one mailbox may walk in one cycle before the pass gives up and says so.
 *
 * A bound and not a `while (true)`. Termination here is the CURSOR and not an empty page — a
 * message the pass declines to repair STAYS a candidate — so a paging bug would otherwise be an
 * unbounded loop against the live database rather than one warning line.
 */
export const SENSITIVE_FP_MAX_PAGES = 200;

/**
 * The per-message byte ceiling handed to `fetchRaw`.
 *
 * 4 MiB. A message this pass wants is a newsletter or an invoice; anything an order of magnitude
 * larger is carrying attachments, and re-reading it in full to re-decide its text is a poor
 * trade against holding this mailbox's lock for the transfer. Over the ceiling the message is
 * counted `unreadable` and left redacted, which is the same outcome as never having tried.
 */
export const SENSITIVE_FP_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Messages this PROCESS has re-read and declined to repair, per mailbox — the TERMINATION ARGUMENT. A
 * cleared message leaves the candidate query; a fetched-and-REFUSED one does not, and with no persisted
 * cursor the next cycle re-reads it for ever, so this set is what makes the walk finish in
 * `ceil(candidates / budget)` cycles. In memory, not a column (losing it costs re-reads, not
 * correctness). Refusals SPLIT: {@link decidedRefusals} (classifier read the original and declined —
 * answers the marker may certify over) vs {@link undecidedRefusals} (original unreadable — a completed
 * walk holding any does NOT stamp). "Never stamp" being unsurvivable too, a blocked walk is counted and
 * after {@link SENSITIVE_FP_MAX_BLOCKED_WALKS} the marker (`mailboxes.sensitive_fp_backfill_at`) stamps
 * and says what over — process-scoped, so a restart means MORE looking, not a premature certificate. */
const decidedRefusals = new Map<string, Set<string>>();

/** Candidates this walk could not decide about — cleared at the end of every completed walk. */
const undecidedRefusals = new Map<string, Set<string>>();

/** Completed walks this process has left unstamped for this mailbox. See the block above. */
const blockedWalks = new Map<string, number>();

/**
 * The undecided ids the LAST blocked walk carried — what makes the bound per MESSAGE. A per-mailbox
 * count says "re-walked three times", which is not the claim that licenses the stamp: the claim is that
 * EVERY undecided message has been re-attempted three times. They come apart when the undecided set
 * changes mid-bound (a restored husk becomes eligible, fails one fetch, and falls through on walk three
 * having been tried ONCE), and the marker is durable, so it stays redacted for ever on a bound it never
 * had. So a walk whose undecided set contains anything the previous blocked walk did not RESTARTS the
 * count. Termination holds: the set is finite, every restart is a message that has not had its
 * attempts, and a set that stops growing runs the bound out.
 */
const lastUndecided = new Map<string, ReadonlySet<string>>();

/**
 * Completed walks that may end undecided before the pass certifies anyway.
 *
 * Three, and the unit is a WALK rather than a cycle: a walk is a full traversal of the mailbox's
 * damaged set, which under the fetch budget takes many cycles on the account this pass exists for.
 * So three walks is a genuinely fair re-attempt for a transient fault and a bounded one for a
 * permanent absence, which is the whole shape of the trade.
 */
export const SENSITIVE_FP_MAX_BLOCKED_WALKS = 3;

/** The set for one mailbox, created on first use. */
function setFor(m: Map<string, Set<string>>, mailboxId: string): Set<string> {
  const hit = m.get(mailboxId);
  if (hit) return hit;
  const fresh = new Set<string>();
  m.set(mailboxId, fresh);
  return fresh;
}

/**
 * DROP THIS PROCESS'S SHELVES FOR ONE MAILBOX — a restart, expressed as a function call.
 *
 * The whole hazard this file now guards against is process-scoped state deciding a durable
 * outcome, and the only way to test that claim from outside is to simulate the restart: run the
 * pass, drop the state, run it again, and assert what survives and what does not. Exported for
 * that, and used by nothing in production — the pass clears its own shelves when it stamps.
 */
export function resetSensitiveBackfillProgress(mailboxId: string): void {
  decidedRefusals.delete(mailboxId);
  undecidedRefusals.delete(mailboxId);
  blockedWalks.delete(mailboxId);
  lastUndecided.delete(mailboxId);
}

/**
 * Did `fetchRaw` refuse this message for being OVER THE CEILING, rather than fail to read it?
 *
 * `RawMessageTooLargeError` (`packages/core/src/adapters/imap.ts`) carries the stable code
 * `ERAWTOOLARGE` and is thrown from `RFC822.SIZE` BEFORE any bytes move — so the connection is
 * intact and the only thing missing is the original's bytes. That is a different fact from "gone"
 * or "unparseable", and the one the over-ceiling fallback keys off. Matched by CODE and not
 * `instanceof`: the code is a documented part of the error's contract and survives every module
 * boundary a bundled worker could put between the throw site and here.
 */
function isOverCeiling(err: unknown): boolean {
  return typeof err === "object" && err !== null
    && (err as { code?: unknown }).code === "ERAWTOOLARGE";
}

export interface SensitiveBackfillDeps {
  db: Tx;
  adapter: MailboxAdapter;
  accountId: string;
  mailboxId: string;
  log?: Logger;
  now?: () => Date;
  /** Test seam. Default {@link SENSITIVE_FP_BATCH}. */
  batch?: number;
  /** Test seam. Default {@link SENSITIVE_FP_FETCHES_PER_CYCLE}. */
  fetchesPerCycle?: number;
  /** Test seam. Default {@link SENSITIVE_FP_MAX_PAGES}. */
  maxPages?: number;
  /** Test seam. Default {@link SENSITIVE_FP_MAX_BYTES}. */
  maxBytes?: number;
  /**
   * Test seam for {@link decidedRefusals} — the messages re-read and DECIDED against.
   *
   * Injectable so a test can drive two cycles and assert the SECOND one reads different
   * messages, which is the only way to see the termination property from outside.
   */
  refused?: Set<string>;
  /**
   * Test seam for {@link undecidedRefusals} — the messages this walk could not decide about.
   * Separate from {@link refused} because only one of the two may be certified by the marker.
   */
  undecided?: Set<string>;
}

export interface SensitiveBackfillResult {
  /** False ⇒ the marker was already stamped and nothing was read, fetched or written. */
  ran: boolean;
  /** Categorised rows the SQL walk looked at. */
  examined: number;
  /** Rows the pre-filter cleared, i.e. rows worth a network read. */
  candidates: number;
  /** Messages actually re-read from the mail server. */
  fetched: number;
  /** Candidates this process had already re-read and declined — see {@link refusedByMailbox}. */
  skipped: number;
  /** Messages repaired: html restored, text un-redacted, flags and category corrected. */
  cleared: number;
  /**
   * Repaired FROM THE STORED TEXT because the original was over the re-read ceiling — see the
   * over-ceiling arm of the fetch `catch`. Counted apart from {@link cleared} because it is a
   * different, lesser repair: the sensitivity is cleared so the row is readable again, but the html
   * the false positive DELETED cannot be restored (the original is exactly the bytes we could not
   * read). The metadata comes clean; the body stays as redacted as it was stored.
   */
  clearedFromStored: number;
  /** Re-read, and the ORIGINAL still flags POSITIVELY. Correct — these stay redacted. */
  stillSensitive: number;
  /**
   * Re-read, and the original is INDETERMINATE — no positive match, but a reason we cannot call
   * it ordinary. Correct, and counted apart from {@link stillSensitive} because it means something
   * different: not "this is a credential" but "we still cannot say it is not one". It is the
   * outcome that tells an operator the classifier, rather than the repair, is what is left to fix.
   */
  stillWithheld: number;
  /** Gone from the server, over the ceiling, or unparseable. Left exactly as they were. */
  unreadable: number;
  /**
   * The locator no longer holds THIS message. Left alone, and counted separately from
   * `unreadable` because it means something different — see {@link isSameMessage}.
   */
  mismatched: number;
  /** The per-cycle fetch budget ran out; the rest resumes next cycle. */
  capped: boolean;
  /** The marker was stamped by this call. */
  marked: boolean;
  /**
   * Candidates this walk could not decide about — see {@link undecidedRefusals}. Non-zero on a
   * COMPLETED walk is what withholds the marker, so this is the number the guard suite asserts on.
   */
  undecided: number;
  /**
   * Completed walks this process has now left unstamped for this mailbox, after this call.
   *
   * Zero on a walk that stamped or did not finish. It is the bound's own counter, surfaced so a
   * test can watch the third blocked walk certify rather than having to reach into module state.
   */
  blockedWalks: number;
}

const EMPTY: SensitiveBackfillResult = {
  ran: false, examined: 0, candidates: 0, fetched: 0, skipped: 0, cleared: 0, clearedFromStored: 0,
  stillSensitive: 0, stillWithheld: 0, unreadable: 0, mismatched: 0, capped: false, marked: false,
  undecided: 0, blockedWalks: 0,
};

/** One candidate, as it sits on disk — every field the pre-filter and the identity check read. */
interface CandidateRow {
  messageId: string;
  dedupKey: string;
  messageIdHeader: string | null;
  subject: string;
  storedText: string;
  /**
   * The stored html, which for the SECOND damage class below is present rather than deleted.
   *
   * A positively-sensitive row stores no html at all, so this is NULL for every candidate the
   * pass was originally written for and {@link fromStoredRow} loses nothing by reading it. A
   * `no_ai` row DOES keep its html (redacted), and that is real evidence the pre-filter must be
   * allowed to see — see {@link fromStoredRow} for what happens when it is not.
   */
  storedHtml: string | null;
  locator: NativeLocator | null;
}

/**
 * THE PASS. Once per mailbox: find the mail a false positive stored redacted, re-read the
 * originals, and repair the ones the fixed classifier clears.
 *
 * Takes a database handle and an adapter and nothing else, so a test drives it with no worker,
 * no lease and no network. The transactional claims PGlite cannot see — `FOR UPDATE`, two
 * concurrent drivers, exactly one delta per repair — live in `sensitive-backfill.pg.test.ts` on
 * real Postgres, because an embedded database cannot exercise them.
 */
export async function sensitiveBackfillPass(
  deps: SensitiveBackfillDeps,
): Promise<SensitiveBackfillResult> {
  const { db, adapter, accountId, mailboxId } = deps;
  const log = deps.log ?? silentLogger;
  const now = deps.now ?? (() => new Date());
  const batch = deps.batch ?? SENSITIVE_FP_BATCH;
  const fetchBudget = deps.fetchesPerCycle ?? SENSITIVE_FP_FETCHES_PER_CYCLE;
  const maxPages = deps.maxPages ?? SENSITIVE_FP_MAX_PAGES;
  const maxBytes = deps.maxBytes ?? SENSITIVE_FP_MAX_BYTES;

  // ── THE MARKER IS THE WHOLE GATE, AND IT IS READ BEFORE ANYTHING ELSE ────────────────────
  const [mailbox] = await db.select({
    id: mailboxes.id, backfilledAt: mailboxes.sensitiveFpBackfillAt,
  }).from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
  if (!mailbox) return EMPTY;
  if (mailbox.backfilledAt) return EMPTY;

  // A backend that cannot re-read a message cannot run this pass. `fetchRaw` is optional on the
  // port so every fake and every alternative backend keeps compiling; absent, the marker stays
  // NULL and a deployment that CAN read does the work later.
  if (!adapter.fetchRaw) {
    log.warn("sensitive_fp_backfill_unsupported", {
      mailboxId, accountId,
      reason: "this adapter cannot re-read a whole message, so the damaged bodies are left as " +
        "they are and the marker is NOT written",
    });
    return EMPTY;
  }

  const result: SensitiveBackfillResult = { ...EMPTY, ran: true };
  // TWO shelves, and only the first may ever be certified — see the block above
  // {@link decidedRefusals}. Both are consulted by the same skip below, because either way this
  // walk has already spent a fetch on the message.
  const decided = deps.refused ?? setFor(decidedRefusals, mailboxId);
  const undecided = deps.undecided ?? setFor(undecidedRefusals, mailboxId);
  let cursor: string | null = null;
  let exhausted = false;
  let pages = 0;

  for (; pages < maxPages; pages++) {
    if (result.fetched >= fetchBudget) { result.capped = true; break; }

    const page = await selectCandidates(db, { mailboxId, limit: batch, afterId: cursor });
    result.examined += page.length;
    if (page.length === 0) { exhausted = true; break; }
    cursor = page[page.length - 1]!.messageId;

    for (const row of page) {
      if (result.fetched >= fetchBudget) { result.capped = true; break; }

      // ── ALREADY TRIED AND REFUSED. SEE {@link decidedRefusals} FOR WHY THIS IS TERMINATION ──
      // Either shelf skips: this walk has spent its fetch on the message whichever way it went.
      // They part company at the MARKER, not here.
      if (decided.has(row.messageId) || undecided.has(row.messageId)) { result.skipped++; continue; }

      // THE PRE-FILTER. NO NETWORK BELOW THIS LINE UNLESS IT PASSES. `verdict !== "ordinary"` and not
      // `.sensitive`, because the repair now happens on exactly one verdict and a cost filter must ask
      // the question the repair will ask. The old `.sensitive` spelling was right only for a CATEGORY;
      // it is definitionally FALSE for a widened (indeterminate) row, so it stopped filtering and all
      // 416 damaged representatives on the account this exists for would have been re-read to be refused
      // on arrival. The verdict is KEPT, not recomputed: the over-ceiling arm of the fetch `catch`
      // reuses it as the oracle, so a non-ordinary STORED row is withheld here and never reaches it.
      const storedMsg = fromStoredRow(row);
      const storedVerdict = classifySensitivity(storedMsg);
      if (storedVerdict.verdict !== "ordinary") continue;
      result.candidates++;

      // NO LOCATOR — nothing to re-read from. UNDECIDED, not decided: the classifier never saw
      // this message's original, and a row whose locator ingest later repoints becomes repairable.
      if (!row.locator) { undecided.add(row.messageId); result.unreadable++; continue; }

      let fresh: NormalizedMessage;
      try {
        const raw = await adapter.fetchRaw(row.locator, { maxBytes });
        result.fetched++;
        fresh = await normalizeMime(Buffer.from(raw));
      } catch (err) {
        result.fetched++;

        // OVER THE CEILING IS NOT UNREADABLE. A `fetchRaw` that refused because the message exceeds
        // `maxBytes` did so from `RFC822.SIZE` before transferring (`RawMessageTooLargeError`, code
        // `ERAWTOOLARGE`), so the connection is fine and only the original's bytes are missing.
        // Counting that `unreadable` left the row redacted for ever, mis-withheld by a size limit. The
        // ruling: fall back to the STORED text as the oracle — we hold `storedVerdict` and reaching
        // here means it was `ordinary` (the pre-filter withholds anything else), so the five
        // sensitivity fields clear and the row becomes readable, but the deleted html is NOT restored
        // (its bytes are exactly what we could not read). The repairing verdict is still `ordinary`.
        if (isOverCeiling(err)) {
          if (await repairOne(db, accountId, row.messageId, storedMsg, storedVerdict, now())) {
            result.clearedFromStored++;
          }
          log.warn("sensitive_fp_backfill_oversize", {
            mailboxId, accountId, messageId: row.messageId,
            reason: "the original is over the re-read ceiling, so the sensitivity was cleared from " +
              "the stored text; the html the false positive deleted could not be restored",
          });
          continue;
        }

        // Gone, or a parse that failed. NEVER fatal: this message keeps the body it has, which is
        // the state it was already in, and the marker is not written for a walk that did not finish
        // — so a transient failure is retried on a later cycle.
        // UNDECIDED. This is the arm the whole split exists for: a dropped connection and a
        // permanently-expunged message are indistinguishable here, so neither may be certified
        // by a marker that stops the pass looking for ever.
        result.unreadable++;
        undecided.add(row.messageId);
        log.warn("sensitive_fp_backfill_unreadable", {
          mailboxId, accountId, messageId: row.messageId, err,
          reason: "the original could not be re-read, so this message keeps its redacted body",
        });
        continue;
      }

      // ── IS THIS THE SAME MESSAGE? ─────────────────────────────────────────────────────
      if (!isSameMessage(row, fresh)) {
        // UNDECIDED for the same reason: the original of THIS message was never read. The
        // locator is stale, and a later sync repointing it makes the row repairable again.
        result.mismatched++;
        undecided.add(row.messageId);
        log.warn("sensitive_fp_backfill_identity_mismatch", {
          mailboxId, accountId, messageId: row.messageId,
          reason: "the locator no longer resolves to this message — nothing is written, because " +
            "storing these bytes would put one person's mail into another message's row",
        });
        continue;
      }

      // THE VERDICT COMES FROM THE ORIGINAL, WHICH IS THE ENTIRE POINT. ONE verdict repairs:
      // `ordinary`; anything else (sensitive, or indeterminate) is left as it is. This used to be
      // `if (verdict.sensitive) refuse`, which admitted an INDETERMINATE original — safe by accident
      // under the old predicate (clearing `sensitivity_category` WAS the candidate query, so the row
      // left the walk). Under the widened {@link DAMAGED} it does not leave (it keeps `no_ai`), so the
      // row would be re-fetched and REWRITTEN every run, each emitting a `change_log` delta;
      // {@link refusedFor} cannot close that (in memory, forgotten on restart). It is also what the
      // repair is FOR: only clear where the fixed classifier says the message is clean.
      const verdict = classifySensitivity(fresh);
      // DECIDED — the classifier read the original and declined to clear it. This is an answer,
      // and the marker may certify over it.
      if (verdict.verdict !== "ordinary") {
        decided.add(row.messageId);
        if (verdict.sensitive) result.stillSensitive++;
        else result.stillWithheld++;
        continue;
      }

      if (await repairOne(db, accountId, row.messageId, fresh, verdict, now())) result.cleared++;
    }

    if (result.capped) break;
    // A SHORT PAGE IS THE END OF THE WALK, and it has to be read that way here rather than by
    // looping once more for an empty one. Termination is the CURSOR — a message this pass
    // declines to repair stays a candidate — so "loop until a page comes back empty" would spend
    // an extra query per run, and, worse, would leave a run whose last full-sized page was cut
    // short by the budget indistinguishable from one that finished. That difference decides
    // whether the marker is written.
    if (page.length < batch) { exhausted = true; break; }
  }

  if (pages >= maxPages) {
    log.warn("sensitive_fp_backfill_truncated", {
      mailboxId, accountId, maxPages, examined: result.examined,
      reason: "this mailbox's categorised mail exceeded one cycle's page bound — the marker is " +
        "NOT written, so the next cycle walks it again from the start",
    });
    return result;
  }
  // Deliberately not marked: an unfinished walk must be retried, and the marker means "done".
  //
  // ONE condition, not `!exhausted || capped`. That second clause was written first and it is
  // unreachable: both `break`s that set `capped` leave `exhausted` false, and the one that sets
  // `exhausted` runs only after `capped` has been ruled out — so no mutation can make it fail,
  // which makes it a clause that reads like a safety net and is not one. It came out when the
  // mutation testing said so.
  if (!exhausted) return result;

  // THE WALK REACHED THE END. THAT IS NOT THE SAME AS HAVING DECIDED EVERYTHING. Reaching the end
  // means every candidate was VISITED; one whose original could not be read was visited and not
  // decided, and the marker below is durable and final — stamping over an undecided message converts a
  // dropped TCP connection into a message redacted for the rest of its life, with no record a decision
  // was owed (see the split above {@link decidedRefusals}). So a completed walk holding undecided
  // refusals does NOT stamp: it clears them (the next walk genuinely re-tries them), counts itself, and
  // returns. The DECIDED shelf is kept across walks — those are answers, and losing them buys only a
  // re-read of mail already ruled on.
  result.undecided = undecided.size;
  // Captured before the shelves are cleared below, so the audit row can name what the certificate
  // does not cover. The IDS go on the durable audit row and NOT on a log line: `messageId`
  // (singular) is allowlisted for a ROW-SCOPED line, and an unbounded list of uuids on one line is
  // a size problem the jsonb payload does not have.
  const undecidedIds = [...undecided];
  // THE BOUND IS PER MESSAGE, NOT PER MAILBOX — see {@link lastUndecided}. A walk that turned up an
  // undecided message the previous blocked walk had never seen starts the count again, because
  // that message has not had its attempts and the marker would certify over it.
  const previous = lastUndecided.get(mailboxId) ?? new Set<string>();
  const anyFresh = undecidedIds.some((id) => !previous.has(id));
  const blocked = anyFresh ? 0 : (blockedWalks.get(mailboxId) ?? 0);
  if (result.undecided > 0 && blocked + 1 < SENSITIVE_FP_MAX_BLOCKED_WALKS) {
    blockedWalks.set(mailboxId, blocked + 1);
    lastUndecided.set(mailboxId, new Set(undecidedIds));
    result.blockedWalks = blocked + 1;
    undecided.clear();
    log.warn("sensitive_fp_backfill_undecided", {
      mailboxId, accountId, undecided: result.undecided,
      walk: result.blockedWalks, maxWalks: SENSITIVE_FP_MAX_BLOCKED_WALKS,
      reason: "the walk finished but could not read some originals, so the completion marker is " +
        "NOT written and the next walk re-tries them — a marker written here would make a " +
        "transient read failure a permanent redaction",
    });
    return result;
  }

  // ── THE BOUND, AND WHAT IT CERTIFIES OVER (see {@link SENSITIVE_FP_MAX_BLOCKED_WALKS}) ────
  //
  // Three full walks have now visited these messages and none could read them, so the honest
  // reading is a permanent absence rather than a blip, and continuing to walk would spend a fetch
  // budget against somebody's mail host in perpetuity for a repair that cannot happen. The pass
  // stamps — and says so. The count rides the audit row below, which is what makes "N messages
  // were never decided" a fact an operator can select rather than the silence it used to be.
  if (result.undecided > 0) {
    result.blockedWalks = blocked;
    log.warn("sensitive_fp_backfill_certified_incomplete", {
      mailboxId, accountId, undecided: result.undecided,
      maxWalks: SENSITIVE_FP_MAX_BLOCKED_WALKS,
      reason: "every walk re-tried these and none could read the original; the marker is written " +
        "so the pass stops re-reading a mailbox it cannot repair. Clearing " +
        "`sensitive_fp_backfill_at` re-runs the whole pass, which is the documented recovery",
    });
  }

  // ── THE MARKER IS WRITTEN LAST, AND THE PREDICATE MAKES IT THE DATABASE'S ANSWER ─────────
  //
  // Claiming it first would make a crash permanent: a mailbox marked repaired with most of its
  // mail still unreadable and nothing that would ever look again. Written last, a crash
  // re-runs, and re-running is safe because a message this pass has cleared no longer carries a
  // category and drops out of the candidate query. `WHERE … IS NULL` means two drivers finishing
  // at once produce exactly one stamp — the same construction, for the same reason, as
  // `markKickstarted`.
  const stamped = await db.update(mailboxes).set({ sensitiveFpBackfillAt: now() })
    .where(and(eq(mailboxes.id, mailboxId), isNull(mailboxes.sensitiveFpBackfillAt)))
    .returning({ id: mailboxes.id });
  result.marked = stamped.length > 0;
  // The walk is finished, so nothing will ask about this mailbox again unless an operator clears
  // the marker — at which point re-trying everything is exactly what they asked for.
  decidedRefusals.delete(mailboxId);
  undecidedRefusals.delete(mailboxId);
  blockedWalks.delete(mailboxId);
  lastUndecided.delete(mailboxId);

  // ONE audit row for the pass, not one per message. The per-message record a client can act on
  // is the `change_log` delta each repair writes; this is the operator's account of a one-shot
  // correction, and its `inverse` is NULL deliberately — re-redacting a message the classifier
  // has now read in full and cleared is not an operation anybody would want performed.
  await db.insert(auditLog).values({
    accountId, action: "sensitive_fp_backfill",
    payload: {
      mailboxId, examined: result.examined, candidates: result.candidates,
      fetched: result.fetched, skipped: result.skipped, cleared: result.cleared,
      clearedFromStored: result.clearedFromStored,
      stillSensitive: result.stillSensitive, stillWithheld: result.stillWithheld,
      unreadable: result.unreadable, mismatched: result.mismatched,
      // WHAT THIS CERTIFICATE DOES NOT COVER. Zero on an ordinary completion; non-zero means the
      // marker was written after the bounded re-walks with these messages never decided, and the
      // ids are here so the account of the repair names what it could not repair. A certificate
      // that cannot express its own gaps is how the marker came to launder a dropped connection
      // into a permanent redaction in the first place.
      undecided: result.undecided,
      ...(result.undecided > 0 ? { undecidedMessageIds: undecidedIds } : {}),
    },
    inverse: null,
  });

  // `skipped` is in the audit payload above and deliberately NOT on this line. The log census
  // (`packages/core/src/log.ts`) records `skipped` as deliberately absent, for a good reason about
  // a DIFFERENT quantity — the cron wrapper's "was this pass skipped" — and adding the name here would make
  // that note false to serve a diagnostic count. The audit row is jsonb and carries it.
  log.info("sensitive_fp_backfill_complete", {
    mailboxId, accountId, examined: result.examined, candidates: result.candidates,
    fetched: result.fetched, cleared: result.cleared, clearedFromStored: result.clearedFromStored,
    stillSensitive: result.stillSensitive, unreadable: result.unreadable,
    mismatched: result.mismatched, marked: result.marked,
  });
  return result;
}

/**
 * WHAT "DAMAGED" MEANS — the one predicate, used by both the walk and the write. It was
 * `sensitivity_category IS NOT NULL`, which missed most of the damage: a false positive has TWO
 * outcomes — POSITIVELY SENSITIVE (a vocabulary match: `sensitivity_category` set, text redacted, html
 * DELETED) and INDETERMINATE (`credential_shape`, `auth_url_token`, `unsupported_script`, …: category
 * NULL, `no_ai`/`no_kb` set, body redacted via `storeRedactedBody`, html kept). The second is invisible
 * to `IS NOT NULL` (measured 416 this way vs 119 with a category, 78% unseen). Selects on `no_ai` and
 * not `no_kb` because `no_ai` is the flag the Screener's `aiEligible` reads, so its wrongness is the
 * defect; the pair admits the same rows today and would change meaning if they diverged.
 */
const DAMAGED = sql`(${messages.sensitivityCategory} is not null or ${messages.noAi} = true)`;

/**
 * One page of the mail a false positive may have damaged, oldest id first. The candidate set is
 * deliberately WIDE and the filtering is NOT here: every categorised message is selected, and whether
 * it can be repaired is decided by the classifier in TypeScript twice (stored text as a cost filter,
 * original as the verdict) — expressing that in SQL would be a second classifier. NOT LOCKED, unlike
 * every other pass here, because a page is held across network reads and `FOR UPDATE` would hold row
 * locks for minutes; the serialization point is `repairOne`, which re-reads its row under a lock as it
 * writes. `folder_state`, `message_states`, `drafts`, `approvals` are NOT consulted: `rule-retro` and
 * kickstart exclude triaged mail because they MOVE it, but this pass moves nothing — it restores
 * text/html where the user left the message. */
async function selectCandidates(
  db: Tx, opts: { mailboxId: string; limit: number; afterId: string | null },
): Promise<CandidateRow[]> {
  const filters = [
    eq(messages.mailboxId, opts.mailboxId),
    DAMAGED,
    // A WITHHELD row is policy, not damage: its body was declined at the storage cap, and a
    // repair pass that re-fetched it from IMAP and stored the bytes would be a cap bypass
    // wearing a repair's name. Skipped here, at the population, so the fetch never happens.
    isNull(messageBodies.withheldReason),
  ];
  if (opts.afterId) filters.push(gt(messages.id, sql`${opts.afterId}::uuid`));

  const rows = await db.select({
    messageId: messages.id,
    dedupKey: messages.dedupKey,
    messageIdHeader: messages.messageIdHeader,
    subject: messages.subject,
    storedText: messageBodies.text,
    storedHtml: messageBodies.html,
    locator: messages.nativeLocator,
  }).from(messages)
    .innerJoin(messageBodies, eq(messageBodies.messageId, messages.id))
    .where(and(...filters))
    .orderBy(asc(messages.id))
    .limit(opts.limit);

  return rows.map((r) => ({
    messageId: r.messageId,
    dedupKey: r.dedupKey,
    messageIdHeader: r.messageIdHeader,
    subject: r.subject,
    storedText: r.storedText ?? "",
    storedHtml: r.storedHtml ?? null,
    locator: (r.locator as NativeLocator | null) ?? null,
  }));
}

/**
 * Write the repair for ONE message, and answer whether this call made it. THE TRANSACTION OPENS AFTER
 * THE NETWORK READ, never around it: `recordChange` takes the account's `account_sync_state` row lock
 * for its transaction, so spanning a `fetchRaw` would hold every API write for that account behind a
 * mail server's response time — hence one short transaction per message. THE LOCK-AND-RECHECK IS THE
 * IDEMPOTENCY: two drivers (cycle, and a failover worker) can both fetch and arrive; the `FOR UPDATE`
 * re-read makes the loser wake with the committed row, find `sensitivity_category` NULL, and write
 * nothing — one `change_log` delta, and re-running the whole pass safe. {@link DAMAGED}, not "did the
 * value change": those are the fields that say a message was withheld.
 */
async function repairOne(
  db: Tx,
  accountId: string,
  messageId: string,
  fresh: NormalizedMessage,
  verdict: SensitivityResult,
  now: Date,
): Promise<boolean> {
  const d = dialect(db);
  return db.transaction(async (tx) => {
    const [live] = await tx.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.id, messageId), DAMAGED))
      .limit(1)
      .for("update");
    if (!live) return false;

    // ── THE BODY, WRITTEN EXACTLY AS THE INGEST PATH WRITES IT ─────────────────────────────
    //
    // The FULL original, text and html — the same thing `pipeline.ts` now writes for every
    // message. Body redaction is removed, so there is no redacted branch to mirror: a re-read
    // original is stored verbatim. (This pass only reaches here for a row the fixed classifier
    // re-reads as `ordinary`; a still-sensitive original keeps its stored body and its label —
    // see the caller. A cap-withheld row never reaches here at all — `selectCandidates` skips
    // `withheld_reason` rows, because a withheld body is policy, not damage.)
    const [oldBody] = await tx.select({
      oldBytes: sql<number>`octet_length(${messageBodies.text}) + coalesce(octet_length(${messageBodies.html}), 0)`,
    }).from(messageBodies).where(eq(messageBodies.messageId, messageId)).limit(1);
    const storedText = fresh.textBody;
    const storedHtml = prepareHtmlForStorage(fresh.htmlBody);
    await tx.update(messageBodies).set({
      text: storedText,
      html: storedHtml,
    }).where(eq(messageBodies.messageId, messageId));

    // KEEP THE COUNTER TRUE: same transaction, before the `recordChange` below (the lock order
    // every `account_storage` writer holds), clamped at zero so a pre-backfill row can never
    // abort the repair. Not gated on any cap — a repair of a body the account already owns is
    // not new storage.
    await applyBodyBytesDelta(
      tx, d, accountId,
      bodyBytesOf({ text: storedText, html: storedHtml }) - Number(oldBody?.oldBytes ?? 0),
    );

    // ALL FIVE FIELDS, and that is not thoroughness for its own sake. The DTO computes
    // `sensitive` as `category !== null || no_ai || no_forward || no_kb || priority`, so a repair
    // that cleared only the category would restore the html and leave the message still marked
    // sensitive on screen — a half-fix that looks complete from the database.
    //
    // The flags are the classifier's own answer rather than literal `false`, because "not
    // sensitive" is not the same as "ordinary": an INDETERMINATE verdict clears the category and
    // stores the html while still withholding the message from a model. Writing what the
    // classifier said is what makes this row identical to one the fixed pipeline would have
    // written at ingest, which is the only definition of "repaired" worth having.
    await tx.update(messages).set({
      sensitivityCategory: verdict.category,
      noAi: verdict.flags.no_ai,
      noKb: verdict.flags.no_kb,
      noForward: verdict.flags.no_forward,
      priority: verdict.flags.priority,
      snippet: snippetOf(fresh),
      updatedAt: now,
    }).where(eq(messages.id, messageId));

    // The mirror holds the snippet and the sensitivity flags, so without a delta the client would
    // keep rendering the redacted preview and the sensitive badge until it next rebuilt from
    // scratch. `update` and never `move`: nothing about where this message lives has changed.
    await recordChange(tx, {
      accountId, entityType: "message", entityId: messageId, op: "update", meta: null,
    });
    return true;
  });
}

/**
 * Is the message we just read the message this row is about? A locator is a folder plus
 * `uidvalidity:uid`, and a UID is unique only while `uidvalidity` holds; a reset (or stale locator)
 * points at another message, and storing those bytes would write one person's mail into another's row
 * — so it is checked and a failure SKIPS the message. TWO forms of evidence, EITHER enough: the
 * fingerprint (`messages.dedup_key` is `fp1:` + a digest over sender/recipients/subject/date/body
 * hashes/attachment metadata, computed at ingest from these bytes) and the `Message-ID` (for legacy
 * dedup keys the digest cannot match; the header is stable across parser changes). Accepting either is
 * deliberate: a MIME parser change moves every fingerprint, so two witnesses make a silent stop happen twice.
 */
function isSameMessage(row: CandidateRow, fresh: NormalizedMessage): boolean {
  if (fingerprintDedupKey(messageFingerprint(fresh)) === row.dedupKey) return true;
  const stored = normalizeMessageId(row.messageIdHeader);
  const got = normalizeMessageId(fresh.canonical.messageIdHeader);
  return stored !== null && got !== null && stored === got;
}

/**
 * The stored row in the shape the classifier reads, and NOTHING else is invented. `attachments` is
 * empty because attachment BYTES are not on disk, making the pre-filter more permissive (costs fetches,
 * never a repair — the direction a cost filter must err in); the verdict is never taken from this
 * object. `html` IS READ NOW: it was `htmlBody: null`, true of a positively-sensitive row (html DELETED)
 * but false for the rows {@link DAMAGED} now admits (html kept, redacted). Passing null threw away the
 * filter's evidence — all 416 damaged representatives cleared a text-only pre-filter (~4,100 rows) vs
 * ~600 once stored html is included. It can only REMOVE fetches and cannot change a verdict (taken from
 * the original); the stored html is a `prepareHtmlForStorage`/redactor SUBSET, so a row flagging on it
 * would have flagged on the original too. */
function fromStoredRow(row: CandidateRow): NormalizedMessage {
  return {
    canonical: { messageIdHeader: null, bodyHash: "" },
    subject: row.subject,
    from: { name: null, address: "" },
    to: [],
    cc: [],
    date: null,
    headers: {},
    textBody: row.storedText,
    htmlBody: row.storedHtml,
    hasAttachments: false,
    attachments: [],
  };
}

/**
 * A short body preview — the same three operations `pipeline.ts#bodySnippet` performs, on the same
 * input. Always the FULL text now: body redaction is removed, so the snippet is never a redacted
 * one. Mirrored rather than imported (that function is private to the ingest module) and pinned by
 * a test so the two cannot drift.
 */
function snippetOf(normalized: NormalizedMessage): string {
  return normalized.textBody.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Exported for the guard that pins the mirror above. Not part of the pass's surface. */
export const __snippetOf = snippetOf;
