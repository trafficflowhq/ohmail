import { and, asc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  accountSettings, approvals, auditLog, drafts, folderState, mailboxes,
  messageBodies, messageStates, messages, recordChange, type Tx,
} from "@trafficflow/db";
import {
  authVerdictFromHeaders, evaluateRules,
  migrationBulkPlacement, resolveOhboxPolicy, silentLogger,
  type Destination, type Logger, type NormalizedMessage, type OhboxPolicy, type Rule,
  type RuleDecision,
} from "@trafficflow/core";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   RE-ROUTING THE OHBOX BACKLOG — the automated mail `people_only` was turned on too late to catch
   ══════════════════════════════════════════════════════════════════════════════════════════

   ── WHAT IS WRONG, AND WHY THE LIVE ENGINE CANNOT FIX IT ────────────────────────────────────

   Migration 0042 gave the account a posture and the engine (`rules.ts#evaluateRules`) demotes NEW mail under
   it: a `seeded-from-sent`/`promoted` allow rule that placed automated-shaped mail in the Ohbox now
   answers `source: "policy"` → Reads/Receipts. But a rule is consulted at ARRIVAL and never again,
   so the mail already filed into the Ohbox under the old lenient default stays there — measured at
   roughly three quarters of a real Ohbox, most of it one seeded sender's newsletters and receipts. This pass is
   the durable, one-time-per-opt-in correction, and it is the whole reason the first user's #1 complaint
   ("everything outside an actual human is in my Ohbox") is not answered by the posture alone.

   ── IT RE-EVALUATES THROUGH THE REAL ENGINE, THEN ACTS PER CLASS. IT DOES NOT INVERT. ───────

   The tempting shortcut — "seeded rule + automated headers ⇒ Reads" — is a SECOND router, and a
   second router drifts from the first. It is also wrong on the day it ships: a human writing
   personally from a seeded sender, a genuine security alert, a `manual` "keep this in my Ohbox"
   rule, a deny — all must stay put, and every one of those distinctions already lives in
   `evaluateRules`. So each candidate goes back through the SAME `evaluateRules` the live path uses,
   with the account's resolved posture, and the pass acts on its answer keyed on `source` — because
   the measured Ohbox holds THREE misfiled populations, not one, and a single-class pass moved just
   ONE message on the real account:

     · `source: "policy"` — the inferred-admission demotion (`seeded-from-sent`/`promoted` allow rule
       whose Ohbox placement WE chose). Move to the engine's Reads/Receipts. `basis: "policy"`.
     · `source: "header"` — a CONTACT with no rule, whom the live router now header-routes bulk→Reads /
       money→Receipts. Replaying that placement over mail the legacy router filed BEFORE that branch
       existed is not a new consent judgment. Move to the engine's destination. `basis: "header"`.
     · `source: "screener"` — the ~400-row mass: no rule, NOT a contact, admitted only by the legacy
       migration's blanket default. This answer is NOT re-run through the header heuristic (that is the
       pre-gate consent bypass `rules.ts#headerHeuristic` forbids). Instead the STRONGER
       `migrationBulkPlacement` floor decides (`List-Unsubscribe` REQUIRED plus a corroborating
       marker), and a SENSITIVITY-flagged row is NEVER a candidate — that is `sensitive-rescreen.ts`'s
       jurisdiction and this pass does not compete with it. `basis: "migration_bulk"`.
     · `source: "rule"` and `source: "unclear"` — the user's own decision, or the ambiguous middle.
       Kept, unconditionally.

   The demotable ALLOWLIST (`seeded-from-sent`/`promoted`, never `manual`/`migrated`) is the engine's,
   reused, never re-encoded here; the `migration_bulk` floor is the ONE new marker rule and it lives in
   core beside `isBulkSend`, not here. The move GRANTS NO ADMISSION under any basis: no `rules` row, no
   `matchedRuleId`, nothing the learning path reads — the next message from that sender still screens.

   ── AND ACROSS ALL FOUR CLASSES: SENSITIVITY KEEPS, IT NEVER DEMOTES ────────────────────────

   A SENSITIVITY-flagged row (`sensitivity_category` set OR `no_ai`) is KEPT in the Ohbox and never
   demoted to Reads/Receipts, whatever its class. That is exactly what the LIVE router does —
   `pipeline.ts:563-567` forces INBOX for `sensitivity.sensitive && !deniedByConsent` so a login code,
   password reset or security alert reaches the user and is never buried — and this pass must match it
   or it re-buries the very mail sensitivity exists to protect. It is therefore ONE guard over every
   class (`policy`/`header`/`screener`/`migration_bulk`), in {@link ohboxTidyPass}, not one bolted onto
   each: the first version of this pass honored it in the `screener` branch alone and silently demoted
   flagged `policy`/`header` mail. Re-screening the flagged STRANGERS is `sensitive-rescreen.ts`'s job;
   this pass only leaves them where they are.

   ── USER ALWAYS WINS — AND THE SIGNAL FOR IT IS THE CHANGE LOG, NOT `last_set_by` ───────────

   The user-always-wins rule: a message the user has placed is not ours to move. Two writers set
   `folder_state.desired_folder = 'INBOX'`: this pipeline (at ingest) and the USER (an in-app drag,
   `message-service.ts#move`). BOTH stamp `last_set_by = 'us'`, so that column cannot tell them
   apart — it only catches a move the user made in their OWN mail client (`'external'`). What DOES
   record an in-app drag back to the Ohbox is a `change_log` row `op='move', meta->>'to'='INBOX'`,
   and the change log is never pruned. So the candidate query excludes any message that carries one
   (`change_log_move_to_inbox_idx`, mail 0043). The confound — the pipeline ALSO writes such a row at
   ingest for mail it pulled into the Ohbox from a NON-Ohbox arrival folder — is deliberately left
   in: it can only make the pass SKIP a message (over-exclusion fails LENIENT), never demote one the
   user placed, and the measured backlog arrived in the Ohbox with no such row. Mail moved into the
   Ohbox by a rule-retro pass is likewise left behind, for the same safe reason.

   The concurrent race (a user drag committing WHILE the pass pages) is closed by the lock, not by a
   predicate: `selectCandidates` takes `FOR UPDATE OF folder_state`. A drag that commits before the
   SELECT is visible to the `NOT EXISTS`; one that commits after blocks on the row lock, wakes after
   this pass commits, and re-writes `desired = 'INBOX'` on top — the user's placement is the last
   word. That claim is only true on real Postgres, so it lives in `ohbox-tidy.pg.test.ts`.

   ── IT WRITES AN INTENT. IT NEVER OPENS IMAP. ──────────────────────────────────────────────

   Organize-in-place: organization lands in real folders, but only the worker's reconcile pass opens a
   connection to apply it, through the one code path that moves mail crash-safely and holds the
   mailbox's lease. This pass writes `folder_state.desired_folder` plus a `move` change and stops;
   an `audit_log` row with an inverse records the demotion so the mailbox's owner has an undo. Every input the
   decision needs is already on disk. `ohbox-tidy.no-imap.test.ts` fails if a client is constructed.

   ── THE PACING IS THE RECONCILER'S, NOT THIS PASS'S ────────────────────────────────────────

   `OHBOX_TIDY_WRITES_PER_CYCLE` bounds how much desired state this pass may CREATE per account per
   cycle, and the reason is downstream and identical to `rule-retro.ts`: `reconcileFolders` walks an
   unbounded `listPendingFolderStates` serially, one IMAP move per row, inside the sync cycle, and
   `beat()` is the last statement of that cycle. Queue a few hundred moves in one cycle and the cycle
   misses its heartbeat and pages an operator — for a real couple-hundred-row backlog, a real risk. So the
   backlog drains across cycles; the budget + the cursor + the marker-written-last make a capped run
   resume exactly where it stopped.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Rows examined per transaction — the same 100 as the sibling passes, and for the same reason:
 * {@link recordChange} takes the account's `account_sync_state` row lock for the length of its
 * transaction, so a whole-backlog transaction would stall every API write for that account.
 */
export const OHBOX_TIDY_BATCH = 100;

/**
 * Desired-state rows this pass may create for ONE account in ONE worker cycle. THE REASON IS THE
 * RECONCILER — see the header. Measured and tuned, not defended; separate from {@link OHBOX_TIDY_BATCH}
 * (that one is a DB lock, this one is how much physical mail movement one poll interval absorbs).
 */
export const OHBOX_TIDY_WRITES_PER_CYCLE = 100;

/**
 * Pages one account's backlog may walk in one cycle before the pass gives up and says so. A bound
 * and not a `while (true)`: some candidates STAY (a human, a relevant alert), so a "loop until an
 * empty page" pass would re-read them forever — termination is the cursor, which is monotone in
 * `messages.id`, not an empty page.
 */
export const OHBOX_TIDY_MAX_PAGES = 500;

export interface OhboxTidyDeps {
  /** Scope to ONE account — the worker loops its served accounts. */
  accountId: string;
  log?: Logger;
  now?: () => Date;
  /** Test seam. Default {@link OHBOX_TIDY_BATCH}. */
  batch?: number;
  /** Test seam. Default {@link OHBOX_TIDY_WRITES_PER_CYCLE}. */
  writesPerCycle?: number;
  /** Test seam. Default {@link OHBOX_TIDY_MAX_PAGES}. */
  maxPages?: number;
  /**
   * Re-run an account whose `ohbox_tidy_done_at` is already stamped — EVIDENCE, not a repair.
   *
   * The pass is idempotent WITHOUT the marker (a message it moved is desired into Reads/Receipts and
   * drops out of the candidate query; a message the user dragged back carries the move-to-INBOX
   * guard row), and this flag exists so that claim is exercised rather than asserted: the pg test
   * re-runs a finished account with `force` and requires ZERO writes. It does NOT touch the
   * candidate query or the cursor.
   */
  force?: boolean;
  /**
   * The authserv-ids a MAILBOX's own provider signs `Authentication-Results` with — per mailbox,
   * for parity with the live path, though this pass acts only on demote-shaped answers:
   * a `"fail"` verdict makes the engine answer `screener`, which this pass leaves alone, so a
   * populated set can only KEEP a row in the Ohbox, never move one out. Production passes
   * `adapters/drizzle-repo.ts#mailboxProviderAuthservIds`; the pass caches per mailbox per run.
   *
   * REQUIRED, not optional-with-an-empty-default, for the reason `rule-retro.ts` gives: for this
   * input the absent-config default is the dangerous branch. A caller that has decided to trust
   * nothing types `async () => NO_TRUSTED_AUTHSERV_IDS`.
   */
  trustedAuthservIdsFor: (db: Tx, mailboxId: string) => Promise<ReadonlySet<string>>;
  /**
   * REHEARSE THE PASS AND ROLL EVERY PAGE BACK — what a "plan" is. The pass runs for real, reads the
   * counts, and throws {@link DryRunRollback} as the last statement of each page so the database
   * discards the writes. The marker and the cursor are never touched (a rollback discards the cursor
   * write too; `afterId` is JS state). Same shape as `sensitive-rescreen.ts`, and per PAGE rather
   * than one transaction round the whole account for the seq-lock reason that file spells out.
   */
  dryRun?: boolean;
  /**
   * ASSUME this posture instead of reading it from `account_settings`, and ONLY legal under
   * {@link dryRun}. It is what lets a plan answer "how much WOULD move if this account were
   * `people_only`" WITHOUT flipping the posture — flipping it stamps `ohbox_tidy_requested_at` and
   * starts the LIVE worker on the backlog, which is the opposite of a preview. The constructor
   * throws if it is set without `dryRun`, so the dangerous combination is unrepresentable; the live
   * worker path never sets it and reads the posture from the locked row.
   */
  assumePolicy?: OhboxPolicy;
}

export interface OhboxTidyResult {
  /** False ⇒ the account was not owed a tidy (or its posture is lenient) and nothing was read. */
  ran: boolean;
  /** Candidate rows examined. */
  examined: number;
  /** Rows demoted out of the Ohbox. */
  moved: number;
  /** Rows re-evaluation left in the Ohbox — a human, a relevant alert, a manual rule, a deny. */
  kept: number;
  /** Destination → how many movers went there. Always a subset of {Reads, Receipts}. */
  destinations: Record<string, number>;
  /**
   * Basis → how many movers carried it (`policy` / `header` / `migration_bulk`). The per-class
   * breakdown the operator plan reports: how much of the Ohbox each of the three misfiled populations
   * accounts for.
   */
  basis: Record<string, number>;
  /**
   * Rows that met a demotion but were KEPT because they are sensitivity-flagged — the safety margin,
   * reported so the mailbox's owner can see how much was deliberately left in the Ohbox for
   * `sensitive-rescreen.ts` rather than filed to Reads/Receipts. Counts a flagged mover of ANY class
   * (`policy`/`header`/`migration_bulk`); before the cross-class KEEP guard it counted only the
   * `screener` strong-bulk class, which was the whole of the divergence from the live router.
   */
  sensitivityExcluded: number;
  /** True ⇒ the per-cycle write budget ran out; the rest resumes next cycle from the cursor. */
  capped: boolean;
  /** True ⇒ the whole backlog drained and `ohbox_tidy_done_at` was stamped (never under dryRun). */
  completed: boolean;
  /** True ⇒ the pass hit {@link OHBOX_TIDY_MAX_PAGES}; the marker is NOT written. */
  truncated: boolean;
}

const OHBOX: Destination = "INBOX";

/** One candidate, carrying everything `evaluateRules` reads — all of it from disk. */
interface TidyRow {
  messageId: string;
  mailboxId: string;
  fromAddress: string;
  subject: string;
  /**
   * `message_bodies.text`, or `""` where no body row exists — the haystack for a rule's
   * `body_contains` term (mail 0052), read back so this pass and ingest match against the same
   * string. `""` satisfies no term: a body rule declines to fire, fail-closed.
   */
  bodyText: string;
  headers: Record<string, string[]>;
  observedFolder: string;
  desiredFolder: string;
  /**
   * The sensitivity verdict, read so the caller's single sensitivity KEEP guard can hold a flagged
   * row in the Ohbox: a category or `no_ai` makes the message `sensitive-rescreen.ts`'s jurisdiction,
   * never this pass's. The guard spans EVERY class (`policy`/`header`/`screener`/`migration_bulk`),
   * matching the live router's carve-out at `pipeline.ts:563-567` — see {@link ohboxTidyPass}.
   */
  sensitivityCategory: string | null;
  noAi: boolean;
}

/** The reason a demotion happened, recorded on the `audit_log` payload — a property of the MOVE. */
type MoveBasis = "policy" | "header" | "migration_bulk";

/** A resolved demotion: where to file it, why, and (policy only) which allow rule it refined. */
interface TidyMove {
  to: Destination;
  basis: MoveBasis;
  overriddenRuleId: string | null;
}

/** True ⇒ the message is sensitivity-flagged (`sensitivity_category` set OR `no_ai`). */
function isSensitivityFlagged(row: TidyRow): boolean {
  return row.sensitivityCategory !== null || row.noAi;
}

/**
 * WHAT THIS PASS DOES WITH ONE ENGINE ANSWER — the per-class engine→pile mapping, in ONE place.
 *
 * Keyed on `decision.source`. Every branch either returns a demotion to a VISIBLE, REVERSIBLE pile
 * (Reads/Receipts) or `null` to keep the message where it is. It never returns the Screener or
 * Quarantine — a backfill demotes within the allow side, it does not re-screen (that is
 * `sensitive-rescreen.ts`). See the file header for why the Ohbox holds three misfiled populations.
 *
 * This mapping is SENSITIVITY-AGNOSTIC on purpose. The sensitivity carve-out is a SINGLE guard in the
 * caller ({@link ohboxTidyPass}) applied across every class, so it cannot drift branch by branch — the
 * shape the review found broken, where only the `screener` branch honored it and flagged
 * `policy`/`header` mail was demoted out from under a login code the live router keeps in the Ohbox.
 */
function tidyPlacement(msg: NormalizedMessage, decision: RuleDecision): TidyMove | null {
  switch (decision.source) {
    case "policy":
      // AS SHIPPED. The inferred-admission demotion; destination is the engine's (Reads/Receipts).
      return decision.destination === null
        ? null
        : { to: decision.destination, basis: "policy", overriddenRuleId: decision.overriddenRuleId ?? null };
    case "header":
      // The live router's own placement for a rule-less CONTACT, replayed over mail the legacy router
      // filed before that branch existed. Not a new consent judgment. `overriddenRuleId: null` — no
      // rule was overridden (there is none), and nothing here feeds the learning path.
      return decision.destination === null
        ? null
        : { to: decision.destination, basis: "header", overriddenRuleId: null };
    case "screener": {
      // The THIRD population: no rule, NOT a contact. The engine would SCREEN this on arrival today,
      // but the mail is already in the Ohbox by the legacy blanket default and re-screening it is not
      // this pass's business. We only DEMOTE the obvious strong-bulk to Reads/Receipts, via the
      // stronger `migrationBulkPlacement` floor — NOT the header heuristic, which must never run for a
      // non-contact (the pre-gate consent bypass). A sensitivity-flagged row is held back by the
      // caller's cross-class KEEP guard before this move is ever acted on.
      const to = migrationBulkPlacement(msg);
      return to === null ? null : { to, basis: "migration_bulk", overriddenRuleId: null };
    }
    default:
      // `rule` (the user's own decision) and `unclear` (the ambiguous middle) — keep, unconditionally.
      return null;
  }
}

/** One page's outcome — carried out of a dry-run page by the sentinel, or returned on commit. */
interface PageResult {
  /** The gate failed on this page: the posture was revoked, or the account is no longer owed. */
  stopped: boolean;
  rows: number;
  moved: number;
  kept: number;
  lastId: string | null;
  destinations: Record<string, number>;
  basis: Record<string, number>;
  sensitivityExcluded: number;
  capped: boolean;
  /** A short page not cut by the budget — the end of the backlog. */
  done: boolean;
}

/**
 * The only way out of a dry-run page — the result is CARRIED, not logged. Thrown as the LAST
 * statement of the page callback (after the counts are read), so postgres-js turns it into ROLLBACK
 * and rethrows it unchanged. Anything that `return`s instead COMMITS the page.
 */
class DryRunRollback extends Error {
  constructor(readonly page: PageResult) {
    super("ohbox-tidy: dry-run page rolled back");
    this.name = "DryRunRollback";
  }
}

const EMPTY = (): OhboxTidyResult => ({
  ran: false, examined: 0, moved: 0, kept: 0, destinations: {}, basis: {}, sensitivityExcluded: 0,
  capped: false, completed: false, truncated: false,
});

/**
 * THE PASS, for ONE account. Find whether a tidy is owed, then walk the Ohbox backlog under the
 * account's posture until the cycle's write budget is spent — resuming across cycles from the
 * cursor, and marking done exactly once when the backlog drains.
 *
 * Pure and hermetic — a db/tx handle, a clock and a logger — so a test drives it against PGlite
 * with no worker, no lease and no network. The transactional claims PGlite cannot see (`FOR UPDATE`,
 * the two-driver cursor serialization on the settings row, the user-move race) live in
 * `ohbox-tidy.pg.test.ts` against real Postgres, because an embedded database cannot exercise them.
 */
export async function ohboxTidyPass(
  db: Tx, deps: OhboxTidyDeps, nowArg?: Date,
): Promise<OhboxTidyResult> {
  if (deps.assumePolicy !== undefined && !deps.dryRun) {
    // Unrepresentable-by-construction: an assumed posture is only ever a rehearsal input. A live
    // worker cycle that set it would demote real mail under a posture the account never chose.
    throw new Error("ohboxTidyPass: assumePolicy is only legal with dryRun");
  }
  const log = deps.log ?? silentLogger;
  const now = () => nowArg ?? deps.now?.() ?? new Date();
  const batch = deps.batch ?? OHBOX_TIDY_BATCH;
  const budget = deps.writesPerCycle ?? OHBOX_TIDY_WRITES_PER_CYCLE;
  const maxPages = deps.maxPages ?? OHBOX_TIDY_MAX_PAGES;
  const accountId = deps.accountId;
  // Per-mailbox authserv trust, cached for the run — configuration, not row state, so it cannot
  // go stale across pages. Issued on the OUTER handle; only the RESULT is used inside a page
  // transaction. Same construction as `rule-retro.ts#trustFor`.
  const authservCache = new Map<string, ReadonlySet<string>>();
  const trustFor = async (mailboxId: string): Promise<ReadonlySet<string>> => {
    const hit = authservCache.get(mailboxId);
    if (hit) return hit;
    const ids = await deps.trustedAuthservIdsFor(db, mailboxId);
    authservCache.set(mailboxId, ids);
    return ids;
  };

  // ── THE OWED PROBE, AND THE STARTING CURSOR ────────────────────────────────────────────────
  //
  // One PK read of `account_settings`. `ohbox_tidy_requested_at` set past `ohbox_tidy_done_at` (or
  // with it NULL) IS the definition of owed work — there is no queue. Under a dry-run plan with an
  // assumed posture the owed gate is SKIPPED (the plan answers "what would move", regardless of
  // whether this account has asked), but the real posture read still runs for the non-plan path.
  const [settings] = await db.select({
    policy: accountSettings.ohboxPolicy,
    requestedAt: accountSettings.ohboxTidyRequestedAt,
    doneAt: accountSettings.ohboxTidyDoneAt,
    cursor: accountSettings.ohboxTidyCursor,
  }).from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);

  const policy: OhboxPolicy = deps.assumePolicy ?? resolveOhboxPolicy(settings?.policy ?? null);
  const owed = isOwed(settings, deps.force ?? false);
  if (!deps.assumePolicy && (policy !== "people_only" || !owed)) return EMPTY();

  // ── THE ACCOUNT'S OWN ADDRESSES — READ ONCE, AND THAT ONE IS DELIBERATE ──────────────────────
  //
  // These shape the candidate QUERY (they are what "not from myself" excludes), and the set changes
  // only when a mailbox is connected or removed — an act that restarts this pass's world anyway. It
  // is read once and named as such, rather than swept along with the two reads below.
  const ownRows = await db.select({ address: mailboxes.address }).from(mailboxes)
    .where(eq(mailboxes.accountId, accountId));
  const ownAddresses = ownRows.map((r) => r.address.toLowerCase());

  const result: OhboxTidyResult = { ...EMPTY(), ran: true };
  let afterId: string | null = settings?.cursor ?? null;
  // The three ways the walk can END, kept as explicit flags rather than inferred from `!capped`:
  // only a genuine DRAIN stamps `done_at`. A REVOKE (the posture flipped back mid-run) and a CAP
  // (the write budget ran out) both stop short, and running out of pages is a TRUNCATION.
  let drained = false;
  let revoked = false;

  let page = 0;
  for (; page < maxPages; page++) {
    if (result.moved >= budget) { result.capped = true; break; }

    let outcome: PageResult;
    try {
      outcome = await db.transaction(async (tx) => {
        // ── THE SETTINGS ROW IS THE SERIALIZATION POINT, AND THE REVOKE CHECK ─────────────────
        //
        // Locked FOR UPDATE first, before `folder_state` and before the seq lock `recordChange`
        // takes — the same lock order as `rule-retro.ts` (its owned RULE row → folder_state → seq).
        // Two drivers (a worker cycle and a second worker mid-failover) both block here; the loser
        // wakes with the winner's committed cursor and pages forward from it. It is ALSO the revoke
        // check: a user who flipped back to lenient, or whose owed window closed, stops the pass at
        // the next page boundary rather than finishing work they withdrew. The 30 s `screeningFor`
        // cache in `index.ts` is deliberately NOT trusted for this — that is for gating whether the
        // pass STARTS; the authoritative, serialized read is here.
        const [live] = await tx.select({
          policy: accountSettings.ohboxPolicy,
          requestedAt: accountSettings.ohboxTidyRequestedAt,
          doneAt: accountSettings.ohboxTidyDoneAt,
        }).from(accountSettings)
          .where(eq(accountSettings.accountId, accountId)).limit(1).for("update");

        const livePolicy = deps.assumePolicy ?? resolveOhboxPolicy(live?.policy ?? null);
        const stillOwed = deps.assumePolicy ? true : isOwed(live, deps.force ?? false);
        if (livePolicy !== "people_only" || !stillOwed) {
          return {
            stopped: true, rows: 0, moved: 0, kept: 0, lastId: null,
            destinations: {}, basis: {}, sensitivityExcluded: 0, capped: false, done: false,
          };
        }

        // ── THE KNOWLEDGE THE DECISION RESTS ON, RE-ASKED PER PAGE ───────────────────────────
        //
        // These used to be read ONCE per run, above the loop, behind a comment claiming *"this pass
        // is the only writer of the state it decides against, so a per-page re-read would cost
        // queries to observe a change that cannot happen"*. **It can happen and there are six
        // writers.** `rules` is written by the API's rule editor (`routes/rules.ts`), and the
        // `contacts` set behind `knownSenders` by the Screener's decide path
        // (`screener-service.ts`), the Junk window (`junk-window.ts`), the profile import, the
        // consent seed and the ingest pipeline's own contact learning. So a run that started before
        // a user deleted a rule went on tidying mail out of the Ohbox under it, page after page,
        // and the comment was the reason nobody looked.
        //
        // Read INSIDE the page transaction and bound to `tx`, after the settings row is locked, so
        // the knowledge is exactly as fresh as the posture check above it and the candidate set
        // below it. The old comment's counter-argument — that two pages of one run would then decide
        // under different knowledge — is not a cost, it is the REQUIREMENT: the settings row is
        // already re-read per page for precisely that reason, and cached rules made the decision
        // half-fresh in a way no reader could see. Two indexed reads per hundred rows.
        const pageRepo = makeDrizzleRepo(tx as unknown as Parameters<typeof makeDrizzleRepo>[0]);
        const rules: Rule[] = await pageRepo.listRules(accountId);
        const known: ReadonlySet<string> = await pageRepo.knownSenders(accountId);

        const candidates = await selectCandidates(tx, { accountId, ownAddresses, limit: batch, afterId });

        let moved = 0;
        let kept = 0;
        let sensitivityExcluded = 0;
        let lastId: string | null = null;
        let capped = false;
        const destinations: Record<string, number> = {};
        const basis: Record<string, number> = {};

        for (const c of candidates) {
          // Budget enforced PER ROW, so the cap is exact and the cursor resumes at the last row this
          // pass actually decided about — never past one it skipped.
          if (result.moved + moved >= budget) { capped = true; break; }

          const msg = asRuleInput(c);
          const decision = evaluateRules({
            msg, rules, knownSenders: known,
            auth: authVerdictFromHeaders(c.headers, c.fromAddress, await trustFor(c.mailboxId)),
            ohboxPolicy: livePolicy,
          });
          lastId = c.messageId;

          // The per-class engine→pile mapping ({@link tidyPlacement}): `policy`/`header` take the
          // engine's own Reads/Receipts destination, `screener` goes through the stronger
          // `migration_bulk` floor (never the header heuristic), and `rule`/`unclear` are kept. The
          // `to === desiredFolder` guard is belt-and-braces: no basis answers INBOX, but a narrowing
          // that leaned on that is one refactor from filing mail onto itself.
          const placement = tidyPlacement(msg, decision);
          if (placement === null || placement.to === c.desiredFolder) {
            kept++;
            continue;
          }

          // ── SENSITIVITY KEEP — ONE GUARD, EVERY CLASS. This is `pipeline.ts:563-567`. ────────────
          //
          // The live router force-keeps a sensitivity-flagged message in the Ohbox
          // (`sensitivity.sensitive && !deniedByConsent ? "INBOX"`), so a login code / password reset
          // / security alert reaches the user and is never buried. This pass must do the same for
          // EVERY class it can move — `policy`, `header`, `screener` and `migration_bulk` — not the
          // `screener` branch alone, which was the whole of the divergence the review found.
          //
          // The `!deniedByConsent` half of the live predicate is satisfied by construction here: a
          // denied row (`source: "rule"` → Quarantine/Screened) maps to a `null` placement and was
          // already kept above, so by this point `placement` is always an ALLOW-side demotion
          // (Reads/Receipts) — never a deny pile. So keeping every flagged row that would otherwise
          // move is exactly `sensitive && !deniedByConsent ⇒ keep`, and it never frees a sender the
          // user denied. Re-screening the flagged strangers is `sensitive-rescreen.ts`'s job; this
          // pass only leaves them in place. `sensitivityExcluded` is the safety margin: rows this
          // guard held back that would otherwise have been filed to Reads/Receipts.
          if (isSensitivityFlagged(c)) {
            sensitivityExcluded++;
            kept++;
            continue;
          }
          const to = placement.to;

          await upsertDesired(tx, c, to, now());
          // The optimistic, user-wins `move` delta the client mirror converges on, carrying the TRUE
          // previous desired folder so a later undo needs nothing extra written.
          await recordChange(tx, {
            accountId, entityType: "message", entityId: c.messageId, op: "move",
            meta: { from: c.desiredFolder, to },
          });
          // The undo the mailbox's owner is owed: this pass moved mail they did not individually ask it to
          // touch, so "put it back" has to be expressible. `basis` records WHY (`policy`/`header`/
          // `migration_bulk`) and `overriddenRuleId` records WHICH seeded allow rule's placement a
          // `policy` demotion refined (null for the two new bases — there is no rule). Durable
          // provenance with no schema change and no learning-path read: the engine carries
          // `matchedRuleId: null` on every basis, so the move teaches no consent and the next message
          // from this sender still screens.
          await tx.insert(auditLog).values({
            accountId, action: "ohbox_tidy_move",
            payload: {
              mailboxId: c.mailboxId, messageId: c.messageId,
              from: c.desiredFolder, to, basis: placement.basis, overriddenRuleId: placement.overriddenRuleId,
            },
            inverse: { messageId: c.messageId, from: to, to: c.desiredFolder },
          });
          moved++;
          destinations[to] = (destinations[to] ?? 0) + 1;
          basis[placement.basis] = (basis[placement.basis] ?? 0) + 1;
        }

        // The cursor advances in the SAME transaction as the writes, so a crash can neither lose a
        // page's work nor replay it. Under a dry run this UPDATE is rolled back with everything else,
        // which is exactly right: `afterId` is JS state and carries the plan forward without it.
        if (lastId !== null) {
          await tx.update(accountSettings)
            .set({ ohboxTidyCursor: lastId, updatedAt: now() })
            .where(eq(accountSettings.accountId, accountId));
        }

        const pageResult: PageResult = {
          stopped: false, rows: candidates.length, moved, kept, lastId, destinations, basis,
          sensitivityExcluded, capped,
          done: !capped && candidates.length < batch,
        };
        if (deps.dryRun) throw new DryRunRollback(pageResult);
        return pageResult;
      });
    } catch (err) {
      if (!(err instanceof DryRunRollback)) throw err;
      outcome = err.page;
    }

    if (outcome.stopped) {
      // Revoked or no longer owed — stop WITHOUT stamping done: the work was withdrawn, not finished.
      revoked = true;
      break;
    }
    result.examined += outcome.rows;
    result.moved += outcome.moved;
    result.kept += outcome.kept;
    result.sensitivityExcluded += outcome.sensitivityExcluded;
    for (const [to, n] of Object.entries(outcome.destinations)) {
      result.destinations[to] = (result.destinations[to] ?? 0) + n;
    }
    for (const [b, n] of Object.entries(outcome.basis)) {
      result.basis[b] = (result.basis[b] ?? 0) + n;
    }
    if (outcome.capped) { result.capped = true; break; }
    if (outcome.done || outcome.rows === 0) { drained = true; break; }
    afterId = outcome.lastId ?? afterId;
  }

  // Ran to the page bound without draining, capping or being revoked ⇒ truncated: resume next cycle.
  result.truncated = !drained && !revoked && !result.capped;
  if (result.truncated) {
    log.warn("ohbox_tidy_truncated", {
      accountId, examined: result.examined, moved: result.moved, kept: result.kept, maxPages,
      dryRun: deps.dryRun === true,
      reason: "the Ohbox backlog exceeded one pass's page bound — the marker is NOT written, so the " +
        "next cycle resumes from `ohbox_tidy_cursor`",
    });
    return result;
  }

  // ── THE MARKER IS WRITTEN LAST, AND A DRY RUN SKIPS IT RATHER THAN ROLLING IT BACK ─────────
  //
  // Only on a genuine DRAIN — never a cap, a revoke or a truncation. Written last on 0030's rule:
  // claiming it first makes a crash permanent. The `WHERE` makes the answer the DATABASE's — two
  // drivers finishing at once produce one stamp — and, by comparing against `requested_at`, refuses
  // to mark done an account a "tidy now" re-armed WHILE this run was draining: that account's
  // `requested_at` has moved past this `now()`, so it stays owed and the next cycle re-runs.
  if (drained && !deps.assumePolicy && !deps.dryRun) {
    await db.update(accountSettings).set({ ohboxTidyDoneAt: now(), updatedAt: now() })
      .where(and(
        eq(accountSettings.accountId, accountId),
        isNotNull(accountSettings.ohboxTidyRequestedAt),
        or(
          isNull(accountSettings.ohboxTidyDoneAt),
          sql`${accountSettings.ohboxTidyDoneAt} < ${accountSettings.ohboxTidyRequestedAt}`,
        ),
      ));
    result.completed = true;
  }

  if (result.moved > 0 || result.completed || deps.dryRun) {
    log.info(deps.dryRun ? "ohbox_tidy_plan" : "ohbox_tidy_applied", {
      accountId, examined: result.examined, moved: result.moved, kept: result.kept,
      destinations: result.destinations, basis: result.basis,
      sensitivityExcluded: result.sensitivityExcluded,
      completed: result.completed, capped: result.capped,
    });
  }
  return result;
}

/** `requested_at` set past `done_at` (or with it NULL) is owed; `force` ignores `done_at`. */
function isOwed(
  s: { requestedAt: Date | null; doneAt: Date | null } | undefined, force: boolean,
): boolean {
  if (!s || s.requestedAt === null) return false;
  if (force) return true;
  return s.doneAt === null || s.doneAt < s.requestedAt;
}

/**
 * ONE page of the Ohbox this pass may reconsider — LOCKED FOR UPDATE, oldest id first.
 *
 * ── THE CANDIDATE SET ──────────────────────────────────────────────────────────────────────
 *
 *  · `folder_state.desired_folder = 'INBOX'` — it is in the Ohbox. Also the whole of the idempotency:
 *    a row this pass has already demoted is desired into Reads/Receipts and drops out, so a second
 *    run writes nothing whether or not the marker is set.
 *  · `folder_state.last_set_by = 'us'` — a row set `'external'` is a placement the USER made in their
 *    own mail client, which the reconciler already refuses to revert.
 *  · the mailbox is not `disabled` — a disabled mailbox is one Cloud no longer organizes (the lease
 *    was lost, or the user left), and nothing will ever reconcile a `pending` row written for it.
 *  · NO move-to-Ohbox change row — the "user always wins" guard (see the file header). An in-app drag
 *    back into the Ohbox is the one intent `folder_state` cannot express and the change log can.
 *
 * ── THE FOUR USER-INTENT EXCLUSIONS ────────────────────────────────────────────────────────
 *
 * The sibling passes' rule, one direction over: a message the user has TRIAGED, replied to, or ruled
 * on is not ours to move. Copied from `sensitive-rescreen.ts` because they are the same predicates:
 *  1. no `message_states` row other than `none` (reply-later / set-aside / bubbled-up / muted);
 *  2. no `drafts` row replying to it;
 *  3. no DECIDED `approvals` row (`status <> 'pending'` — a pending one is OURS, unanswered);
 *  4. no message in the same thread from the account's own address (they replied from their client).
 *
 * ── AND THE ONE THAT IS DELIBERATELY ABSENT ────────────────────────────────────────────────
 *
 * `sensitive-rescreen.ts` also excludes any sender carrying an enabled `rules` row. This pass does
 * NOT, and the reason is the whole point of the widened per-class handling: the candidate set is the
 * WHOLE Ohbox, because the misfiled backlog is three populations, not one — inferred-admission allow
 * rules (`policy`), rule-less CONTACTS (`header`), and senders with no rule who are not contacts at
 * all, admitted only by the legacy migration's blanket default (`migration_bulk`). Excluding
 * rule-carrying senders would drop the `policy` population — the largest — entirely. The
 * `manual`/`migrated`/deny exemption is therefore NOT a candidate predicate; it is `evaluateRules`
 * answering `source: "rule"`, which {@link tidyPlacement} keeps. READ is likewise not excluded, on the
 * siblings' reasoning: reading is not consent, and the Ohbox is full of read automated mail that is
 * exactly what this exists to move.
 *
 * SENSITIVITY is not a candidate predicate either — it is read onto {@link TidyRow} and applied by a
 * SINGLE KEEP guard in {@link ohboxTidyPass} that spans EVERY class. A flagged row (`sensitivity_category`
 * set OR `no_ai`) is held in the Ohbox rather than demoted, whether its class is `policy`, `header`,
 * `screener` or `migration_bulk` — because the live router keeps sensitive mail in the Ohbox too
 * (`pipeline.ts:563-567` forces INBOX for `sensitivity.sensitive && !deniedByConsent`), so an OTP,
 * password reset or security alert reaches the user and is never buried in Reads/Receipts. Matching
 * that behavior is the point; re-screening the flagged STRANGERS is `sensitive-rescreen.ts`'s job. (An
 * earlier note here claimed `policy`/`header` "stay byte-identical to the live router" while the guard
 * excluded only `migration_bulk` — that WAS the defect: the tidy demoted flagged `policy`/`header` mail
 * the live router keeps.)
 *
 * ── THE LOCK ───────────────────────────────────────────────────────────────────────────────
 *
 * `FOR UPDATE OF folder_state` — `of` the one table, because `message_bodies` is on the NULLABLE side
 * of a LEFT JOIN (Postgres refuses to lock it) and locking `messages` would serialize against
 * ordinary ingest for no benefit. This lock is what makes the concurrent user-drag race safe: see the
 * file header.
 */
async function selectCandidates(
  t: Tx,
  opts: { accountId: string; ownAddresses: readonly string[]; limit: number; afterId: string | null },
): Promise<TidyRow[]> {
  const filters = [
    eq(messages.accountId, opts.accountId),
    eq(folderState.desiredFolder, OHBOX),
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
    // USER ALWAYS WINS — an in-app drag back into the Ohbox. Matches change_log_move_to_inbox_idx.
    sql`not exists (
      select 1 from change_log cl
       where cl.account_id = ${messages.accountId}
         and cl.entity_id = ${messages.id}
         and cl.op = 'move'
         and cl.meta ->> 'to' = 'INBOX'
    )`,
    // 1 — the user has triaged this message.
    sql`not exists (
      select 1 from ${messageStates} ms
       where ms.message_id = ${messages.id} and ms.state <> 'none'
    )`,
    // 2 — the user is replying, or has replied, through ohmail.
    sql`not exists (
      select 1 from ${drafts} d where d.in_reply_to_message_id = ${messages.id}
    )`,
    // 3 — the user decided on an AI proposal about this message.
    sql`not exists (
      select 1 from ${approvals} a
       where a.message_id = ${messages.id} and a.status <> 'pending'
    )`,
  ];
  // 4 — the user replied from their own mail client. Guarded on a non-empty list (`in ()` is a
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
    headers: messageBodies.headers,
    // Rides the join `headers` already pays for — see `TidyRow.bodyText` (mail 0052).
    bodyText: messageBodies.text,
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
    bodyText: r.bodyText ?? "",
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
 * have, and `pending` is what makes the worker's reconciler perform the physical move.
 */
async function upsertDesired(t: Tx, row: TidyRow, destination: string, now: Date): Promise<void> {
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
 * The persisted row in the shape `evaluateRules` reads — sender, subject, headers, and (since
 * `body_contains`, mail 0052) the stored plain text, all on disk. No IMAP, no MIME re-parse:
 * `textBody` is `message_bodies.text` read back, `""` where no body row exists. `htmlBody` stays
 * empty because no rule reads it; if one ever does, this is where that becomes a visible lie.
 * Deliberately identical to the sibling passes' `asRuleInput`.
 */
function asRuleInput(row: TidyRow): NormalizedMessage {
  return {
    canonical: { messageIdHeader: null, bodyHash: "" },
    subject: row.subject,
    from: { name: null, address: row.fromAddress.toLowerCase() },
    to: [],
    cc: [],
    date: null,
    headers: row.headers,
    textBody: row.bodyText,
    htmlBody: null,
    hasAttachments: false,
    attachments: [],
  };
}
