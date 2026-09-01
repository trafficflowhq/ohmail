import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import {
  applyBodyBytesDelta, auditLog, bodyBytesOf, mailboxes, messageBodies, messages, recordChange,
  type Tx,
} from "@trafficflow/db";
import {
  classifySensitivity, fingerprintDedupKey, messageFingerprint, normalizeMessageId, normalizeMime,
  prepareHtmlForStorage, silentLogger,
  type Logger, type NativeLocator, type NormalizedMessage, type SensitivityResult,
} from "@trafficflow/core";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   PUTTING BACK THE HTML A CLASSIFIER FALSE POSITIVE THREW AWAY
   ══════════════════════════════════════════════════════════════════════════════════════════

   ── THIS PASS NO LONGER GATES ANY SUGGESTION, AND THAT CHANGES WHY YOU WOULD RUN IT ────────

   Read this before scheduling another walk to "unblock the Screener": it will not unblock
   anything, because there is nothing left to unblock. Under the ruling that opened AI to outbound-consented mail
   `ScreenerService.suggest` no longer reads `messages.no_ai` at all — it screens
   the LIVE BYTES with `redactForModel` and asks about every held sender either way. A stale
   `no_ai = true` on a row is therefore invisible to the suggestion path.

   Measured on the reporting account the day the ruling landed: of 294 held representatives
   carrying a stale flag, the CURRENT detector fires on 81. The other 213 were already free
   without a single IMAP read.

   What this pass is still for is the thing its name says and the thing only it can do: the HTML
   it deleted is gone from the database and only exists on the mail server, so a mailbox whose
   bodies were mangled by the `2Fa` false positive still needs the walk to be readable. That is a
   DISPLAY repair, and it is worth ~4,100 IMAP reads only when someone is actually looking at
   unreadable mail — never as a prerequisite for AI.

   ── WHAT WENT WRONG, AND WHY FIXING THE CLASSIFIER WAS NOT THE END OF IT ───────────────────

   Bulk senders percent-escape the target inside a click tracker, so `/` becomes `-2F`. `-` is
   not a word character, which put a word boundary on each side of the three characters `2Fa`,
   and the sensitivity vocabulary read that as the standalone acronym `2fa`. Ordinary mail was
   therefore judged to contain an authentication code — and mail judged sensitive is stored with
   its text REDACTED and NO HTML AT ALL. Newsletters, invoices, delivery notices and monitoring
   alerts were filed unreadable, and the verdict was decided by a random token: three copies of
   one usage notice from one sender came out differently, because one copy's tracker happened to
   contain no escape.

   The classifier is fixed. That fix is forward-looking and cannot be anything else: nothing in
   this product re-reads a stored body, the single writer of `message_bodies.html` writes NULL
   for anything judged sensitive, and there is no rehydrate path. So the only remaining copy of
   the discarded HTML is the message sitting on the mail server, and getting it back means going
   to ask for it.

   ── IT RUNS HERE BECAUSE THIS IS WHERE THE CONNECTION IS ───────────────────────────────────

   Every other correction pass in this repo re-decides rows that are already on disk, which is
   why they can live anywhere. This one cannot decide ANYTHING from disk: the stored text has had
   its digits removed and its HTML deleted, so the evidence needed to overturn the verdict is
   precisely what the verdict destroyed. The original bytes are on the mail server, the worker is
   the only process that opens a connection to it (the API never does), and the pass needs
   nothing from the API host's service layer — the mail-domain and database packages are the whole
   of its imports, which is what makes this the right host rather than a dodge.

   ── IT READS. IT DOES NOT MOVE, FLAG, WRITE OR APPEND ──────────────────────────────────────

   `fetchRaw` is a `BODY.PEEK[]` fetch, which is the form of FETCH that does not set `\Seen`, so
   this cannot mark somebody's mail read by re-reading it. Nothing else on the adapter is called.

   And clearing a sensitivity category MOVES NO MAIL. The router reads the verdict computed in
   memory at ingest and never `messages.sensitivity_category`; the folder reconciler reads
   `folder_state` and nothing else. So this pass writes no `folder_state` row, no `move` change
   and no routing decision — and `sensitive-backfill.no-routing.test.ts` asserts each of those
   absences rather than leaving them to be inferred from what this file happens not to import
   today.

   ── THE PRE-FILTER IS WHAT MAKES THE COST HONEST, AND IT HAS A KNOWN EDGE ──────────────────

   Most of the flagged mail on the deployment this was measured on does NOT clear the fixed
   classifier on its STORED text — only about a quarter of it does. Re-reading all of it off
   somebody's mail server to sort it
   would be hundreds of network round trips for nothing, so the stored text is re-classified
   FIRST and only a message that clears on it is fetched.

   (The clear-on-stored count, not the smaller number this was first costed against. The two
   numbers answer different questions
   and both are right: 52 is the OLD-versus-NEW classifier delta — the messages the fix itself
   changed its mind about — while 219 is what the fixed classifier clears on text that has ALSO
   had its digit runs removed, which additionally admits every message whose only match was those
   digits. `your code is 482913`, stored as `your code is [REDACTED]`, no longer matches the
   digit-anchored arm. Each of those costs one read and is then correctly refused on the
   original.)

   The bias runs the safe way for the case this exists for: redaction removes digit runs, and the
   escaped tracker tokens that caused the false positive carry at most one digit each, so they
   survive redaction unchanged and the stored text answers the same as the original would. Where
   it can differ is that the stored text has no HTML, so a message can clear the pre-filter and
   still flag on the original — which costs one fetch and is then decided correctly, because the
   ORIGINAL is what the verdict is finally taken from.

   THE EDGE THAT USED TO BE WORTH WRITING DOWN, now CLOSED and kept here because the reasoning
   is what makes the pre-filter's cost decision legible: redaction can in principle take the
   digits OUT of a machine token, and a token with no digits left is one the classifier's masking
   no longer blanks. Such a message used to flag on the redacted text, fail the pre-filter, and
   never be fetched — a repair not attempted.

   It stopped being reachable when the four SCHEME NAMES (`otp`, `2fa`, `two-factor`,
   `multi-factor`) lost their standalone positive and came to need a code-shaped run beside them
   (`packages/core/src/sensitive.ts#schemeNameNearCode`). Whether the mask blanks a mangled
   tracker token no longer decides anything: the acronym it exposes is not a positive on its own,
   and an over-redacted token has had precisely the digits removed that a proximity test would
   need. `sensitive-backfill.test.ts` asserts the closure on the same fixture that used to pin
   the gap, including that the fixture still exposes a bounded `2fa` — so this is a watched
   behaviour and not a paragraph.

   The pre-filter remains a cost decision rather than a claim that the two classifications are
   equivalent: a message can still clear on stored text and flag on the ORIGINAL, which costs one
   fetch and is then decided correctly, because the original is what the verdict is taken from.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

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
 * Messages this pass may RE-READ FROM THE MAIL SERVER for one mailbox in one worker cycle.
 *
 * The bound is about the cycle, not about this pass. `beat()` is the last statement of a cycle
 * and the leader is considered stale after two minutes, so a pass that sat on a slow connection
 * for a hundred fetches would miss the heartbeat and page an operator with "no mailbox is
 * syncing" — which would be true, and caused by a repair nobody was waiting on.
 *
 * 25 is deliberately small, and the measurement says it is close to right rather than
 * comfortable: with this budget the worker's cycle ran ~50 s against a 30 s roster interval and
 * logged `roster_pass_delayed`, which is a warning and not an outage (the leader is stale at
 * 120 s) but is real margin spent on a repair nobody is waiting for. It self-terminates — once
 * the mailbox is marked the pass costs one indexed read per cycle — so the cost is transient by
 * construction. A mailbox with a much larger damaged set is the case to re-measure before
 * raising it.
 *
 * Nothing is SKIPPED by being budgeted: the marker is not written until the walk completes, and
 * {@link refusedByMailbox} is what makes each cycle spend its budget on messages the last one did
 * not already decide about.
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
 * Messages this PROCESS has re-read and then declined to repair, per mailbox.
 *
 * ── THIS IS THE TERMINATION ARGUMENT, AND IT IS HERE BECAUSE PRODUCTION SHOWED IT MISSING ──
 *
 * The first version had none, and the reasoning it rested on was half right. A message the pass
 * CLEARS stops carrying a category and drops out of the candidate query, so the walk advances —
 * true. A message it FETCHES AND REFUSES does not: it is still categorised, still without html,
 * still passes the pre-filter, and there is no persisted cursor, so the next cycle restarts the
 * walk and spends its whole budget re-reading the same messages off somebody's mail server to
 * reach the same answer. Progress is then whatever fraction of one budget happens to be
 * repairable, and once the earliest 25 candidates are all refusals it is ZERO — the walk never
 * reaches the rest and the marker is never written.
 *
 * Measured in production, not reasoned about: the first mailbox repaired dozens of messages and then
 * slowed to a handful per cycle while logging a full page examined every cycle, which is the shape of a pass
 * spending its budget on messages it had already decided about.
 *
 * With this set, every fetch either clears a message (gone from the query) or refuses it (gone
 * from the walk), so the untried candidate set shrinks by the full budget every cycle and the
 * pass finishes in `ceil(candidates / budget)` cycles. That is a guarantee rather than a hope.
 *
 * ── IN MEMORY, AND DELIBERATELY NOT A COLUMN ───────────────────────────────────────────────
 *
 * Losing it costs re-reads, never correctness — so a restart re-tries what it had refused, and
 * the marker (which IS durable) is what stops that being unbounded. A per-message column would
 * make a one-shot repair's bookkeeping permanent in everybody's schema for ever, which is a much
 * larger thing to carry than a `Set` that lives as long as the mailbox is attached.
 *
 * ── THE PARAGRAPH THAT USED TO STAND HERE WAS A TRADE NOBODY WOULD HAVE ACCEPTED IF ASKED ──
 *
 * It read: *"A TRANSIENT fetch failure therefore costs a repair: it is refused for the rest of
 * this process's life and the walk may complete and mark before it is retried."* Every clause is
 * true and the conclusion is not survivable, because of the word MARK. The marker
 * (`mailboxes.sensitive_fp_backfill_at`) is DURABLE and it is what stops the pass ever looking at
 * this mailbox again — so a single dropped connection during one fetch left one message redacted
 * FOR EVER, with nothing anywhere recording that a decision had not been reached about it. An
 * in-memory shelf is a cost; an in-memory shelf laundered through a durable certificate is a
 * permanent loss of somebody's mail, and the second is what this was.
 *
 * So the refusals are split by WHAT WE KNOW, and only one half may be certified:
 *
 *  · {@link decidedRefusals} — the classifier READ the original and declined to clear it
 *    (`stillSensitive`, `stillWithheld`). The message is correctly where it is, the pass has done
 *    its job on it, and losing this set to a restart costs a re-read and nothing else. The marker
 *    may certify over these, because they are answers.
 *  · {@link undecidedRefusals} — the original could not be read AT ALL (gone, unparseable, no
 *    locator) or resolved to a different message. These are not answers, they are absences of
 *    one, and a completed walk that holds any of them DOES NOT STAMP: see the marker block at the
 *    end of {@link sensitiveBackfillPass}.
 *
 * ── AND THE BOUND, BECAUSE "NEVER STAMP" IS ALSO NOT SURVIVABLE ─────────────────────────────
 *
 * A message that is permanently unreadable — expunged from the server, its row not yet reaped —
 * would keep this pass walking for ever, spending up to {@link SENSITIVE_FP_FETCHES_PER_CYCLE}
 * fetches per cycle against somebody's mail host in perpetuity for a repair that can never
 * happen. So a blocked walk is COUNTED, the undecided set is cleared at the end of each completed
 * walk (the next one genuinely re-tries them rather than skipping them), and after
 * {@link SENSITIVE_FP_MAX_BLOCKED_WALKS} full walks the pass stamps and says exactly what it is
 * stamping over — a warn per message and the count on the pass's own audit row, so "these N were
 * never decided" is a fact an operator can select rather than a silence.
 *
 * That counter is process-scoped ON PURPOSE, and the direction is what makes it safe: losing it
 * to a restart resets it to zero, which means MORE looking, never a premature certificate. It is
 * the same distinction the split above draws — in-memory state is fine exactly while it cannot be
 * laundered into a durable claim.
 */
const decidedRefusals = new Map<string, Set<string>>();

/** Candidates this walk could not decide about — cleared at the end of every completed walk. */
const undecidedRefusals = new Map<string, Set<string>>();

/** Completed walks this process has left unstamped for this mailbox. See the block above. */
const blockedWalks = new Map<string, number>();

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

      // ── THE PRE-FILTER. NO NETWORK BELOW THIS LINE UNLESS IT PASSES ────────────────────
      //
      // `verdict !== "ordinary"` and not `.sensitive`, because the repair below now happens on
      // exactly one verdict and a cost filter has to ask the question the repair will ask. The
      // old spelling was right when the only damage was a CATEGORY: `.sensitive` is the negation
      // of "this row would come clean". It is definitionally FALSE for every widened row — an
      // indeterminate verdict is not `sensitive` — so under the widened predicate it stopped
      // filtering entirely, and all 416 damaged representatives on the account this exists for
      // would have been re-read off the mail server to be refused on arrival.
      //
      // The verdict is KEPT rather than recomputed: the over-ceiling arm of the fetch `catch` below
      // reuses it as the oracle when the original is out of reach, so a row whose STORED text is not
      // ordinary is withheld HERE and never reaches that arm — which is where "a genuinely-sensitive
      // oversized row stays withheld" is enforced.
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

        // ── OVER THE CEILING IS NOT UNREADABLE ──────────────────────────────────────────
        //
        // A `fetchRaw` that refused because the message exceeds `maxBytes` did so from
        // `RFC822.SIZE` before transferring anything (`RawMessageTooLargeError`, code
        // `ERAWTOOLARGE`), so the connection is fine and the ONLY thing we lack is the original's
        // bytes. Counting that `unreadable` — as this arm used to for every failure — left the row
        // categorised and redacted for ever, mis-withheld by a size limit rather than by a verdict.
        //
        // The ruling: a too-large original must not strand a row. Fall back to the STORED text as
        // the oracle. We already hold `storedVerdict`, and reaching this line means it was
        // `ordinary` — the pre-filter withholds anything else — so this is a repair FROM STORED:
        // the five sensitivity fields are cleared and the row becomes readable, but the deleted
        // html is NOT restored, because the bytes that held it are precisely what we could not read.
        // The one verdict that repairs is still `ordinary`; the difference from the main path is
        // only WHERE that verdict came from.
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

      // ── THE VERDICT COMES FROM THE ORIGINAL, WHICH IS THE ENTIRE POINT ────────────────
      //
      // ONE verdict repairs: `ordinary`. Anything else — positively sensitive, or indeterminate
      // for any reason — is left exactly as it is.
      //
      // This used to be `if (verdict.sensitive) refuse`, which admitted an INDETERMINATE original
      // to the repair. Under the old predicate that was safe by accident: the repair cleared
      // `sensitivity_category`, which WAS the whole candidate query, so the row left the walk and
      // was never rewritten. Under the widened {@link DAMAGED} it does not leave, because it keeps
      // `no_ai` — so the row would be re-fetched and REWRITTEN on every run, each time emitting
      // another `change_log` delta telling every client that a message they already have changed
      // again. {@link refusedFor} cannot close that: it is in memory, so a restart forgets it and
      // the rewriting resumes.
      //
      // It is also what the repair is FOR, stated positively. "Only clear where the fixed
      // classifier says the message is clean" is the whole safety rule of this pass; an
      // indeterminate verdict is the classifier declining to say that.
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

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  THE WALK REACHED THE END. THAT IS NOT THE SAME THING AS HAVING DECIDED EVERYTHING.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  //
  // Reaching the end of the walk means every candidate was VISITED. A candidate whose original
  // could not be read was visited and not decided, and the marker below is durable and final —
  // it is the only thing that stops this pass ever looking at the mailbox again. Stamping over an
  // undecided message therefore converts a dropped TCP connection into a message that stays
  // redacted for the rest of its life, with no record anywhere that a decision was owed. That is
  // the defect this block exists to close; see the split above {@link decidedRefusals}.
  //
  // So a completed walk holding undecided refusals does NOT stamp. It clears them — the next
  // walk must genuinely re-try them rather than skip them off the shelf — counts itself, and
  // returns. The DECIDED shelf is deliberately kept across walks: those are answers, and losing
  // them would only buy a re-read of mail the classifier has already ruled on.
  result.undecided = undecided.size;
  // Captured before the shelves are cleared below, so the audit row can name what the certificate
  // does not cover. The IDS go on the durable audit row and NOT on a log line: `messageId`
  // (singular) is allowlisted for a ROW-SCOPED line, and an unbounded list of uuids on one line is
  // a size problem the jsonb payload does not have.
  const undecidedIds = [...undecided];
  const blocked = (blockedWalks.get(mailboxId) ?? 0);
  if (result.undecided > 0 && blocked + 1 < SENSITIVE_FP_MAX_BLOCKED_WALKS) {
    blockedWalks.set(mailboxId, blocked + 1);
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
 * WHAT "DAMAGED" MEANS — the one predicate, written once and used by both the walk and the write.
 *
 * ── IT WAS `sensitivity_category IS NOT NULL`, AND THAT MISSED MOST OF THE DAMAGE ───────────
 *
 * A classifier false positive has TWO outcomes in the database, not one, because the classifier
 * has two ways of withholding a message:
 *
 *  · POSITIVELY SENSITIVE — a vocabulary match. `sensitivity_category` is set, the text is
 *    redacted and the html is DELETED. This is what the pass was written for.
 *  · INDETERMINATE — no vocabulary match, but a reason we could not call it ordinary
 *    (`credential_shape`, `auth_url_token`, `unsupported_script`, …). `sensitivity_category`
 *    stays NULL, `no_ai` and `no_kb` are set, and for the credential-shaped reasons the stored
 *    body is REDACTED too (`storeRedactedBody`). The html is kept, but redacted.
 *
 * The second outcome is invisible to `sensitivity_category IS NOT NULL`, so a row withheld this
 * way was never a candidate and the pass reported a clean, complete run without ever having
 * looked at it. Measured on the deployment this exists for: of the AI-ineligible senders in one
 * account's Screener, 416 were withheld this way against 119 with a category — so the predicate
 * that shipped could not see 78% of them. They are the ones the account owner noticed, because
 * the visible symptom is the one this outcome produces: a sender the Screener will never suggest
 * for, whose preview reads `[REDACTED]`.
 *
 * `no_ai` and not `no_kb`, though the classifier sets both together: `no_ai` is the flag the
 * Screener's `aiEligible` actually reads, so it is the flag whose wrongness is the defect being
 * repaired. Selecting on the pair would be a wider predicate that admits exactly the same rows
 * today and would silently change meaning if the two ever diverged.
 */
const DAMAGED = sql`(${messages.sensitivityCategory} is not null or ${messages.noAi} = true)`;

/**
 * One page of the mail a false positive may have damaged, oldest id first.
 *
 * THE CANDIDATE SET IS DELIBERATELY WIDE AND THE FILTERING IS DELIBERATELY NOT HERE. Every
 * categorised message in the mailbox is selected; whether it can be repaired is decided by the
 * classifier, in TypeScript, twice — once on the stored text as a cost filter and once on the
 * original as the verdict. Trying to express "would the fixed classifier clear this" in SQL
 * would be a second implementation of the classifier, in a language that cannot run it, deciding
 * what may be un-redacted. That is the one thing this pass must never have.
 *
 * NOT LOCKED, and that is a difference from every other pass in this directory. A page here is
 * held across the network reads that follow it, so `FOR UPDATE` would hold row locks for minutes
 * of I/O. The serialization point is `repairOne`, which re-reads its own row under a lock at the
 * moment it writes — see there for why that is enough.
 *
 * `folder_state`, `message_states`, `drafts` and `approvals` are NOT consulted, and their absence
 * is the point rather than an omission. `rule-retro` and the kickstart re-route exclude mail the
 * user has triaged because those passes MOVE mail, and moving mail somebody has filed is undoing
 * their work. This pass moves nothing: it restores the text and html of a message that is already
 * exactly where the user left it. There is no user decision that "leave this one unreadable"
 * could respect.
 */
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
 * Write the repair for ONE message, and answer whether this call is the one that made it.
 *
 * ── THE TRANSACTION OPENS AFTER THE NETWORK READ, NEVER AROUND IT ───────────────────────────
 *
 * `recordChange` takes the account's `account_sync_state` row lock for the length of its
 * transaction, so a transaction spanning a `fetchRaw` would hold every API write for that account
 * behind a mail server's response time. Hence one short transaction per message rather than one
 * per page, which is the opposite of what the other passes here do and is entirely because this
 * one has I/O between its rows.
 *
 * ── THE LOCK-AND-RECHECK IS THE IDEMPOTENCY ────────────────────────────────────────────────
 *
 * Two drivers — the cycle, and a second worker mid-failover — can both fetch the same message and
 * both arrive here. The `FOR UPDATE` re-read makes the loser block, wake with the winner's
 * committed row, find `sensitivity_category` already NULL and write nothing. So one repair
 * produces ONE `change_log` delta, not two, and a client is never told twice that the same
 * message changed. It is also what makes re-running the whole pass safe: a message already
 * repaired fails this predicate.
 *
 * {@link DAMAGED} and not "did the value change": those are the fields that say a message was
 * withheld, so they are the fields that decide whether there is anything here to repair.
 */
async function repairOne(
  db: Tx,
  accountId: string,
  messageId: string,
  fresh: NormalizedMessage,
  verdict: SensitivityResult,
  now: Date,
): Promise<boolean> {
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
      tx, accountId,
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
 * Is the message we just read the message this row is about?
 *
 * A locator is a folder plus `uidvalidity:uid`, and a UID is only unique while `uidvalidity`
 * holds. A server that has reset it — or a row whose locator is stale because the message moved
 * between the read and now — points at some OTHER message, and storing those bytes would write
 * one person's mail into another message's row. That is the worst thing this pass could do, so it
 * is checked rather than assumed, and a failure skips the message instead of failing the pass.
 *
 * TWO forms of evidence, and EITHER is enough:
 *
 *  · the fingerprint. `messages.dedup_key` is `fp1:` + a digest over the sender, recipients,
 *    subject, date, body hashes and attachment metadata, computed at ingest from these same
 *    bytes. An exact match is proof.
 *  · the `Message-ID`. Rows ingested before the fingerprint key carry a legacy dedup key, and the
 *    fingerprint would not match for them however identical the message is. The header is stable
 *    across every parser change, which the digest is not.
 *
 * Accepting either is deliberate: a change to the MIME parser would silently move every
 * fingerprint, and a repair pass that quietly stopped matching anything would report a clean run
 * having done nothing. Two independent witnesses make that a thing that has to happen twice.
 */
function isSameMessage(row: CandidateRow, fresh: NormalizedMessage): boolean {
  if (fingerprintDedupKey(messageFingerprint(fresh)) === row.dedupKey) return true;
  const stored = normalizeMessageId(row.messageIdHeader);
  const got = normalizeMessageId(fresh.canonical.messageIdHeader);
  return stored !== null && got !== null && stored === got;
}

/**
 * The stored row in the shape the classifier reads, and NOTHING else is invented.
 *
 * `attachments` is empty because attachment BYTES are not on disk at all. That omission makes the
 * pre-filter more permissive (no filenames to match), so it costs fetches and can never cost a
 * repair, which is the direction a cost filter has to err in. The verdict is never taken from this
 * object; only the decision to spend a network read is.
 *
 * ── `html` IS READ NOW, AND HARDCODING IT NULL HAD STOPPED THE FILTER FILTERING ─────────────
 *
 * It was `htmlBody: null`, described as "the truth of what is on disk for a redacted message".
 * That was true of every row the pass could then see — a positively-sensitive row has its html
 * DELETED — and it is false for the rows {@link DAMAGED} now admits, which keep their html and
 * merely have it redacted. Passing null for those threw away the evidence the filter exists to
 * read: measured against the account this repair is for, ALL 416 damaged representatives cleared
 * a text-only pre-filter, so every one of them would have been re-read off the mail server, and
 * roughly 4,100 rows in total — against about 600 that clear once the stored html is included.
 * A cost filter that admits everything is not a cost filter; it is six thousand network round
 * trips wearing one.
 *
 * This can only ever REMOVE fetches for a row whose html is stored, and it cannot change any
 * verdict, because the verdict is still taken from the original off the server. The bias it adds
 * is the documented one, in the same direction as the header note: the stored html has been
 * through `prepareHtmlForStorage` and the redactor, so it is a SUBSET of the original — a row
 * that flags on it would have flagged on the original too.
 */
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
