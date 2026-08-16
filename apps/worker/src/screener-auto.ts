import { and, asc, eq, gt, sql } from "drizzle-orm";
import {
  accountSettings, approvals, auditLog, drafts, folderState, mailboxes,
  messageBodies, messageStates, messages, rules as rulesTbl, recordChange, type Tx,
} from "@trafficflow/db";
import {
  migrationBulkPlacement, silentLogger,
  type Destination, type Logger, type NormalizedMessage,
} from "@trafficflow/core";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   SCREENER AUTO-APPLY — file the OBVIOUS bulk out of the Screener, when the account opted in
   ══════════════════════════════════════════════════════════════════════════════════════════

   ── WHAT IT IS, AND THE ONE THING IT DELIBERATELY IS NOT ────────────────────────────────────

   The Screener is a consent gate: a first-contact stranger is HELD there for a human to place. That
   is the product, and it stays the product. This pass is an OPT-IN that clears the part of the queue
   a human would only ever wave through — the plain newsletters and receipts — so the strangers who
   actually need a decision are not buried under them.

   It applies DETERMINISTIC routing only. Each held sender is judged by the SAME strong-bulk floor the
   live engine and the Ohbox backfill use — `rules.ts#migrationBulkPlacement`: `List-Unsubscribe`
   REQUIRED plus a corroborating list/ESP marker (`List-Id`, `List-Unsubscribe-Post`, `Feedback-ID`,
   or `Precedence: bulk`) — and only that obvious bulk is filed to Reads (or Receipts on a money
   subject). Nothing else moves. First-time PEOPLE do not carry the floor's headers, so they are never
   touched; they wait for a human, as they always have.

   It does NOT call the model and it does NOT spend. There is no classifier here, no credit gate, and
   no path that buys a paid suggestion — auto-BUYING AI advice would be a money contract and is out of
   scope by construction (this file imports neither). The account's already-bought suggestions are
   advisory and this pass never applies them: "AI proposes, the user decides" stays true.

   ── SENSITIVITY KEEPS. THIS IS `pipeline.ts:563-567`, ONE CLASS. ────────────────────────────

   A sensitivity-flagged message (`sensitivity_category` set OR `no_ai`) is KEPT in the Screener,
   never auto-moved — exactly as the live router force-keeps sensitive mail in the Ohbox
   (`sensitivity.sensitive && !deniedByConsent ⇒ INBOX`) so a login code, password reset or security
   alert reaches a human and is never buried. The guard is read ONTO the row and applied in the loop,
   not pushed into the candidate query, so it holds for every mover and a review can watch it fail:
   drop it and a flagged strong-bulk row moves. Re-screening flagged strangers is
   `sensitive-rescreen.ts`'s job; this pass only leaves them where they are.

   ── EVERYTHING IT DOES IS DURABLE AND REVERSIBLE. IT NEVER DELETES, IT NEVER ADMITS. ────────

   A move is `folder_state.desired_folder → Reads/Receipts` plus a `change_log` move (so every client
   mirror shows the Screener→Reads transition) plus an `audit_log` row carrying the INVERSE, which is
   the undo the account is owed for mail it did not individually place. It writes NO `rules` row: the
   move grants no admission, so the next message from that sender still screens — the same property the
   Ohbox backfill keeps. Nothing is ever deleted; "put it back" is a drag, or the recorded inverse.

   ── USER ALWAYS WINS, AND IT WRITES AN INTENT, NOT AN IMAP MOVE ─────────────────────────────

   The candidate set excludes any message the user has already expressed intent about (triaged,
   replied to, ruled on), the same exclusions the sibling passes use. And like them it opens no IMAP
   connection: it writes desired state plus a `move` change and stops. The worker's reconcile pass
   performs the physical move on its next cycle, through the one code path that moves mail crash-safely
   and holds the mailbox's lease (organize-in-place). Every input the decision needs is already on disk.

   ── OPT-IN, AND CONTINUOUS WHILE ON — NO "OWED" MARKER ──────────────────────────────────────

   Unlike the one-time backfills (`ohbox-tidy.ts`, `sensitive-rescreen.ts`) this is not owed-once work
   with a done marker: it is a standing preference. It runs every cycle for an account whose
   `screener_auto_apply_at IS NOT NULL`, and it is a single PK read for every account that has NOT
   opted in — the default, which reads OFF for a NULL, an absent row, and a failed read alike. It is
   idempotent by construction: a row it moves leaves `ohmail/Screener` and drops out of the candidate
   set, so a re-run writes nothing new; the per-cycle write budget bounds how much physical mail one
   poll interval absorbs, for the reconciler-pacing reason `ohbox-tidy.ts` spells out.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/** Where held strangers wait. */
const SCREENER: Destination = "ohmail/Screener";

/**
 * Rows examined per transaction — the same 100 as the sibling passes: {@link recordChange} takes the
 * account's `account_sync_state` row lock for the length of its transaction, so a whole-queue
 * transaction would stall every API write for that account.
 */
export const SCREENER_AUTO_BATCH = 100;

/**
 * Moves this pass may CREATE for one account in one cycle. The reason is downstream and identical to
 * `ohbox-tidy.ts`: the reconciler walks pending folder states serially, one IMAP move per row inside
 * the sync cycle, and queuing a few hundred moves at once makes the cycle miss its heartbeat.
 */
export const SCREENER_AUTO_WRITES_PER_CYCLE = 100;

/**
 * Pages one account's queue may walk in one cycle. A bound, not a `while (true)`: kept rows (a plain
 * stranger, a sensitive message) STAY, so a "loop until an empty page" pass would re-read them for
 * ever — termination is the cursor, monotone in `messages.id`, or a short page.
 */
export const SCREENER_AUTO_MAX_PAGES = 500;

export interface ScreenerAutoDeps {
  /** Scope to ONE account — the worker loops its served accounts. */
  accountId: string;
  log?: Logger;
  now?: () => Date;
  /** Test seam. Default {@link SCREENER_AUTO_BATCH}. */
  batch?: number;
  /** Test seam. Default {@link SCREENER_AUTO_WRITES_PER_CYCLE}. */
  writesPerCycle?: number;
  /** Test seam. Default {@link SCREENER_AUTO_MAX_PAGES}. */
  maxPages?: number;
}

export interface ScreenerAutoResult {
  /** False ⇒ the account has NOT opted in; nothing was read past the one-row probe. */
  ran: boolean;
  /** Candidate rows examined. */
  examined: number;
  /** Rows filed out of the Screener. */
  moved: number;
  /** Rows the pass left in the Screener — not strong-bulk, sensitivity-flagged, or user-touched. */
  kept: number;
  /** Destination → how many movers went there. Always a subset of {Reads, Receipts}. */
  destinations: Record<string, number>;
  /**
   * Movers held back BECAUSE they are sensitivity-flagged — the safety margin, so an operator can see
   * how much was deliberately left at the gate for a human rather than filed to Reads/Receipts.
   */
  sensitivityExcluded: number;
  /** True ⇒ the per-cycle write budget ran out; the rest is swept next cycle. */
  capped: boolean;
}

/** One candidate, carrying everything the decision reads — all of it from disk. */
interface AutoRow {
  messageId: string;
  mailboxId: string;
  fromAddress: string;
  subject: string;
  headers: Record<string, string[]>;
  observedFolder: string;
  desiredFolder: string;
  sensitivityCategory: string | null;
  noAi: boolean;
}

const EMPTY = (): ScreenerAutoResult => ({
  ran: false, examined: 0, moved: 0, kept: 0, destinations: {}, sensitivityExcluded: 0, capped: false,
});

/** True ⇒ sensitivity-flagged (`sensitivity_category` set OR `no_ai`) — never auto-moved. */
function isSensitivityFlagged(row: AutoRow): boolean {
  return row.sensitivityCategory !== null || row.noAi;
}

/**
 * THE PASS, for ONE account. A no-op for every account that has not opted in; otherwise a bounded,
 * idempotent sweep of the held Screener queue that files obvious strong-bulk out and leaves
 * everything else — strangers, sensitive mail, user-touched mail — exactly where it is.
 *
 * Pure and hermetic — a db/tx handle, a clock and a logger — so a test drives it against PGlite
 * with no worker, no lease and no network. The `FOR UPDATE OF folder_state` lock behaves as a no-op
 * on PGlite (single connection); its concurrent-move claim is the sibling passes' `*.pg.test.ts`
 * territory and holds here for the same reason it holds there.
 */
export async function screenerAutoApplyPass(
  db: Tx, deps: ScreenerAutoDeps, nowArg?: Date,
): Promise<ScreenerAutoResult> {
  const log = deps.log ?? silentLogger;
  const now = () => nowArg ?? deps.now?.() ?? new Date();
  const batch = deps.batch ?? SCREENER_AUTO_BATCH;
  const budget = deps.writesPerCycle ?? SCREENER_AUTO_WRITES_PER_CYCLE;
  const maxPages = deps.maxPages ?? SCREENER_AUTO_MAX_PAGES;
  const accountId = deps.accountId;

  // ── THE OPT-IN PROBE ───────────────────────────────────────────────────────────────────────
  //
  // One PK read. `screener_auto_apply_at IS NOT NULL` IS the opt-in; a NULL, an absent row, and (up
  // the stack) a failed read all mean OFF, and OFF moves nothing. This is the whole cost of the pass
  // for every account that has not turned it on — which is every account by default.
  const [settings] = await db.select({ autoApplyAt: accountSettings.screenerAutoApplyAt })
    .from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);
  if (!settings?.autoApplyAt) return EMPTY();

  // Every address this ACCOUNT sends from — for the "the user replied from their own client"
  // exclusion. Read once here rather than in SQL so the candidate query stays one indexable statement.
  const ownRows = await db.select({ address: mailboxes.address }).from(mailboxes)
    .where(eq(mailboxes.accountId, accountId));
  const ownAddresses = ownRows.map((r) => r.address.toLowerCase());

  const result: ScreenerAutoResult = { ...EMPTY(), ran: true };
  let afterId: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    if (result.moved >= budget) { result.capped = true; break; }

    const outcome = await db.transaction(async (tx) => {
      const candidates = await selectCandidates(tx, { accountId, ownAddresses, limit: batch, afterId });

      let moved = 0;
      let kept = 0;
      let sensitivityExcluded = 0;
      let lastId: string | null = null;
      let capped = false;
      const destinations: Record<string, number> = {};

      for (const c of candidates) {
        // Budget enforced PER ROW, so the cap is exact and the cursor resumes at the last row this
        // pass actually decided about — never past one it skipped.
        if (result.moved + moved >= budget) { capped = true; break; }
        lastId = c.messageId;

        // THE ONLY DETERMINISTIC JUDGMENT A STRANGER GETS: the strong-bulk floor. Null ⇒ keep (a
        // plain stranger, a relevant alert). No model call, no spend, computed from headers on disk.
        const to = migrationBulkPlacement(asRuleInput(c));
        if (to === null) { kept++; continue; }

        // ── SENSITIVITY KEEP — this is `pipeline.ts:563-567`. Drop it and a flagged strong-bulk row
        // moves; keeping it means a stranger's login code stays at the gate for a human. ──────────
        if (isSensitivityFlagged(c)) { sensitivityExcluded++; kept++; continue; }

        await upsertDesired(tx, c, to, now());
        // The optimistic, user-wins `move` delta the client mirror converges on, carrying the TRUE
        // previous folder so a later undo needs nothing extra written.
        await recordChange(tx, {
          accountId, entityType: "message", entityId: c.messageId, op: "move",
          meta: { from: SCREENER, to },
        });
        // The undo the account is owed: this pass moved mail they did not individually place, so
        // "put it back" has to be expressible. No `rules` row and no learning-path read — the move
        // teaches no consent and grants no admission, so the sender still screens next time.
        await tx.insert(auditLog).values({
          accountId, action: "screener_auto_apply_move",
          payload: { mailboxId: c.mailboxId, messageId: c.messageId, from: SCREENER, to },
          inverse: { messageId: c.messageId, from: to, to: SCREENER },
        });
        moved++;
        destinations[to] = (destinations[to] ?? 0) + 1;
      }

      return { rows: candidates.length, moved, kept, sensitivityExcluded, lastId, capped, destinations };
    });

    result.examined += outcome.rows;
    result.moved += outcome.moved;
    result.kept += outcome.kept;
    result.sensitivityExcluded += outcome.sensitivityExcluded;
    for (const [to, n] of Object.entries(outcome.destinations)) {
      result.destinations[to] = (result.destinations[to] ?? 0) + n;
    }
    if (outcome.capped) { result.capped = true; break; }
    // A short page is the end of the queue. A full page of kept rows still advances the cursor past
    // them (it is monotone in `messages.id`, not in candidacy), so the walk terminates.
    if (outcome.rows < batch) break;
    afterId = outcome.lastId ?? afterId;
  }

  if (result.moved > 0) {
    log.info("screener_auto_apply", {
      accountId, examined: result.examined, moved: result.moved, kept: result.kept,
      destinations: result.destinations, sensitivityExcluded: result.sensitivityExcluded,
      capped: result.capped,
    });
  }
  return result;
}

/**
 * ONE page of the held Screener queue this pass may reconsider — LOCKED FOR UPDATE, oldest id first.
 *
 * ── THE CANDIDATE SET ──────────────────────────────────────────────────────────────────────
 *
 *  · `folder_state.desired_folder = 'ohmail/Screener'` — it is held at the gate. Also the whole of
 *    the idempotency: a row this pass has moved is desired into Reads/Receipts and drops out.
 *  · `folder_state.last_set_by = 'us'` — a row set `external` is a placement the USER made in their
 *    own mail client, which the reconciler already refuses to revert.
 *  · the mailbox is not `disabled` — nothing will ever reconcile a `pending` row written for one.
 *
 * ── AND THE USER-INTENT EXCLUSIONS — a message the user has acted on is not ours to move ────────
 *
 * The same predicates the sibling passes use, one direction over:
 *  1. no enabled `rules` row for the sender or its domain — they have been ruled on. (Redundant for
 *     correctness — a ruled-on sender would not be held here — and kept for cost and belt-and-braces.)
 *  2. no `message_states` row other than `none` (reply-later / set-aside / bubbled-up / muted).
 *  3. no `drafts` row replying to it.
 *  4. no DECIDED `approvals` row (`status <> 'pending'` — a pending one is OURS, unanswered).
 *  5. no message in the same thread from the account's own address (they replied from their client).
 *
 * SENSITIVITY is deliberately NOT a candidate predicate — it is read onto the row and applied by the
 * single KEEP guard in {@link screenerAutoApplyPass}, so the guard holds for every mover and a review
 * can watch it fail rather than have the query silently pre-exclude the case.
 *
 * `FOR UPDATE OF folder_state` — `of` the one table, because `message_bodies` is on the NULLABLE side
 * of a LEFT JOIN (Postgres refuses to lock it) and locking `messages` would serialize against
 * ordinary ingest for no benefit. This is what makes a concurrent user drag safe.
 */
async function selectCandidates(
  t: Tx,
  opts: { accountId: string; ownAddresses: readonly string[]; limit: number; afterId: string | null },
): Promise<AutoRow[]> {
  const filters = [
    eq(messages.accountId, opts.accountId),
    eq(folderState.desiredFolder, SCREENER),
    eq(folderState.lastSetBy, "us"),
    sql`not exists (
      select 1 from ${mailboxes} mb
       where mb.id = ${messages.mailboxId} and mb.status = 'disabled'
    )`,
    // 1 — the user has ruled on this sender.
    sql`not exists (
      select 1 from ${rulesTbl} r
       where r.account_id = ${messages.accountId}
         and r.enabled = true
         and (
           (r.kind = 'sender' and lower(r.match) = lower(${messages.fromAddress}))
           or (r.kind = 'domain' and lower(r.match) = split_part(lower(${messages.fromAddress}), '@', 2))
         )
    )`,
    // 2 — the user has triaged this message.
    sql`not exists (
      select 1 from ${messageStates} ms
       where ms.message_id = ${messages.id} and ms.state <> 'none'
    )`,
    // 3 — the user is replying, or has replied, through the app.
    sql`not exists (
      select 1 from ${drafts} d where d.in_reply_to_message_id = ${messages.id}
    )`,
    // 4 — the user decided on an AI proposal about this message.
    sql`not exists (
      select 1 from ${approvals} a
       where a.message_id = ${messages.id} and a.status <> 'pending'
    )`,
  ];
  // 5 — the user replied from their own mail client. Guarded on a non-empty list (`in ()` is a
  // syntax error) and a non-NULL thread.
  if (opts.ownAddresses.length > 0) {
    filters.push(sql`not exists (
      select 1 from ${messages} sent
       where sent.account_id = ${messages.accountId}
         and sent.thread_id = ${messages.threadId}
         and ${messages.threadId} is not null
         and lower(sent.from_address) in ${sql`(${sql.join(opts.ownAddresses.map((a) => sql`${a}`), sql`, `)})`}
    )`);
  }
  if (opts.afterId) filters.push(gt(messages.id, sql`${opts.afterId}::uuid`));

  const rows = await t.select({
    messageId: messages.id,
    mailboxId: messages.mailboxId,
    fromAddress: messages.fromAddress,
    subject: messages.subject,
    observedFolder: folderState.observedFolder,
    desiredFolder: folderState.desiredFolder,
    // ── ONLY THE FIVE KEYS THE FLOOR READS CROSS THE WIRE ─────────────────────────────────────
    //
    // `message_bodies.headers` is the whole RFC-822 header map — `received`, `authentication-results`
    // and `dkim-signature` chains make it ~4 kB per row in production, and this pass re-reads its
    // page of the held Screener queue on every cycle. Shipping the full map to answer
    // `hasStrongBulkFloor` sends ~4 kB to read ~86 B.
    //
    // The projection is exact rather than a heuristic: this pass runs MIGRATION-BULK ONLY (see
    // {@link asRuleInput} — it never calls `evaluateRules`), so the only header reader downstream is
    // `hasStrongBulkFloor`, and it reads exactly these five names and no others. Any new header
    // reader on this path MUST be added here or it will silently see an absent header.
    //
    // `jsonb_strip_nulls` makes an absent key absent rather than `"key": null`, which is what
    // `headerValues`' `hasOwnProperty` check distinguishes; a missing body row (this is the nullable
    // side of a LEFT JOIN) yields `{}`, exactly what the `?? {}` below already produced.
    // `mime.ts` lower-cases every header name at ingest, so these literals match what is stored.
    headers: sql<Record<string, string[]> | null>`jsonb_strip_nulls(jsonb_build_object(
      'list-unsubscribe',      ${messageBodies.headers} -> 'list-unsubscribe',
      'list-unsubscribe-post', ${messageBodies.headers} -> 'list-unsubscribe-post',
      'list-id',               ${messageBodies.headers} -> 'list-id',
      'feedback-id',           ${messageBodies.headers} -> 'feedback-id',
      'precedence',            ${messageBodies.headers} -> 'precedence'
    ))`,
    sensitivityCategory: messages.sensitivityCategory,
    noAi: messages.noAi,
  }).from(folderState)
    .innerJoin(messages, eq(messages.id, folderState.messageId))
    .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
    .where(and(...filters))
    .orderBy(asc(messages.id))
    .limit(opts.limit)
    .for("update", { of: folderState });

  return rows.map((r) => ({
    messageId: r.messageId,
    mailboxId: r.mailboxId,
    fromAddress: r.fromAddress,
    subject: r.subject,
    headers: (r.headers as Record<string, string[]> | null) ?? {},
    observedFolder: r.observedFolder,
    desiredFolder: r.desiredFolder,
    sensitivityCategory: r.sensitivityCategory,
    noAi: r.noAi,
  }));
}

/**
 * Write the INTENT and nothing else: the new desired folder, observed untouched. `reconcile_status`
 * is DERIVED (desired ≠ observed ⇒ `pending`), so a row can never claim a convergence it does not
 * have, and `pending` is what makes the worker's reconciler perform the physical move. This is an
 * UPSERT, never a delete — the placement is durable and the user can drag it back.
 */
async function upsertDesired(t: Tx, row: AutoRow, destination: string, now: Date): Promise<void> {
  const reconcileStatus = destination === row.observedFolder ? "reconciled" : "pending";
  await t.insert(folderState).values({
    messageId: row.messageId, desiredFolder: destination, observedFolder: row.observedFolder,
    lastSetBy: "us", reconcileStatus, conflict: false,
  }).onConflictDoUpdate({
    target: folderState.messageId,
    set: {
      desiredFolder: destination, observedFolder: row.observedFolder, lastSetBy: "us",
      reconcileStatus, conflict: false, updatedAt: now,
    },
  });
}

/**
 * The persisted row in the shape the router reads — sender, subject, headers, all on disk. No IMAP,
 * no MIME re-parse. The body fields are empty because this pass feeds `migrationBulkPlacement`
 * ONLY, which reads headers and the subject — it never runs `evaluateRules`, so `body_contains`
 * (mail 0052) has no reader here and an empty `textBody` is the truth rather than a lie. That is
 * a DIVERGENCE from the sibling passes' `asRuleInput` (`rule-retro.ts`, `ohbox-tidy.ts`,
 * `sensitive-rescreen.ts`), which do evaluate rules and therefore read `message_bodies.text`
 * back; if this pass ever grows a rule evaluation, thread the body in as they do.
 */
function asRuleInput(row: AutoRow): NormalizedMessage {
  return {
    canonical: { messageIdHeader: null, bodyHash: "" },
    subject: row.subject,
    from: { name: null, address: row.fromAddress.toLowerCase() },
    to: [],
    cc: [],
    date: null,
    headers: row.headers,
    textBody: "",
    htmlBody: null,
    hasAttachments: false,
    attachments: [],
  };
}
