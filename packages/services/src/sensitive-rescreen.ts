import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  mailboxes, messages, messageBodies, folderState, messageStates, drafts, approvals,
  rules as rulesTbl, auditLog, changeLog, recordChange, type Tx,
} from "@trafficflow/db";
import {
  DEFAULT_OHBOX_POLICY, authVerdictFromHeaders, evaluateRules,
  silentLogger, type Destination, type Logger, type NormalizedMessage, type Rule,
} from "@trafficflow/core";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { Db } from "./context.js";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   RE-ROUTING MAIL THE CONSENT BYPASS ALREADY MISROUTED (mail 0030)
   ══════════════════════════════════════════════════════════════════════════════════════════

   ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────────

   `pipeline.ts:393` used to read `sensitivity.sensitive ? "INBOX" : decision.destination`. The
   sensitivity verdict therefore OVERRODE the consent gate, and `classifySensitivity` reads the
   subject and the body — both written by the sender. So `Subject: your verification code` was a
   remote, unauthenticated, one-message defeat of the Screener needing no knowledge of the user's
   contacts and no action by them, and an OTP-shaped body freed a sender the user had explicitly
   Quarantined. The forward fix subordinated sensitivity to `effectForDestination`.

   **That fix is forward-looking only, and this file is the other half.** Measured on an
   affected mailbox after the fix had shipped, the sensitive-flagged mail the bypass had filed
   into the Ohbox was the majority of that Ohbox, and nearly all of it came from senders absent
   from `contacts` — mail the user never consented to receive.

   Nothing re-routes a message once it is filed, so without this pass an affected Ohbox stays
   mostly non-consented mail, for ever.

   ── IT RE-EVALUATES. IT DOES NOT INVERT. ───────────────────────────────────────────────────

   The tempting shortcut — "sensitive + sender not in `contacts` ⇒ Screener" — is a SECOND router,
   and a second router drifts from the first. It would also be wrong on the day it shipped: a
   handful of the candidates are from senders the user already knows, and a known sender's login
   code must land in the Ohbox, which is the behaviour the forward fix deliberately preserved.

   So every candidate goes back through the real {@link evaluateRules} — the user's own rules
   resolved by the same total order, the same `contacts` set, the same header heuristic — and only
   an answer whose `source` is `"screener"` is moved. A `rule` answer means the user has already
   decided; a `header` answer means the sender is past the gate and the heuristic is merely
   refining placement, and relocating old mail on a heuristic is not this pass's business.

   ── WHAT IT MUST NEVER DO ──────────────────────────────────────────────────────────────────

   Open IMAP. The mailbox is the master: this writes `folder_state.desired_folder` plus
   a `move` change and stops, and the worker's reconcile pass performs the physical move on its
   next cycle through the one code path that already knows how to do it crash-safely. Every input
   the decision needs is already on disk — `messages.from_address`, `messages.subject`,
   `message_bodies.headers` — so there is nothing to fetch. `sensitive-rescreen.no-imap.test.ts`
   fails if an IMAP client is constructed anywhere on this path.

   ── AND THE REHEARSAL IS THIS SAME CODE, NOT A SECOND ONE ──────────────────────────────────

   The operator command has a `plan` that reports what an `apply` would decide. It is
   {@link SensitiveRescreenDeps.dryRun}: the pass runs for real and every PAGE is rolled back.
   No plan query re-states the decision in SQL, because a re-statement can disagree with the
   apply — and the number the operator is authorising hundreds of moves on is precisely the one
   that must not. Read that flag's docblock before changing the transaction shape; rolling back
   one transaction around the whole mailbox instead of one per page is a production incident and
   the reasons are written out there.

   ── WHERE IT RUNS, AND WHY NOT ON THE WORKER'S ATTACH ──────────────────────────────────────

   It is an OPERATOR one-shot (`sensitive-rescreen-cli.ts`), not a scheduled pass. The kickstart
   shape would have put it on `attach()`, and it cannot go there: the worker's dependency test
   forbids any file under `apps/worker/src` from importing `@trafficflow/services` (services
   is an API-host concern and is NOT installed in the worker's image, so an accidental import
   passes every test through the vitest alias and then fails only in production). A pass that
   lives in this package therefore cannot be reached from an attach, and moving the pass into
   `packages/core` to get around the guard would put a one-time historical correction in the
   library both engines share for ever. One-time work, run once, by a human with the production
   URL — the same reasoning that keeps `invite-cli.ts` out of the API.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/** The Ohbox: where the bypass put this mail. */
const OHBOX: Destination = "INBOX";
/** The gate: where consent says it belongs. */
const SCREENER: Destination = "ohmail/Screener";

/**
 * Messages re-evaluated per transaction.
 *
 * The same 100 as `KICKSTART_BATCH` and for the same reason: {@link recordChange} takes the
 * account's `account_sync_state` row lock for the length of its transaction, so a
 * whole-backlog transaction would stall every API write for that account while a
 * several-hundred-row Ohbox
 * drained. 100 rows is a few milliseconds of lock, and the pass is resumable between batches by
 * construction.
 */
export const SENSITIVE_RESCREEN_BATCH = 100;

/**
 * Pages the pass will walk before giving up and saying so — a bound of 50 000 rows at the
 * batch above.
 *
 * A bound and not a `while (true)`. Termination here is the CURSOR and not an empty page (see
 * {@link runSensitiveRescreen}), so a paging bug would otherwise be an unbounded loop against
 * a live database rather than one warning line.
 */
export const SENSITIVE_RESCREEN_MAX_PAGES = 500;


export interface SensitiveRescreenDeps {
  db: Db;
  mailboxId: string;
  log?: Logger;
  now?: () => Date;
  /** Test seam. Default {@link SENSITIVE_RESCREEN_BATCH}. */
  batch?: number;
  /** Test seam. Default {@link SENSITIVE_RESCREEN_MAX_PAGES}. */
  maxPages?: number;
  /**
   * Re-run a mailbox whose marker is already stamped — evidence, not a repair.
   *
   * The pass is idempotent WITHOUT the marker (a message it moved is no longer a candidate), and
   * this flag exists so that claim can be exercised rather than asserted: the `pg.test.ts` runs a
   * completed mailbox again with `force` and requires zero MOVES — no `folder_state` intent, no
   * `move` change, no per-message audit row. Not zero writes: a completed run records its own
   * completion row in `audit_log` like any other, and that is not what the claim is about.
   * It is deliberately not a "re-screen everything" switch — the candidate query is unchanged by
   * it, so a forced run moves mail only where the mailbox has genuinely CHANGED (a user rule
   * deleted, an intent restored) and the current candidate query says so.
   */
  force?: boolean;
  /**
   * The authserv-ids THIS MAILBOX's own provider signs `Authentication-Results` with —
   * see `pipeline.ts#PlanDeps` for why this is resolved from the provider and never a
   * `mailboxes` column. Production callers pass
   * `adapters/drizzle-repo.ts#mailboxProviderAuthservIds`; the pass resolves it once, for its
   * one mailbox, before the first page.
   *
   * REQUIRED — this was `trustedAuthservIds?: ReadonlySet<string>` defaulting to the empty set,
   * the shape that left the demote-only branch inert at every production site: empty means
   * `"unavailable"` for every candidate and only the sender's claim decides. A non-empty set
   * still moves a candidate only in this pass's OWN direction — Ohbox → Screener — because a
   * `"fail"` verdict makes `evaluateRules` answer `source: "screener"`, which is the one answer
   * this pass acts on. It can never keep a row the pass would otherwise have screened. A caller
   * that has decided to trust nothing types `async () => NO_TRUSTED_AUTHSERV_IDS`.
   */
  trustedAuthservIdsFor: (db: Tx, mailboxId: string) => Promise<ReadonlySet<string>>;
  /**
   * REHEARSE THE PASS AND ROLL EVERY PAGE BACK — what `plan` is.
   *
   * ── WHY THE REHEARSAL LIVES HERE AND NOT IN A PLAN QUERY ───────────────────────────────
   *
   * The obvious `plan` is a SELECT that counts what the pass *would* decide. It is the wrong
   * shape, and this flag exists to refuse it: a plan whose numbers come from a SECOND
   * implementation of the decision is a plan that can DISAGREE with the apply, and an operator
   * authorising a move over hundreds of messages in somebody's real mailbox is relying on
   * exactly that agreement. So the plan runs the REAL pass — the same candidate query, the same
   * {@link evaluateRules} call, the same writes — and throws the writes away.
   *
   * ── WHY PER PAGE AND NOT ONE TRANSACTION ROUND THE WHOLE MAILBOX ────────────────────────
   *
   * Wrapping the whole pass in one outer transaction and rolling THAT back is the tempting
   * version, and it is a production incident. {@link SENSITIVE_RESCREEN_BATCH} is 100 precisely
   * because {@link recordChange} holds the account's `account_sync_state` row lock until its
   * transaction COMMITS — a few milliseconds per page. Under an outer transaction the
   * per-page `tx.transaction(...)` calls degrade to SAVEPOINTs (measured against the real driver:
   * drizzle's `PostgresJsTransaction.transaction()` calls `client.savepoint()`, and the emitted
   * SQL is `savepoint "s0"`, `savepoint "s1"`, … never a nested `begin`), and **releasing a
   * savepoint releases no row locks**. The account's seq lock would then be held from page 1 to
   * the end of the plan, which (a) stalls every API write for that account, (b) blocks the
   * worker's reconciler on `recordChange` until its 30 s `lock_timeout` fires — and that error
   * counts toward `maxSyncFailures` quarantine, so a "read-only" plan could push a live mailbox
   * toward being quarantined — and (c) inverts the lock order an earlier 40P01 deadlock fix
   * established (seq lock after folder locks, never before),
   * because the plan would hold the seq lock while taking
   * fresh `folder_state` locks on later pages. Measured on :5433 with two sessions in a real
   * lock cycle: under the driver's 30 s `lock_timeout` the side Postgres kills is the WORKER
   * (40P01), not the plan.
   *
   * Rolling back per PAGE has none of that. Every page is still its own top-level transaction
   * with exactly the lock profile of an apply, and a plan differs from an apply in one
   * statement: COMMIT, or the sentinel that makes it ROLLBACK. Nothing is lost by not spanning
   * pages — `afterId` and the totals are JS state, and the cursor is monotone in `messages.id`
   * rather than in candidacy, so a rolled-back row is behind the cursor and is never re-read.
   *
   * The COMPLETION TRANSACTION still runs for a plan, and must: it holds the mailbox row and
   * asks the one question that decides whether an apply would stamp — has a candidate become
   * eligible again behind the walk. A plan that skipped it would report a clean finish for a walk
   * the apply refuses, which is the one disagreement a rehearsal may not have. What a plan skips
   * inside that transaction is every DURABLE statement: the check's own cleanup, the completion
   * audit row and the marker. Skipped rather than rolled back — see {@link runSensitiveRescreen}
   * for why not reaching the marker at all is the only shape with no sentinel to get wrong.
   */
  dryRun?: boolean;
}

export interface SensitiveRescreenResult {
  /** False ⇒ the marker was already set and nothing was read, examined or written. */
  ran: boolean;
  /** Candidate rows examined. */
  examined: number;
  /** Rows whose desired folder became `ohmail/Screener`. */
  rescreened: number;
  /** Rows re-evaluation left in the Ohbox — a known sender, a user rule, a header answer. */
  kept: number;
  /** The marker is NOT written. {@link SensitiveRescreenResult.stoppedBecause} says why. */
  truncated: boolean;
  /**
   * WHY the marker was withheld — `null` when it was not.
   *
   * `truncated` alone used to mean one thing and now means three, and an operator acts on the
   * difference. `"page_cap"` is the old meaning: the walk ran out of pages, and its position is
   * stored — EXCEPT in the two modes that deliberately store none, a plan (every page is rolled
   * back) and a `--force` run over an already-stamped mailbox (a finished mailbox may not carry
   * a position). {@link SensitiveRescreenResult.resumedFrom} is where this run began; where the
   * NEXT one begins is that, or the beginning, and the CLI says which. `"disturbed"` is the new
   * one: the
   * walk reached the end but a candidate had become eligible again behind it, so the position
   * was DISCARDED and the next run starts from the beginning. `"mailbox_gone"` is the third:
   * the mailbox was deleted while the walk was running, so there was nothing left to stamp and
   * nothing to resume. Telling an operator "resuming" in either of the last two would be a false
   * statement about where their next run begins.
   */
  stoppedBecause: "page_cap" | "disturbed" | "mailbox_gone" | null;
  /**
   * The durable continuation this run STARTED from, or null for a run that started at the
   * beginning — so `examined` is never read as "the whole mailbox" when it is "the rest of it".
   *
   * A resumed run's counts describe the remainder and nothing else. The operator authorising a
   * plan's numbers has to be able to see that, because a plan that resumed at 50 000 and reports
   * `examined: 12` is telling the truth about twelve remaining candidates and would be a lie
   * about a mailbox.
   */
  resumedFrom: string | null;
  /**
   * Destination → how many movers went there, READ BACK from the `move` changes this run wrote.
   *
   * NOT derived from the {@link SCREENER} constant. The operator's question is "where does this
   * mail end up", and the honest answer is the one on the rows — under {@link
   * SensitiveRescreenDeps.dryRun} it is read inside the page transaction, before the rollback
   * discards it. A destination here that is not `ohmail/Screener`, or a total that disagrees
   * with `rescreened`, is a real finding rather than a formatting problem, which is why the CLI
   * cross-checks the sum instead of assuming it.
   */
  destinations: Record<string, number>;
}

const EMPTY: SensitiveRescreenResult = {
  ran: false, examined: 0, rescreened: 0, kept: 0, truncated: false, destinations: {},
  resumedFrom: null, stoppedBecause: null,
};

/** One page's outcome — whether the page committed, or was rolled back under a dry run. */
interface PageResult {
  rows: RescreenRow[];
  moved: number;
  stayed: number;
  destinations: Record<string, number>;
  /**
   * The last `messages.id` this page examined, or null for an empty page — this page's LOCAL
   * endpoint, carried out so the loop continues from the row the page actually reached rather
   * than from a second number computed elsewhere.
   *
   * NOT necessarily what the database now holds, and the difference is deliberate: the stored
   * position only ever moves FORWARD (see the guarded UPDATE), so when another operator has
   * already stored a higher one this page's UPDATE matches no row and the database keeps theirs.
   * This run then keeps walking from its own endpoint, which re-reads rows the other run has
   * already covered — wasteful, never wrong, and strictly better than rewinding the mailbox.
   */
  lastId: string | null;
}

/**
 * The only way out of a dry-run page transaction — the result is CARRIED, not logged.
 *
 * Thrown as the LAST statement of the page callback, after the destination read-back, because
 * postgres-js turns a callback throw into `ROLLBACK` and rethrows the original error unchanged.
 * Anything that `return`s instead is a page that COMMITS, so the sentinel is deliberately the
 * single exit from a dry-run page rather than one branch of two.
 */
class DryRunRollback extends Error {
  constructor(readonly page: PageResult) {
    super("sensitive-rescreen: dry-run page rolled back");
    this.name = "DryRunRollback";
  }
}

/** One candidate, carrying everything `evaluateRules` reads — all of it from disk. */
interface RescreenRow {
  messageId: string;
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
}

/**
 * The one-time re-evaluation pass for ONE mailbox.
 *
 * ── IDEMPOTENCY, AND WHY THE MARKER IS WRITTEN LAST ────────────────────────────────────────
 *
 * `mailboxes.sensitive_rescreen_at` (mail 0030): NULL ⇒ run, set ⇒ skip. It is stamped AFTER the
 * work, because claiming it first makes a crash permanent — a mailbox marked corrected with half
 * its misrouted mail still in the Ohbox and nothing that would ever look again. Marking last
 * means a crash re-runs the pass, and re-running is safe because the candidate query is itself the
 * idempotency: a message this pass has moved is desired into `ohmail/Screener` and no longer
 * matches. {@link SensitiveRescreenDeps.force} exists so that is proven and not merely claimed.
 *
 * ── TERMINATION IS THE CURSOR, NOT AN EMPTY PAGE ───────────────────────────────────────────
 *
 * Some candidates STAY — a known sender's OTP is supposed to remain in the Ohbox — so a "loop
 * until nothing comes back" pass would read the same rows for ever. `afterId` is monotone in
 * `messages.id`, so each page is strictly past the last. Same construction as the kickstart,
 * for the same reason.
 */
export async function runSensitiveRescreen(
  deps: SensitiveRescreenDeps,
): Promise<SensitiveRescreenResult> {
  const tx = deps.db as unknown as Tx;
  const log = deps.log ?? silentLogger;
  const now = deps.now ?? (() => new Date());
  const batch = deps.batch ?? SENSITIVE_RESCREEN_BATCH;
  const maxPages = deps.maxPages ?? SENSITIVE_RESCREEN_MAX_PAGES;
  // ONE mailbox per run, so the per-mailbox trust resolves once, here, before the first page —
  // off the mailbox's own credential row in production (`mailboxProviderAuthservIds`).
  const trustedAuthservIds = await deps.trustedAuthservIdsFor(tx, deps.mailboxId);

  const [mailbox] = await tx.select({
    id: mailboxes.id, accountId: mailboxes.accountId, address: mailboxes.address,
    sensitiveRescreenAt: mailboxes.sensitiveRescreenAt,
    sensitiveRescreenCursor: mailboxes.sensitiveRescreenCursor,
    sensitiveRescreenStartedAt: mailboxes.sensitiveRescreenStartedAt,
  }).from(mailboxes).where(eq(mailboxes.id, deps.mailboxId)).limit(1);
  // A MAILBOX THAT IS NOT THERE IS NOT A MAILBOX THAT IS DONE. `EMPTY` carries
  // `ran: false, stoppedBecause: null`, which the operator command renders as "SKIPPED — the
  // marker is stamped", so a mailbox deleted between the target selection and this read reported
  // itself as already corrected. The two are opposite facts and only one of them is true.
  if (!mailbox) {
    return { ...EMPTY, ran: true, truncated: true, stoppedBecause: "mailbox_gone" };
  }
  if (mailbox.sensitiveRescreenAt && !deps.force) return EMPTY;

  const accountId = mailbox.accountId;

  // ── RULES AND CONTACTS ARE READ ONCE, AND THAT IS A SNAPSHOT, NOT AN IMPOSSIBILITY ────────
  //
  // This used to say the change "cannot happen" because the pass is the only writer of the state
  // it decides against. That is false and the correction is worth keeping: the USER writes this
  // state too, from the running product — adding a contact, writing or deleting a rule — and
  // nothing stops them doing it while an operator pass is walking their mailbox. So a sender
  // added to `contacts` after this line is still unknown to every remaining page, and a message
  // the CURRENT router would keep can be moved to the Screener and the mailbox stamped complete.
  //
  // Read once anyway, deliberately: the alternative is two pages of ONE run deciding under
  // different knowledge, which is a worse property than the staleness it avoids — one run, one
  // ruleset, one answer per message. The exposure is one operator pass long, the direction is
  // the Screener (one click returns the whole sender), and the audit row this pass writes for
  // every mover carries the inverse. The residual is stated here rather than denied.
  const repo = makeDrizzleRepo(tx as unknown as Parameters<typeof makeDrizzleRepo>[0]);
  const rules: Rule[] = await repo.listRules(accountId);
  const known: ReadonlySet<string> = await repo.knownSenders(accountId);

  // Every address this ACCOUNT sends from. Used by the "the user replied" predicate below; read
  // here rather than in SQL so the candidate query stays one indexable statement.
  const ownRows = await tx.select({ address: mailboxes.address }).from(mailboxes)
    .where(eq(mailboxes.accountId, accountId));
  const ownAddresses = ownRows.map((r) => r.address.toLowerCase());

  let examined = 0;
  let rescreened = 0;
  let kept = 0;
  const destinations: Record<string, number> = {};
  let truncated = true;
  // WHERE THE LAST RUN GOT TO — read from disk, not from zero. NULL means "start at the
  // beginning", which is what every mailbox that has never been paged holds. A plan reads the
  // same value for the same reason: an apply would start here, so a rehearsal that started
  // anywhere else would be rehearsing a different pass.
  const resumedFrom = mailbox.sensitiveRescreenCursor ?? null;
  // THE INSTANT THE WALK BEGAN — the reference for the completion check below. Read from the
  // injected clock, and compared against `folder_state.updated_at`, which this application
  // writes (`upsertFolderState`, `upsertScreenerIntent`) rather than the database defaulting:
  // one clock, both sides.
  const startedAt = now();
  // THE WINDOW THE COMPLETION CHECK LOOKS BACK OVER: the WALK's start, not this run's. A walk
  // that has stored nothing yet has none, and this run's own start is then the honest floor —
  // it is when this walk began.
  const walkStartedAt = mailbox.sensitiveRescreenStartedAt ?? startedAt;
  // ── THE TWO SIDES OF THE COMPARISON ARE STAMPED BY DIFFERENT PROCESSES ───────────────────
  //
  // `folder_state.updated_at` is written by whoever touched the row — `upsertFolderState` uses
  // that process's `new Date()` — and this epoch by this one. A worker whose clock lags this
  // host would stamp a restoration with an instant just before the epoch and the check would
  // not see it. Recorded as a residual rather than papered over with a safety margin, because
  // the margin was tried and is WORSE: widening the floor by minutes makes every candidate
  // whose folder_state was written shortly before the walk look disturbed, and a pass that
  // refuses its own marker on an ordinary mailbox never finishes at all. The exposure is one
  // clock-skew interval at the boundary of one operator run; the fix, if it is ever wanted, is
  // a database-generated stamp on both sides rather than a fudge on this one.
  let afterId: string | undefined = resumedFrom ?? undefined;

  for (let page = 0; page < maxPages; page++) {
    // ONE PAGE, ONE TOP-LEVEL TRANSACTION — for a plan exactly as for an apply. The two differ
    // in the last statement of this callback and nowhere else: an apply falls off the end and
    // COMMITs, a plan throws {@link DryRunRollback} and ROLLBACKs. Keeping the transaction here
    // rather than around the whole loop is what keeps the per-account seq lock down to milliseconds; see
    // {@link SensitiveRescreenDeps.dryRun} for the incident the outer-transaction version causes.
    let result: PageResult;
    try {
      result = await tx.transaction(async (t) => {
        // ── THE MAILBOX ROW IS LOCKED FIRST, AND THE ORDER IS THE WHOLE REASON ─────────────
        //
        // This page writes `mailboxes` (the resume point at the end) and `folder_state` (the
        // intents), and the hosted worker's fenced write group writes BOTH TOO, in the opposite
        // order: `makeSyncWriteFence` (`apps/worker/src/mailboxes.ts`) opens every group with
        // `select mailboxes … for update` and only then touches `folder_state` through the repo
        // it hands the callback. A page that took `folder_state` first and reached for
        // `mailboxes` last would close the cycle — worker holds M and waits for F, page holds F
        // and waits for M — and Postgres would abort one of them with 40P01. Nothing would be
        // silently skipped (a page abort takes its moves and its resume point together), but a
        // live worker could kill the operator pass on every page and the mailbox would never
        // finish. Found by review, not in production, which is the only reason it is written
        // here as an invariant rather than in an incident note.
        //
        // So: M, then F, then the per-account seq lock inside `recordChange` — the worker's own
        // order, extended by the lock this pass already took. Held for the page, which is the
        // same few milliseconds the seq lock is held for and is bounded by the same
        // {@link SENSITIVE_RESCREEN_BATCH} for the same reason.
        //
        // ── AND THE ONE WRITER THIS ORDER CROSSES, STATED RATHER THAN DISCOVERED ───────────
        //
        // Account erasure goes the other way: `account-deletion-service.ts` deletes the
        // account's `folder_state` rows and only later its `mailboxes` rows, in one
        // transaction — F then M. Two writers with opposite orders means a pass touching both
        // tables must cross ONE of them, and this is the choice, made deliberately: the
        // worker's fenced group runs on every live mailbox on every cycle over the very rows
        // this pass writes, so a cycle with IT is routine; erasure runs once, at the end of an
        // account's life, and reaching it needs an operator running this one-shot on an account
        // being deleted in the same seconds. If that does happen Postgres aborts one side with
        // 40P01 and BOTH are retriable — a page abort takes its moves and its resume point
        // together, so nothing half-done reaches disk, and the erasure retries. Recorded here
        // so the next reader does not "fix" the order back and re-open the routine collision.
        await t.select({ id: mailboxes.id }).from(mailboxes)
          .where(eq(mailboxes.id, mailbox.id)).for("update");

        // The account's high-water seq BEFORE this page writes anything. `allocateSeq` is
        // monotone per account, so everything this page records is strictly above it —
        // which is what lets the read-back below name only rows THIS page wrote.
        const watermark = await lastSeqFor(t, accountId);
        const rows = await selectCandidates(t, {
          mailboxId: mailbox.id, ownAddresses, limit: batch, afterId,
        });
        let moved = 0;
        let stayed = 0;
        const movedIds: string[] = [];
        for (const row of rows) {
        // ── THE PROVIDER'S REPORT, FROM DISK ───────────────────────────────────────────────
        //
        // This was an `auth: "unauthenticated"` literal justified as "this row carries no raw
        // bytes to verify". True of an OFFLINE DKIM check, which needs the signed bytes; false
        // of this one — `authVerdictFromHeaders` reads `Authentication-Results` and nothing
        // else, and {@link RescreenRow} already carries `message_bodies.headers` for the rules
        // layer. The evidence was on the row and was being thrown away one line above its use.
        //
        // Read `rules.ts#AuthVerdict` before changing this. GATING THE KNOWN-SENDER MATCH ON A
        // POSITIVE VERDICT MAKES EVERY ROW ANSWER `screener` and this pass would then screen out
        // the known-sender codes it exists to LEAVE in the Ohbox. That is not what this line
        // does: `evaluateRules` reads `"fail"` and nothing else, so an absent trusted set (the
        // default) and an unauthenticated-but-not-failing message both take the branch the
        // literal took. Only a provider's explicit failure for the claimed author changes an
        // answer, and only towards the Screener.
        const decision = evaluateRules({
          msg: asRuleInput(row), rules, knownSenders: known,
          auth: authVerdictFromHeaders(row.headers, row.fromAddress, trustedAuthservIds),
          // LENIENT, and it must stay so: this pass acts ONLY on `source === "screener"` (the
          // known-sender-with-a-fail demotion it exists for). A `people_only` demotion answers
          // `source: "policy"` → Reads/Receipts, which this pass would ignore anyway — but passing
          // the lenient posture keeps that explicit and this pass byte-identical to before the
          // policy field existed. The automated-mail axis is a separate backlog pass, not this one.
          ohboxPolicy: DEFAULT_OHBOX_POLICY,
        });
        // ONLY the gate's own answer moves mail. `rule` is the user's decision and outranks us;
        // `header` and `unclear` are answers about a sender already PAST the gate, and neither is
        // evidence that this message was misrouted — the defect being corrected is a stranger in
        // the Ohbox, not a placement refinement. Blast radius: exactly the rows the bypass
        // created.
        if (decision.source !== "screener") { stayed++; continue; }

        await upsertScreenerIntent(t, row);
        await recordChange(t, {
          accountId, entityType: "message", entityId: row.messageId, op: "move",
          meta: { from: OHBOX, to: SCREENER },
        });
        // The inverse is the undo the account's own audit trail owes them: this pass moves
        // hundreds of messages they did not ask it to touch, and "put it back" has to be
        // expressible.
        await t.insert(auditLog).values({
          accountId, action: "sensitive_rescreen_move",
          payload: {
            mailboxId: mailbox.id, messageId: row.messageId,
            from: OHBOX, to: SCREENER, source: decision.source,
          },
          inverse: { messageId: row.messageId, from: SCREENER, to: OHBOX },
        });
        movedIds.push(row.messageId);
        moved++;
        }
        // WHERE THE MOVERS ACTUALLY GO — read out of the rows just written, and read HERE
        // because under a dry run this is the last moment they exist. Unconditional rather than
        // gated on `dryRun`: a plan and an apply must issue the identical statement sequence, or
        // the rehearsal is not a rehearsal of the thing being rehearsed.
        const dests = await moveDestinations(t, accountId, movedIds, watermark);

        // ── THE RESUME POINT COMMITS WITH THE PAGE THAT EARNED IT ───────────────────────────
        //
        // In THIS transaction, so there is no instant at which the database holds one and not
        // the other. A kill between the page and its position is then not a state that exists:
        // either both are on disk, or neither is, and the next run resumes at exactly the row
        // after the last one it actually examined — not approximately, and not from the top.
        //
        // The predicate is what makes two concurrent operators safe. Both runs walk the same
        // rows (`FOR UPDATE` already serializes them, and the loser re-reads a committed row
        // that no longer matches and drops it), but the one that is BEHIND must not drag the
        // stored position backwards — that would re-read a prefix for ever without ever
        // losing a row, which is the defect this column exists to end, reintroduced by two
        // processes instead of one. `uuid` compares by bytes in Postgres, the same order the
        // candidate walk's `order by messages.id asc` uses, so `<` here is the walk's own
        // order and not a second one.
        //
        // Under a dry run this UPDATE is inside the rolled-back transaction like everything
        // else, so a plan advances only `afterId` in memory and leaves the stored position
        // exactly as it found it.
        const lastId = rows.length > 0 ? rows[rows.length - 1]!.messageId : null;
        if (lastId !== null) {
          await t.update(mailboxes)
            .set({
              sensitiveRescreenCursor: lastId,
              // `coalesce`, so the FIRST page of a walk sets the epoch and every resumption of
              // the same walk keeps it. `startedAt` and not `now()`: the check compares against
              // `folder_state.updated_at`, and a restoration landing between this run's first
              // read and this page's commit belongs INSIDE the window, not outside it.
              sensitiveRescreenStartedAt: sql`coalesce(
                ${mailboxes.sensitiveRescreenStartedAt}, ${startedAt.toISOString()}::timestamptz)`,
            })
            .where(and(
              eq(mailboxes.id, mailbox.id),
              // A FINISHED MAILBOX STORES NO POSITION. Without this, a stale run outlived by a
              // faster one writes its own lower position onto a mailbox the other has already
              // stamped and cleared — and a mailbox that is `at`-stamped WITH a cursor is the one
              // state that makes a later `force` re-run start at that cursor and read nothing,
              // turning its "zero writes" from evidence that the candidate query is
              // self-idempotent into a statement about where the cursor happened to be. The
              // consequence, stated: a `force` run that TRUNCATES stores nothing and restarts at
              // the top next time. That is right for what `force` is — evidence, not a repair
              // (see {@link SensitiveRescreenDeps.force}).
              sql`${mailboxes.sensitiveRescreenAt} is null`,
              sql`(${mailboxes.sensitiveRescreenCursor} is null
                    or ${mailboxes.sensitiveRescreenCursor} < ${lastId}::uuid)`,
            ));
        }

        const outcome: PageResult = { rows, moved, stayed, destinations: dests, lastId };
        // THE LAST STATEMENT, AND THE ONLY EXIT. Falling off the end COMMITs the page.
        if (deps.dryRun) throw new DryRunRollback(outcome);
        return outcome;
      });
    } catch (err) {
      // A dry-run page always leaves through here; anything else is a real failure, and the
      // narrow `instanceof` is what keeps this from swallowing one.
      if (!(err instanceof DryRunRollback)) throw err;
      result = err.page;
    }

    examined += result.rows.length;
    rescreened += result.moved;
    kept += result.stayed;
    for (const [to, n] of Object.entries(result.destinations)) {
      destinations[to] = (destinations[to] ?? 0) + n;
    }
    if (result.rows.length === 0) { truncated = false; break; }
    // The SAME id the page's transaction stored, carried out rather than recomputed: one number
    // decides where the next page starts and where a restart resumes, so there is nowhere for
    // the two to disagree.
    afterId = result.lastId ?? afterId;
  }

  if (truncated) {
    log.warn("sensitive_rescreen_truncated", {
      mailboxId: mailbox.id, accountId, examined, rescreened, kept, maxPages,
      dryRun: deps.dryRun === true,
      resumedFrom, resumesAt: deps.dryRun ? resumedFrom : afterId ?? null,
      reason: "the Ohbox backlog exceeded one pass — the marker is NOT written and " +
        "`sensitive_rescreen_cursor` holds the last committed page, so the next run resumes " +
        "there. A dry run stores nothing and the next run resumes where this one started.",
    });
    return {
      ran: true, examined, rescreened, kept, truncated: true, destinations, resumedFrom,
      stoppedBecause: "page_cap",
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  THE STAMP IS EARNED, NOT REACHED — and this is what the resume point costs
  // ══════════════════════════════════════════════════════════════════════════════════════════
  //
  // Reaching an empty page means the walk is past every candidate IN THE ORDER IT WALKED. It does
  // NOT mean every candidate was examined, because a row BEHIND the cursor can become a candidate
  // again while the walk is ahead of it — and the marker would then certify a mailbox as
  // corrected over mail nothing ever looked at, permanently.
  //
  // The concrete sequence, found by review of this very change: the worker's reconciler reads a
  // pending `folder_state` row whose desired folder is still the Ohbox, starts its IMAP move, and
  // completes with `upsertFolderState(desiredFolder: p.desiredFolder)` — the value it read BEFORE
  // the move (`apps/worker/src/junk-filing.ts#completeFiling`). If this pass moved that row in
  // between, the completion writes the Ohbox back over the Screener intent and the row is a
  // candidate again, now behind the cursor. Before the resume point existed a TRUNCATED run
  // happened to re-read it; a run that completed always hid it exactly as this one would. So the
  // hole is older than the cursor and the cursor removes its one accidental recovery — which is
  // why the recovery is made deliberate here rather than left to luck.
  //
  // The detector is `folder_state.updated_at`: every writer of that table stamps it, so a
  // candidate carrying a stamp from after the WALK began is a row that became eligible under it.
  // This pass's OWN movers cannot false-positive — a row it moved is desired into the Screener
  // and is no longer a candidate at all.
  //
  // THE WALK's start (`mailboxes.sensitive_rescreen_started_at`) and not this RUN's, because the
  // cursor outlives an invocation: run A stores a prefix and exits, the worker restores one of
  // A's rows, run B resumes past it. Measured against B's own start that restoration is in the
  // past and B stamps over it; measured against the walk's it is inside the window.
  //
  // On refusal the resume point is CLEARED, not kept. Keeping it would make the next run resume
  // past the very row that refused the stamp, find nothing, refuse again on the same evidence,
  // and never terminate. Cleared, the next run re-walks the prefix, examines the restored row and
  // stamps — and if the clobber repeats, the pass keeps declining to finish, which is the honest
  // report of a mailbox that genuinely has not converged.
  //
  // WHAT THIS DOES NOT SEE, stated rather than left to be rediscovered: an exclusion REMOVED
  // mid-run — the user deletes their own rule, or returns a triage state to `none` — makes a row
  // behind the cursor eligible without touching `folder_state`, so no stamp is refused and that
  // row is skipped. It is the known limit `rules.retro_cursor` records for the same construction
  // (mail 0034), it needs the user to withdraw an intent during an operator pass, and the
  // supported remedy is to NULL ALL THREE of `sensitive_rescreen_at`,
  // `sensitive_rescreen_cursor` and `sensitive_rescreen_started_at` — the marker because it is
  // what stops the pass looking at the mailbox at all, and the two walk columns because a walk
  // that is meant to start over may not inherit a position or a window from the one before it.
  //
  // ── THE CHECK AND THE STAMP ARE ONE TRANSACTION, UNDER THE MAILBOX LOCK ──────────────────
  //
  // Separated, they are a race with the very writer they exist to catch: the detector returns
  // empty, the worker's fenced group then takes `mailboxes`, restores a row behind the cursor and
  // commits, and the marker lands over it. `select mailboxes … for update` FIRST — the page
  // order, and the worker's own — excludes that group for the length of the check, so what the
  // check saw is still true when the stamp is written. `for update` and not a plain read: a
  // shared lock would let the worker's fence in.
  const stamped = await tx.transaction(async (t) => {
    // …AND THE LOCKED READ'S RESULT IS USED, NOT DISCARDED. The mailbox can be GONE by now: an
    // account erasure deletes `folder_state` and then `mailboxes` in one transaction, so a pass
    // that started before it can arrive here with nothing to stamp. Writing the completion audit
    // row and the marker into that hole would insert rows into tables the erasure has just swept
    // and report a mailbox corrected that no longer exists.
    const [still] = await t.select({ id: mailboxes.id }).from(mailboxes)
      .where(eq(mailboxes.id, mailbox.id)).for("update");
    if (!still) return "gone";

    const disturbed = await selectCandidates(t, {
      mailboxId: mailbox.id, ownAddresses, limit: 1, touchedSince: walkStartedAt, lock: false,
    });
    if (disturbed.length > 0) {
      // A PLAN REPORTS IT AND CLEARS NOTHING. Discarding a stored position is a durable act and
      // a rehearsal may not perform one; the apply it is rehearsing will.
      if (!deps.dryRun) {
        await t.update(mailboxes)
          .set({ sensitiveRescreenCursor: null, sensitiveRescreenStartedAt: null })
          .where(eq(mailboxes.id, mailbox.id));
      }
      return disturbed[0]!.messageId;
    }

    // ── A DRY RUN LEAVES HERE, HAVING RUN THE CHECK AND NOTHING AFTER IT ────────────────────
    //
    // The check itself is a READ under the mailbox lock, so a plan may run it — and MUST, or the
    // file's headline contract breaks: with the check skipped, a plan over a mailbox whose walk
    // has already been disturbed reports a clean completion while the apply it is rehearsing
    // returns `disturbed` and throws the position away. The operator would authorise on numbers
    // the apply cannot produce, which is the one failure the plan exists to make impossible.
    //
    // What a plan skips is everything DURABLE below: the completion audit row and the marker.
    // Skipped rather than rolled back, and for the reason the page rollback cannot cover them —
    // `sensitive_rescreen_at` is the flag that stops the pass ever looking at a mailbox again, so
    // a bug in a sentinel path here would leave a mailbox marked corrected that never was.
    // Not reaching the statements at all is the only shape with no such failure mode.
    if (deps.dryRun) return null;

    await t.insert(auditLog).values({
      accountId, action: "sensitive_rescreen",
      payload: { mailboxId: mailbox.id, examined, rescreened, kept },
      inverse: null,
    });
    // ── THE STAMP LANDS AND THE RESUME POINT GOES, IN ONE STATEMENT ────────────────────────
    //
    // `coalesce(sensitive_rescreen_at, $now)` rather than the `WHERE … IS NULL` this used to
    // carry, and the difference is the cursor. The predicate kept the DATABASE's answer for the
    // stamp — two operators finishing at once produce exactly one instant, the first one's,
    // which `coalesce` preserves — but it made the whole statement a no-op for the loser, and
    // the loser would then have left `sensitive_rescreen_cursor` set on a mailbox that is
    // finished. A stale resume point on a completed mailbox is the one state that quietly
    // breaks the `force` re-run: it would start at the END, read nothing, and report the zero
    // writes that are supposed to be EVIDENCE that the candidate query is self-idempotent.
    // The evidence would have become a tautology, and nothing would have failed.
    await t.update(mailboxes)
      .set({
        // `::timestamptz` on the bound parameter, because it is compared against a column
        // through `coalesce` and postgres-js binds a JS `Date` only where the statement says
        // what it is; an ISO string plus the cast is what both drivers agree on.
        sensitiveRescreenAt: sql`coalesce(${mailboxes.sensitiveRescreenAt}, ${now().toISOString()}::timestamptz)`,
        // BOTH walk columns go. They are one fact — "a walk is in progress, and this is where and
        // when it started" — so a completed mailbox holding either of them is a state nothing
        // should be able to read.
        sensitiveRescreenCursor: null,
        sensitiveRescreenStartedAt: null,
      })
      // A NO-OP ONCE BOTH ARE SETTLED. `coalesce` alone would still take the row lock and write a
      // new tuple on every completed `force` run and on every loser of a two-operator finish,
      // which the `WHERE … IS NULL` this replaced did not. The predicate keeps the statement
      // idempotent while still letting it do EITHER job: stamp an unstamped mailbox, or clear a
      // resume point left on one that is already stamped.
      .where(and(
        eq(mailboxes.id, mailbox.id),
        sql`(${mailboxes.sensitiveRescreenAt} is null
              or ${mailboxes.sensitiveRescreenCursor} is not null
              or ${mailboxes.sensitiveRescreenStartedAt} is not null)`,
      ));
    return null;
  });

  // "gone" IS ANSWERED BEFORE THE PLAN BRANCH, not through it. A mailbox deleted under a plan is
  // not a disturbed walk — there is no walk left to disturb — and mapping it to `disturbed` would
  // tell the operator their next run starts from the beginning of a mailbox that no longer exists.
  if (stamped === "gone") {
    log.warn("sensitive_rescreen_mailbox_gone", {
      mailboxId: mailbox.id, accountId, examined, rescreened, kept, resumedFrom,
      dryRun: deps.dryRun === true,
      reason: "the mailbox was deleted while the pass was walking it — nothing was stamped",
    });
    return {
      ran: true, examined, rescreened, kept, truncated: true, destinations, resumedFrom,
      stoppedBecause: "mailbox_gone",
    };
  }

  if (deps.dryRun) {
    log.info("sensitive_rescreen_plan_complete", {
      mailboxId: mailbox.id, accountId, examined, rescreened, kept, destinations, resumedFrom,
      disturbed: stamped !== null,
      note: "every page was rolled back; the marker was not written and not attempted, and the " +
        "stored resume point is exactly where this plan found it",
    });
    return stamped !== null
      ? {
        ran: true, examined, rescreened, kept, truncated: true, destinations, resumedFrom,
        stoppedBecause: "disturbed" as const,
      }
      : {
        ran: true, examined, rescreened, kept, truncated: false, destinations, resumedFrom,
        stoppedBecause: null,
      };
  }

  if (stamped !== null) {
    log.warn("sensitive_rescreen_disturbed", {
      mailboxId: mailbox.id, accountId, examined, rescreened, kept, resumedFrom,
      messageId: stamped, walkStartedAt: walkStartedAt.toISOString(),
      reason: "a candidate became eligible again while the walk was past it, so the marker is " +
        "NOT written and the resume point is cleared — the next run re-walks from the start",
    });
    return {
      ran: true, examined, rescreened, kept, truncated: true, destinations, resumedFrom,
      stoppedBecause: "disturbed",
    };
  }

  log.info("sensitive_rescreen_complete", {
    mailboxId: mailbox.id, accountId, examined, rescreened, kept, destinations, resumedFrom,
  });
  return {
    ran: true, examined, rescreened, kept, truncated: false, destinations, resumedFrom,
    stoppedBecause: null,
  };
}

/**
 * The account's highest allocated `change_log.seq`, or 0 when the log is empty.
 *
 * `::text` and then `BigInt(...)`, rather than reading the column through drizzle's bigint
 * mapper: this is a raw aggregate, so the value arrives as whatever the DRIVER makes of `int8`,
 * and postgres-js and PGlite do not agree about that. A text cast makes both hand back the same
 * thing.
 */
async function lastSeqFor(t: Tx, accountId: string): Promise<bigint> {
  const [r] = await t.select({ max: sql<string>`coalesce(max(${changeLog.seq}), 0)::text` })
    .from(changeLog).where(eq(changeLog.accountId, accountId));
  return BigInt(r?.max ?? "0");
}

/**
 * Where the rows THIS page moved were actually sent, grouped by destination.
 *
 * Scoped two ways, and both are load-bearing. `seq > watermark` excludes any EARLIER `move` for
 * the same message — a user's own move, a previous slice's — which would otherwise be counted as
 * this pass's work. `entity_id in (movedIds)` excludes anything another session commits for this
 * account mid-page: under READ COMMITTED a concurrent commit becomes visible to this statement,
 * and without the id list a busy account would inflate the plan's numbers with writes the pass
 * never made. Together they leave exactly the rows this page wrote.
 *
 * `coalesce(… ->> 'to', …)` and not a bare `->>`: a `move` change whose `meta` lost its
 * destination is a defect worth SEEING in the operator's output, and grouping on NULL would drop
 * it from the totals instead — leaving the CLI's sum check reporting a shortfall with nothing to
 * attribute it to.
 */
async function moveDestinations(
  t: Tx, accountId: string, movedIds: readonly string[], watermark: bigint,
): Promise<Record<string, number>> {
  if (movedIds.length === 0) return {};
  const key = sql<string>`coalesce(${changeLog.meta} ->> 'to', '(move change carries no destination)')`;
  const rows = await t.select({ to: key, n: sql<number>`count(*)::int` })
    .from(changeLog)
    .where(and(
      eq(changeLog.accountId, accountId),
      eq(changeLog.op, "move"),
      inArray(changeLog.entityId, movedIds as string[]),
      sql`${changeLog.seq} > ${watermark.toString()}::bigint`,
    ))
    .groupBy(key);

  const out: Record<string, number> = {};
  for (const r of rows) out[r.to] = (out[r.to] ?? 0) + r.n;
  return out;
}

/**
 * ONE page of the Ohbox this pass may reconsider — LOCKED FOR UPDATE, oldest id first.
 *
 * ── THE CANDIDATE SET ──────────────────────────────────────────────────────────────────────
 *
 *  · `folder_state.desired_folder = 'INBOX'` — it is in the Ohbox. This is also the whole of the
 *    idempotency: a row this pass has already moved is desired into `ohmail/Screener` and drops
 *    out here, which is why a second run writes nothing whether or not the marker is set.
 *  · `messages.sensitivity_category IS NOT NULL` — the sensitivity verdict is the thing that
 *    overrode the gate, so a NULL category means this message reached the Ohbox on its own merits
 *    and was never touched by the defect. It bounds the pass to the damage.
 *
 * ── AND THE FIVE THINGS THAT TAKE A MESSAGE BACK OUT OF IT ─────────────────────────────────
 *
 * The rule, stated once: **a message the user has expressed an intent about is not ours to
 * move.** Two of the predicates are copied from `listScreenerBacklog` because they are the same
 * rule in the other direction; three are this pass's own, because it is the first pass that can
 * take mail AWAY from a user rather than hand it to them.
 *
 *  1. `folder_state.last_set_by = 'us'` — a row set `external` is a placement the USER performed
 *     in their own mail client, and the folder reconciler already refuses to revert those.
 *  2. no enabled `rules` row for the sender or its domain — `POST /screener/:id` writes one per
 *     decide, so a sender carrying one has been ruled on and is not ours to re-route. (Note the
 *     asymmetry with the re-evaluation above: a rule ALSO wins inside `evaluateRules`, so this
 *     predicate is redundant for correctness and kept for cost — it keeps the ruled-on senders
 *     out of the page entirely.)
 *  3. no `message_states` row in a state other than `none` — reply-later, set-aside, bubbled-up
 *     and muted are the four ways the product lets someone TRIAGE a message, and yanking one out
 *     of a pile they built is the failure this predicate exists to prevent.
 *  4. no `drafts` row whose `in_reply_to_message_id` is this message — they are replying, or have
 *     replied, through ohmail.
 *  5. no message in the same THREAD sent from one of the account's own addresses — they replied
 *     from their own mail client, where no draft of ours is written. This is the only one of the
 *     three named user actions ("kept, replied to, triaged") that the tables above cannot see, and
 *     it is cheap: `messages_account_thread_idx` is `(account_id, thread_id)`.
 *
 * ── READ IS DELIBERATELY NOT ON THAT LIST ──────────────────────────────────────────────────
 *
 * A meaningful share of the candidates are read, and some carry a `flag_state` row this account
 * wrote. Neither
 * excludes them, and that is a decision rather than an oversight: **reading is not consent.** The
 * defect report that commissioned this pass is precisely an Ohbox full of *read* spam ("much
 * spam and ones
 * that should have been screened out"), so treating a read as an intent to keep would leave
 * behind precisely the mail this pass was commissioned to move. Nothing is deleted either way —
 * the message goes to the Screener, one click returns the whole sender, and the stored body is
 * already redacted because it was classified sensitive.
 *
 * ── AND THE LOCK ───────────────────────────────────────────────────────────────────────────
 *
 * `FOR UPDATE OF folder_state`, `of` the one table and not the whole join: `message_bodies` is on
 * the NULLABLE side of a LEFT JOIN, which Postgres refuses to lock, and locking `messages` would
 * serialize the pass against ordinary ingest for no benefit. Two concurrent runs both block on the
 * same row; the loser re-reads the committed row and — IF THE WINNER MOVED IT — finds it no longer
 * desired into `INBOX` and drops it, so a message is moved once and `change_log` gains one `move`
 * and not two.
 *
 * A KEPT row is the other half and the claim does not extend to it: the winner wrote nothing, so
 * the row still matches and the loser examines it again. That costs a second evaluation of a
 * message neither run will move, and it is why the count a concurrent pair reports can exceed the
 * candidate set while the MOVES cannot.
 *
 * ── AND WHAT THIS LOCK IS STILL FOR, NOW THAT THE PAGE TAKES THE MAILBOX ROW FIRST ─────────
 *
 * Two RUNS of this pass no longer reach here at the same time: each page opens by taking the
 * mailbox row `FOR UPDATE`, so a second run is serialized a statement earlier and the
 * `sensitive-rescreen.pg.test.ts` concurrency case would now pass with this `FOR UPDATE`
 * removed. It is not decoration, and the reason is that the mailbox lock is THIS pass's alone:
 * every other writer of `folder_state` — the API's move, the Screener's apply, `rule-retro`,
 * `ohbox-tidy`, `screener-auto`, the worker's reconciler — takes no mailbox row on the way in.
 * The row lock here is what makes a page's read-decide-write atomic against THEM, which is the
 * case that matters in production and the one no test in this file can express with two copies
 * of the same pass. That
 * claim is `sensitive-rescreen.pg.test.ts` on real Postgres, because PGlite is single-connection
 * and `FOR UPDATE` there is a no-op that always succeeds.
 */
async function selectCandidates(
  t: Tx,
  opts: {
    mailboxId: string; ownAddresses: readonly string[]; limit: number; afterId?: string;
    /**
     * Only candidates whose `folder_state` row was written at or after this instant — the
     * completion check's predicate, and nothing else uses it. See the block above the check in
     * {@link runSensitiveRescreen} for what it detects and what it deliberately cannot.
     */
    touchedSince?: Date;
    /**
     * `false` for the completion check, which is a detection READ and takes no row lock.
     *
     * The walk's `FOR UPDATE` is load-bearing — it is what makes two passes move a message once
     * — and stays the default. The check must NOT take it. It runs INSIDE the marker
     * transaction, which already holds the mailbox row: locking `folder_state` rows there would
     * hold them until the stamp commits, for a query that only needs to know whether one such
     * row exists, and it would block the very reconciler whose write the check is looking for.
     */
    lock?: boolean;
  },
): Promise<RescreenRow[]> {
  const filters = [
    eq(messages.mailboxId, opts.mailboxId),
    eq(folderState.desiredFolder, OHBOX),
    eq(folderState.lastSetBy, "us"),
    sql`${messages.sensitivityCategory} is not null`,
    // 2 — the user has ruled on this sender.
    sql`not exists (
      select 1 from ${rulesTbl} r
       where r.account_id = ${messages.accountId}
         and r.enabled = true
         and (
           (r.kind = 'sender' and lower(r.match) = lower(${messages.fromAddress}))
           or (r.kind = 'domain' and lower(r.match) = split_part(lower(${messages.fromAddress}), '@', 2))
         )
    )`,
    // 3 — the user has triaged this message.
    sql`not exists (
      select 1 from ${messageStates} ms
       where ms.message_id = ${messages.id} and ms.state <> 'none'
    )`,
    // 4 — the user is replying, or has replied, through ohmail.
    sql`not exists (
      select 1 from ${drafts} d where d.in_reply_to_message_id = ${messages.id}
    )`,
    // 4b — the user decided on an AI proposal about this message. `status <> 'pending'` and not
    // mere existence: a pending approval is something WE proposed and they have not answered, so
    // treating it as their intent would let the AI layer immunise mail from the consent gate —
    // the same shape of defect this whole slice is correcting.
    sql`not exists (
      select 1 from ${approvals} a
       where a.message_id = ${messages.id} and a.status <> 'pending'
    )`,
  ];
  // 5 — the user replied from their own mail client. Guarded on a non-empty address list because
  // `in ()` is a syntax error, and skipped for a NULL `thread_id` because an unthreaded message
  // has no conversation to search. (`thread_id` is NULL only until the thread backfill reaches a
  // row; every production candidate observed was threaded.)
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
  if (opts.touchedSince) {
    filters.push(sql`${folderState.updatedAt} >= ${opts.touchedSince.toISOString()}::timestamptz`);
  }

  const q = t.select({
    messageId: messages.id,
    fromAddress: messages.fromAddress,
    subject: messages.subject,
    observedFolder: folderState.observedFolder,
    headers: messageBodies.headers,
    // Rides the join `headers` already pays for — see `RescreenRow.bodyText` (mail 0052).
    bodyText: messageBodies.text,
  }).from(folderState)
    .innerJoin(messages, eq(messages.id, folderState.messageId))
    .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
    .where(and(...filters))
    .orderBy(asc(messages.id))
    .limit(opts.limit)
    .$dynamic();
  const rows = await (opts.lock === false ? q : q.for("update", { of: folderState }));

  return rows.map((r) => ({
    messageId: r.messageId,
    fromAddress: r.fromAddress,
    subject: r.subject,
    bodyText: r.bodyText ?? "",
    headers: (r.headers as Record<string, string[]> | null) ?? {},
    observedFolder: r.observedFolder,
  }));
}

/**
 * Write the INTENT and nothing else: desired `ohmail/Screener`, observed untouched.
 *
 * `reconcile_status` is derived here rather than passed in, exactly as `upsertFolderState` derives
 * it, so a row can never claim a convergence it does not have: desired ≠ observed ⇒ `pending`, and
 * `pending` is what makes the worker's reconciler pick it up. `conflict` is reset for the same
 * reason the folder reconciler resets it — this is a fresh statement of where the message belongs.
 */
async function upsertScreenerIntent(t: Tx, row: RescreenRow): Promise<void> {
  const reconcileStatus = SCREENER === row.observedFolder ? "reconciled" : "pending";
  await t.insert(folderState).values({
    messageId: row.messageId, desiredFolder: SCREENER, observedFolder: row.observedFolder,
    lastSetBy: "us", reconcileStatus, conflict: false,
  }).onConflictDoUpdate({
    target: folderState.messageId,
    set: {
      desiredFolder: SCREENER, observedFolder: row.observedFolder, lastSetBy: "us",
      reconcileStatus, conflict: false, updatedAt: new Date(),
    },
  });
}

/**
 * The persisted row in the shape `evaluateRules` reads — and NOTHING else is invented.
 *
 * The rules layer looks at exactly four things: the sender, the subject, the headers and — since
 * `body_contains` (mail 0052) — the plain text, and all four are already on disk. So this pass
 * opens no IMAP connection and re-parses no MIME: `textBody` is `message_bodies.text` read back,
 * `""` where no body row exists (a body rule then declines to fire — fail-closed). `htmlBody`
 * stays empty because no rule reads it; if one ever does, this function is where that becomes a
 * visible lie rather than a silent one. Deliberately identical in shape to the sibling passes'
 * `asRuleInput` (`rule-retro.ts`, `ohbox-tidy.ts`), so the passes cannot come to disagree about
 * what a stored message looks like to the router.
 */
function asRuleInput(row: RescreenRow): NormalizedMessage {
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
