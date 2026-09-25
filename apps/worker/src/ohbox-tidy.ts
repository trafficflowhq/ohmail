import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  accountSettings, approvals, auditLog, drafts, folderState, mailboxes,
  messageBodies, messageStates, messages, recordChange, weAnsweredThisSenderWhere,
  type Tx, auditAction,} from "@trafficflow/db";
import {
  authVerdictFromHeaders, evaluateRules,
  migrationBulkPlacement, resolveOhboxPolicy, silentLogger,
  type Destination, type Logger, type NormalizedMessage, type OhboxPolicy, type Rule,
  type RuleDecision,
} from "@trafficflow/core";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { carryDialect, dialect, type Dialect } from "@trafficflow/db/dialect";
import { perMailboxAuthservTrust, ruleInputOf, upsertDesired } from "./rule-pass.js";

/* RE-ROUTING THE OHBOX BACKLOG — mail `people_only` (migration 0042) was turned on too late to catch.
 * The engine (`rules.ts#evaluateRules`) demotes NEW mail under the posture, but a rule is consulted at
 * ARRIVAL only, so mail already filed stays. Each candidate goes back through the SAME `evaluateRules`,
 * acted on by `source`: `policy` (seeded-from-sent/promoted allow rule) and `header` (a contact) move to
 * Reads/Receipts; `screener` strangers are decided by the stronger `migrationBulkPlacement` floor
 * (`List-Unsubscribe` required), never the header heuristic; `rule`/`unclear` are kept. SENSITIVITY
 * (`sensitivity_category`/`no_ai`) is KEPT across every class, one guard, matching `pipeline.ts:563-567`.
 * User always wins via a `change_log` `op='move', meta->>'to'='INBOX'` row (`change_log_move_to_inbox_idx`,
 * mail 0043), re-asked under `FOR UPDATE OF folder_state` (`stillCandidates`). It writes an intent +
 * `audit_log` undo, never IMAP (`ohbox-tidy.no-imap.test.ts`); `OHBOX_TIDY_WRITES_PER_CYCLE` paces `reconcileFolders`. */

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
   * The authserv-ids a MAILBOX's provider signs `Authentication-Results` with — per mailbox, for parity
   * with the live path, though this pass acts only on demote-shaped answers (a `"fail"` verdict makes the
   * engine answer `screener`, which is left alone, so a populated set can only KEEP a row, never move one
   * out). Production passes `adapters/drizzle-repo.ts#mailboxProviderAuthservIds`; cached per mailbox per
   * run. REQUIRED, not optional-with-empty-default, for `rule-retro.ts`'s reason: the absent-config
   * default is the dangerous branch. A caller trusting nothing types `async () => NO_TRUSTED_AUTHSERV_IDS`.
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
 * WHAT THIS PASS DOES WITH ONE ENGINE ANSWER — the per-class engine→pile mapping, in ONE place. Keyed on
 * `decision.source`. Every branch either returns a demotion to a VISIBLE, REVERSIBLE pile (Reads/Receipts)
 * or `null` to keep the message; it never returns the Screener or Quarantine (a backfill demotes within
 * the allow side, it does not re-screen — that is `sensitive-rescreen.ts`). SENSITIVITY-AGNOSTIC on
 * purpose: the carve-out is a SINGLE guard in {@link ohboxTidyPass} across every class, so it cannot
 * drift branch by branch — the shape the review found broken, where only `screener` honored it and
 * flagged `policy`/`header` mail was demoted out from under a login code the live router keeps.
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
  // Per-mailbox authserv trust, cached for the run — {@link perMailboxAuthservTrust}'s rule.
  const trustFor = perMailboxAuthservTrust(db, deps.trustedAuthservIdsFor);

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
  const ownSet: ReadonlySet<string> = new Set(ownAddresses);

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

        // THE KNOWLEDGE THE DECISION RESTS ON, RE-ASKED PER PAGE. `rules`/`knownSenders` used to be read
        // ONCE per run behind a claim that "this pass is the only writer of the state it decides against".
        // It is not: `rules` is written by the API rule editor (`routes/rules.ts`) and `contacts` (behind
        // `knownSenders`) by the Screener decide path (`screener-service.ts`), the Junk window
        // (`junk-window.ts`), the profile import, the consent seed and the ingest pipeline's contact
        // learning — so a run that started before a user deleted a rule went on tidying under it. Read
        // INSIDE the page transaction, bound to `tx`, after the settings row is locked, so the knowledge is
        // as fresh as the posture check above and the candidates below. `carryDialect`, not the bare handle:
        // a `tx` object lacks the connection's dialect brand, so a repo built from `tx` refuses its first
        // locking statement.
        const pageRepo = makeDrizzleRepo(
          carryDialect(db, tx) as unknown as Parameters<typeof makeDrizzleRepo>[0],
        );
        const rules: Rule[] = await pageRepo.listRules(accountId);
        const known: ReadonlySet<string> = await pageRepo.knownSenders(accountId);

        const candidates = await selectCandidates(tx, { accountId, ownAddresses, limit: batch, afterId });
        // Asked again, in a statement of its own, over exactly the rows now locked — see
        // {@link stillCandidates} for why the lock alone does not close the user-drag race.
        const stillOurs = await stillCandidates(tx, candidates.map((c) => c.messageId), { accountId, ownAddresses });

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

          // USER ALWAYS WINS, even when their drag committed while this page waited on the lock.
          // Counted KEPT and the cursor still advances: the row was examined and decided about.
          if (!stillOurs.has(c.messageId)) { lastId = c.messageId; kept++; continue; }

          const msg = ruleInputOf(c);
          const decision = evaluateRules({
            msg, rules, knownSenders: known, ownAddresses: ownSet,
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

          // SENSITIVITY KEEP — ONE GUARD, EVERY CLASS. This is `pipeline.ts:563-567`. The live router
          // force-keeps a flagged message in the Ohbox (`sensitivity.sensitive && !deniedByConsent ?
          // "INBOX"`) so a login code / password reset / security alert is never buried, and this pass
          // must match it for EVERY movable class (`policy`, `header`, `screener`, `migration_bulk`), not
          // the `screener` branch alone (the whole divergence the review found). The `!deniedByConsent`
          // half holds by construction: a denied row (`source: "rule"`) maps to `null` and was kept above,
          // so by here `placement` is always an ALLOW-side demotion — keeping every flagged row that would
          // move is exactly `sensitive && !deniedByConsent ⇒ keep`. `sensitivityExcluded` is the margin.
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
            accountId, action: auditAction("ohbox_tidy_move"),
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
 * ONE page of the Ohbox this pass may reconsider — LOCKED FOR UPDATE, oldest id first. Candidates:
 * `folder_state.desired_folder = 'INBOX'` (in the Ohbox, and the idempotency — a demoted row is desired
 * into Reads/Receipts and drops out); `last_set_by = 'us'` (`'external'` is the user's own client; `'peer'`
 * is another install's placement, excluded here — only `rule-retro`, gated on a press, admits it); mailbox
 * not `disabled`; NO move-to-Ohbox `change_log` row (the "user always wins" guard). Four user-intent
 * exclusions (from `sensitive-rescreen.ts`): no non-`none` `message_states`, no `drafts` reply, no DECIDED
 * `approvals` (`status <> 'pending'`), no same-thread own-address reply. An enabled `rules` row is NOT
 * excluded (that would drop the `policy` population), nor is READ. SENSITIVITY is read onto {@link TidyRow}
 * and applied by the single KEEP guard in {@link ohboxTidyPass}. `FOR UPDATE OF folder_state` (not `message_bodies`). */
async function selectCandidates(
  t: Tx,
  opts: { accountId: string; ownAddresses: readonly string[]; limit: number; afterId: string | null },
): Promise<TidyRow[]> {
  const filters = candidateFilters(dialect(t), opts);
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
 * THE CANDIDATE PREDICATE, OWNED IN ONE PLACE — because it is now asked TWICE per page.
 *
 * {@link selectCandidates} asks it under the lock; {@link stillCandidates} re-asks it after the lock
 * in a statement of its own. Two copies of these clauses would drift, and the drift would be a user's
 * placement being overridden, so the exclusions live here and nowhere else. `afterId` is deliberately
 * NOT part of it: the cursor bounds the walk, it is not a statement about a message.
 */
function candidateFilters(d: Dialect, opts: { accountId: string; ownAddresses: readonly string[] }) {
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
  /* 4 — THE USER ANSWERED THIS SENDER. A MACHINE'S REPLY IS NOT THAT, AND NEITHER IS THE THREAD.
   * `weAnsweredThisSenderWhere` is the ONE spelling — `rule-retro` and `screener-auto` ask the
   * same question and each used to answer it its own way. It NARROWS this exclusion twice over
   * (the away responder is not the person; a reply addressed to somebody else on the thread is
   * not a reply to this sender), so it can only admit more candidates.
   */
  filters.push(sql`not ${weAnsweredThisSenderWhere(d, {
    accountId: messages.accountId as unknown as SQL,
    threadId: messages.threadId as unknown as SQL,
    fromAddress: messages.fromAddress as unknown as SQL,
    ownAddresses: opts.ownAddresses,
  })}`);
  return filters;
}

/**
 * WHICH OF THE LOCKED ROWS ARE STILL OURS TO MOVE — RE-ASKED IN A NEW STATEMENT. `FOR UPDATE OF
 * folder_state` serializes the user's in-app drag against this pass but does NOT make the drag VISIBLE to
 * the SELECT that waited on it: the lock releases on the user's COMMIT, and the re-check admitting the
 * woken row evaluates its sub-selects under the statement's original snapshot — so the `change_log`
 * move-to-INBOX row the user just wrote is unseen, the row stays a candidate, and this pass demotes mail
 * the user put back (measured: parked six seconds on the lock, then moved it). A SEPARATE statement takes
 * a NEW snapshot under READ COMMITTED, which sees the freeing commit; it needs no lock (we already hold
 * these rows). Rows it no longer admits are counted KEPT, so walk, cursor and `examined` are unchanged.
 */
async function stillCandidates(
  t: Tx,
  ids: readonly string[],
  opts: { accountId: string; ownAddresses: readonly string[] },
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set<string>();
  const rows = await t.select({ messageId: messages.id })
    .from(folderState)
    .innerJoin(messages, eq(messages.id, folderState.messageId))
    .where(and(...candidateFilters(dialect(t), opts), inArray(messages.id, [...ids])));
  return new Set(rows.map((r) => r.messageId));
}

