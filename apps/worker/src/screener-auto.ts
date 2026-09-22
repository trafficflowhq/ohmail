import { and, asc, eq, gt, sql, type SQL } from "drizzle-orm";
import {
  accountSettings, approvals, auditLog, drafts, folderState, mailboxes,
  messageBodies, messageStates, messages, rules as rulesTbl, recordChange,
  weAnsweredThisSenderWhere, type Tx, auditAction,} from "@trafficflow/db";
import {
  migrationBulkPlacement, silentLogger,
  type Destination, type Logger, type NormalizedMessage,
} from "@trafficflow/core";
import { dialect } from "@trafficflow/db/dialect";
import { ruleInputOf, upsertDesired } from "./rule-pass.js";

/* SCREENER AUTO-APPLY — file the OBVIOUS bulk out of the Screener when the account opted in. The Screener
 * stays a consent gate for first-contact strangers; this OPT-IN clears the newsletters and receipts a
 * human would wave through. DETERMINISTIC routing only: each held sender is judged by the strong-bulk
 * floor the live engine and Ohbox backfill use (`rules.ts#migrationBulkPlacement`: `List-Unsubscribe`
 * REQUIRED plus a corroborating `List-Id`/`List-Unsubscribe-Post`/`Feedback-ID`/`Precedence: bulk`) and
 * only that bulk is filed to Reads/Receipts. It does NOT call the model and does NOT spend (imports
 * neither). SENSITIVITY (`sensitivity_category`/`no_ai`) is KEPT, one guard in the loop, matching
 * `pipeline.ts:563-567`. Durable and reversible: `folder_state.desired_folder` + a `change_log` move + an
 * `audit_log` inverse; NO `rules` row (grants no admission), never IMAP (organize-in-place). OPT-IN and
 * continuous while on (`screener_auto_apply_at IS NOT NULL`), idempotent, paced by `SCREENER_AUTO_WRITES_PER_CYCLE`. */

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
  /**
   * True ⇒ the account switched auto-apply OFF part-way through this walk and the remaining pages
   * were NOT applied.
   *
   * Distinct from {@link capped} on purpose, because the two mean opposite things to the caller: a
   * cap owes more work and should be re-kicked, a revoke owes none and must not be. Reported rather
   * than left to look like a drained queue — a withdrawn decision that is acted on silently is the
   * defect this field exists to make visible.
   */
  revoked: boolean;
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
  revoked: false,
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
      // THE OPT-IN IS RE-READ HERE, LOCKED, AND IT IS THE REVOKE CHECK. The probe above runs ONCE; the
      // pass then files up to SCREENER_AUTO_WRITES_PER_CYCLE across `maxPages` transactions, and an account
      // that turns auto-apply OFF mid-walk had the rest applied anyway — a completed opt-out then up to a
      // hundred moves on their real mailbox. `ohbox-tidy.ts` holds this shape (its settings row is
      // serialization point AND revoke check); `screener-auto-revoke.pg.test.ts` watches both. TWO
      // properties: the RE-READ catches the withdrawn opt-in (each page reads fresh under READ COMMITTED,
      // with or without the lock — dropping `.for("update")` does not redden the revoke test); the LOCK
      // serializes two drivers (a cycle tail and a failover worker). LOCK ORDER: `account_settings` first,
      // before `folder_state` (`selectCandidates` FOR UPDATE OF) and the `account_sync_state` counter — the
      // one order this tree uses. The 30 s posture cache in `index.ts` gates whether the pass STARTS, not this.
      const [live] = await tx.select({ autoApplyAt: accountSettings.screenerAutoApplyAt })
        .from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1).for("update");
      if (!live?.autoApplyAt) {
        return {
          revoked: true, rows: 0, moved: 0, kept: 0, sensitivityExcluded: 0,
          lastId: null, capped: false, destinations: {} as Record<string, number>,
        };
      }

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
          accountId, action: auditAction("screener_auto_apply_move"),
          payload: { mailboxId: c.mailboxId, messageId: c.messageId, from: SCREENER, to },
          inverse: { messageId: c.messageId, from: to, to: SCREENER },
        });
        moved++;
        destinations[to] = (destinations[to] ?? 0) + 1;
      }

      return {
        revoked: false, rows: candidates.length, moved, kept, sensitivityExcluded,
        lastId, capped, destinations,
      };
    });

    // A REVOKE STOPS THE WALK, and it is reported rather than looking like a drained queue. The
    // pages already committed stand — they were applied while the opt-in was live, and the account
    // is owed the undo each one wrote to `audit_log`, not a silent reversal.
    if (outcome.revoked) {
      result.revoked = true;
      log.info("screener_auto_apply_revoked", {
        accountId, examined: result.examined, moved: result.moved,
        reason: "auto-apply was switched off during this walk; the remaining pages were not applied",
      });
      break;
    }

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
 * Candidates: `folder_state.desired_folder = 'ohmail/Screener'` (held, and the idempotency — a moved row
 * is desired into Reads/Receipts and drops out); `last_set_by = 'us'` (`external` is the user's own client;
 * `'peer'` excluded, since auto-applying to mail nobody on this install decided about is what this pass may
 * not do — only `rule-retro` admits `'peer'`, behind a press); mailbox not `disabled`. User-intent
 * exclusions (siblings' predicates): no enabled `rules` row for sender/domain; no non-`none`
 * `message_states`; no `drafts` reply; no DECIDED `approvals` (`status <> 'pending'`); no same-thread
 * own-address reply. SENSITIVITY is NOT a candidate predicate — applied by the single KEEP guard in
 * {@link screenerAutoApplyPass}. `FOR UPDATE OF folder_state` (not `message_bodies`, LEFT JOIN nullable side). */
async function selectCandidates(
  t: Tx,
  opts: { accountId: string; ownAddresses: readonly string[]; limit: number; afterId: string | null },
): Promise<AutoRow[]> {
  const filters = [
    eq(messages.accountId, opts.accountId),
    eq(folderState.desiredFolder, SCREENER),
    eq(folderState.lastSetBy, "us"),
    // BOTH HALVES since mail 0083 — see the identical clause in `rule-retro.ts` for the full
    // argument. `status = 'disabled'` alone stopped being sufficient when the loser of an
    // organizer lease became a READER (connected, syncing) instead of a disabled row: a demoted
    // organizer keeps every `folder_state` row it filed while it WAS the organizer, those rows are
    // `last_set_by: 'us'`, and this pass would re-file them on a mailbox another install now
    // arranges. Nothing executes them while the install is a reader, which is the trap — the
    // intent waits in the table and fires in full on the next promotion.
    sql`not exists (
      select 1 from ${mailboxes} mb
       where mb.id = ${messages.mailboxId}
         and (mb.status = 'disabled' or mb.organizer_role <> 'organizer')
    )`,
    // 1 — the user has ruled on this sender. ANY enabled rule, narrowed or not. THIS PASS MUST NOT NARROW
    // IT. The identical predicate in `sensitive-rescreen.ts` and `drizzle-repo.ts#listScreenerBacklog` was
    // narrowed to un-narrowed rules because `subject_contains`/`body_contains` (mail 0050, 0052) are
    // CONJUNCTIONS, so a narrowed rule speaks only for the mail it matches — right there, and it does not
    // transfer here: {@link screenerAutoApplyPass} decides with `migrationBulkPlacement` and NEVER calls
    // `evaluateRules`, and {@link AutoRow} carries no body text, so narrowing the SQL DISCARDS the question
    // and a held message matching the user's narrowed rule gets auto-moved over the destination they wrote,
    // silently. Conservative is correct here: excluding too much leaves a message at the gate (visible);
    // too little moves their mail where they said not to. If auto-apply grows a real evaluator, this
    // narrows with it, in the same commit — not before.
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
  /* 5 — THE USER ANSWERED THIS SENDER, through `weAnsweredThisSenderWhere` like its two siblings.
   * This pass asked plain thread membership and did not exclude the away responder AT ALL, so a
   * machine's reply on a thread counted as the person's engagement and held mail at the gate. */
  filters.push(sql`not ${weAnsweredThisSenderWhere(dialect(t), {
    accountId: messages.accountId as unknown as SQL,
    threadId: messages.threadId as unknown as SQL,
    fromAddress: messages.fromAddress as unknown as SQL,
    ownAddresses: opts.ownAddresses,
  })}`);
  if (opts.afterId) filters.push(gt(messages.id, sql`${opts.afterId}::uuid`));

  const rows = await t.select({
    messageId: messages.id,
    mailboxId: messages.mailboxId,
    fromAddress: messages.fromAddress,
    subject: messages.subject,
    observedFolder: folderState.observedFolder,
    desiredFolder: folderState.desiredFolder,
    // ONLY THE FIVE KEYS THE FLOOR READS CROSS THE WIRE. `message_bodies.headers` is the whole RFC-822
    // header map (~4 kB per row in production), and this pass re-reads its page every cycle — shipping the
    // full map to answer `hasStrongBulkFloor` sends ~4 kB to read ~86 B. Exact rather than heuristic: this
    // pass runs MIGRATION-BULK ONLY (see {@link asRuleInput}, never `evaluateRules`), so the only header
    // reader downstream is `hasStrongBulkFloor`, which reads exactly these five names — any new header
    // reader MUST be added here or silently see an absent header. `jsonb_strip_nulls` makes an absent key
    // absent rather than `"key": null` (what `headerValues`' `hasOwnProperty` distinguishes); a missing
    // body row (LEFT JOIN nullable side) yields `{}`. `mime.ts` lower-cases header names at ingest.
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
 * The persisted row in the shape the router reads — sender, subject, headers, all on disk. No IMAP,
 * no MIME re-parse. The body fields are empty because this pass feeds `migrationBulkPlacement`
 * ONLY, which reads headers and the subject — it never runs `evaluateRules`, so `body_contains`
 * (mail 0052) has no reader here and an empty `textBody` is the truth rather than a lie. That is
 * a DIVERGENCE from the sibling passes' `asRuleInput` (`rule-retro.ts`, `ohbox-tidy.ts`,
 * `sensitive-rescreen.ts`), which do evaluate rules and therefore read `message_bodies.text`
 * back; if this pass ever grows a rule evaluation, thread the body in as they do.
 */
function asRuleInput(row: AutoRow): NormalizedMessage {
  return ruleInputOf({ ...row, bodyText: "" });
}
