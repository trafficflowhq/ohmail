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

/**
 * RE-ROUTING MAIL THE CONSENT BYPASS ALREADY MISROUTED (mail 0030). The pipeline used to let the
 * sensitivity verdict OVERRIDE the consent gate — `Subject: your verification code` was a
 * one-message defeat of the Screener. The forward fix subordinated sensitivity to consent; this
 * is the other half, for mail already filed. IT RE-EVALUATES, NEVER INVERTS: every candidate goes
 * back through the real `evaluateRules`, and only a `source: "screener"` answer moves — a known
 * sender's login code stays. IT NEVER OPENS IMAP: it writes intents; the reconciler moves the
 * mail (`sensitive-rescreen.no-imap.test.ts` guards). THE REHEARSAL IS THIS SAME CODE: `plan` is
 * `dryRun` — the real pass, every PAGE rolled back. An OPERATOR one-shot, not a worker attach.
 */

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
   * Re-run a mailbox whose marker is already stamped — evidence, not a repair. The pass is
   * idempotent WITHOUT the marker (a message it moved is no longer a candidate), and this flag
   * lets that claim be exercised: the pg test runs a completed mailbox again with `force` and
   * requires zero MOVES — no `folder_state` intent, no `move` change, no per-message audit row.
   * Not zero writes: a completed run records its completion row in `audit_log`. Deliberately not
   * a "re-screen everything" switch — the candidate query is unchanged, so a forced run moves
   * mail only where the mailbox has genuinely CHANGED.
   */
  force?: boolean;
  /**
   * The authserv-ids THIS MAILBOX's own provider signs `Authentication-Results` with — resolved
   * from the provider, never a `mailboxes` column (`pipeline.ts#PlanDeps`); production passes
   * `mailboxProviderAuthservIds`, resolved once before the first page. REQUIRED — this defaulted
   * to the empty set, which left the demote-only branch inert at every production site: empty
   * means `"unavailable"` for every candidate. A non-empty set still moves a candidate only in
   * this pass's OWN direction — a `"fail"` verdict makes `evaluateRules` answer `source:
   * "screener"`, the one answer this pass acts on; it can never keep a row the pass would
   * otherwise screen. A caller that trusts nothing types `async () => NO_TRUSTED_AUTHSERV_IDS`.
   */
  trustedAuthservIdsFor: (db: Tx, mailboxId: string) => Promise<ReadonlySet<string>>;
  /**
   * REHEARSE THE PASS AND ROLL EVERY PAGE BACK — what `plan` is. Not a plan query: numbers from a
   * SECOND implementation can DISAGREE with the apply. PER PAGE, NOT ONE OUTER TRANSACTION:
   * inside an outer transaction the per-page transactions degrade to SAVEPOINTs (measured:
   * drizzle emits `savepoint`, never a nested `begin`), and releasing a savepoint releases NO row
   * locks — the seq lock is held to the end, stalling API writes, pushing the worker into its 30
   * s `lock_timeout`, and inverting the seq-after-folder lock order. Per page, every page keeps
   * an apply's exact lock profile; a plan differs in one statement. The COMPLETION TRANSACTION
   * still runs for a plan; it skips every DURABLE statement.
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
   * WHY the marker was withheld — `null` when it was not. `truncated` alone used to mean one
   * thing and now means three, and an operator acts on the difference. `"page_cap"`: the walk ran
   * out of pages and its position is stored — EXCEPT in the two modes that store none, a plan
   * (pages rolled back) and a `--force` run over a stamped mailbox. `"disturbed"`: the walk
   * reached the end but a candidate became eligible again behind it, so the position was
   * DISCARDED and the next run starts from the beginning. `"mailbox_gone"`: the mailbox was
   * deleted mid-walk — nothing to stamp, nothing to resume. Telling an operator "resuming" in the
   * last two would be a false statement about where their next run begins.
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
   * endpoint, carried out so the loop continues from the row the page actually reached. NOT
   * necessarily what the database now holds, deliberately: the stored position only moves FORWARD
   * (the guarded UPDATE), so when another operator has stored a higher one this page's UPDATE
   * matches no row and the database keeps theirs. This run keeps walking from its own endpoint,
   * re-reading rows the other run covered — wasteful, never wrong, and strictly better than
   * rewinding the mailbox.
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
 * The one-time re-evaluation pass for ONE mailbox. THE MARKER IS WRITTEN LAST:
 * `mailboxes.sensitive_rescreen_at` (mail 0030) — NULL ⇒ run, set ⇒ skip. Claiming it first makes
 * a crash permanent: a mailbox marked corrected with half its misrouted mail still in the Ohbox.
 * Marking last means a crash re-runs the pass, and re-running is safe because the candidate query
 * is itself the idempotency — a moved message is desired into `ohmail/Screener` and no longer
 * matches (`force` proves it). TERMINATION IS THE CURSOR, NOT AN EMPTY PAGE: some candidates
 * STAY, so a "loop until nothing comes back" pass would read the same rows for ever; `afterId` is
 * monotone in `messages.id`.
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

  // RULES AND CONTACTS ARE READ ONCE, AND THAT IS A SNAPSHOT, NOT AN IMPOSSIBILITY. The USER
  // writes this state too, from the running product — adding a contact, writing or deleting a
  // rule — while an operator pass walks their mailbox; a sender added to `contacts` after this
  // line is still unknown to every remaining page. Read once anyway, deliberately: the
  // alternative is two pages of ONE run deciding under different knowledge — one run, one
  // ruleset, one answer per message. The exposure is one operator pass long, the direction is the
  // Screener (one click returns the whole sender), and the audit row carries the inverse. The
  // residual is stated rather than denied.
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
  // THE TWO SIDES OF THE COMPARISON ARE STAMPED BY DIFFERENT PROCESSES. `folder_state.updated_at`
  // is written by whoever touched the row with that process's `new Date()`; this epoch by this
  // one. A worker whose clock lags this host would stamp a restoration just before the epoch and
  // the check would not see it. Recorded as a residual rather than papered over with a safety
  // margin, because the margin is WORSE: widening the floor by minutes makes every candidate
  // written shortly before the walk look disturbed, and a pass that refuses its own marker on an
  // ordinary mailbox never finishes. The exposure is one clock-skew interval at the boundary of
  // one operator run; the fix, if wanted, is a database-generated stamp on both sides.
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
        // THE MAILBOX ROW IS LOCKED FIRST, AND THE ORDER IS THE WHOLE REASON. This page writes
        // `mailboxes` (the resume point) and `folder_state` (intents); the worker's fenced write
        // group writes both in the SAME order — `select mailboxes … for update`, then
        // `folder_state`. F-first would close the cycle (worker holds M waits F, page holds F
        // waits M — 40P01): a live worker could kill the operator pass on every page. So: M, then
        // F, then the seq lock inside `recordChange`. THE ONE WRITER THIS ORDER CROSSES: account
        // erasure deletes F then M. Crossing one of the two is unavoidable; the routine writer
        // (the worker, every cycle) wins over the once-per-account one. If they do collide,
        // Postgres aborts one side and BOTH are retriable — a page abort takes its moves and
        // resume point together.
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
        // THE PROVIDER'S REPORT, FROM DISK. This was an `auth: "unauthenticated"` literal
        // justified as "this row carries no raw bytes to verify" — true of an OFFLINE DKIM check,
        // false of this one: `authVerdictFromHeaders` reads `Authentication-Results` and nothing
        // else, and `RescreenRow` already carries `message_bodies.headers`. The evidence was on
        // the row and being thrown away one line above its use. Read `rules.ts#AuthVerdict`
        // before changing this: gating the known-sender match on a POSITIVE verdict makes every
        // row answer `screener`, screening out the known-sender codes this pass exists to LEAVE.
        // `evaluateRules` reads `"fail"` and nothing else — only a provider's explicit failure
        // for the claimed author changes an answer, and only towards the Screener.
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

        // THE RESUME POINT COMMITS WITH THE PAGE THAT EARNED IT — in THIS transaction, so there
        // is no instant at which the database holds one and not the other: either both are on
        // disk or neither, and the next run resumes at exactly the row after the last one
        // examined. The predicate is what makes two concurrent operators safe: both walk the same
        // rows (`FOR UPDATE` serializes; the loser re-reads a committed row that no longer
        // matches and drops it), but the one BEHIND must not drag the stored position backwards —
        // that would re-read a prefix for ever. `uuid` compares by bytes in Postgres, the same
        // order as `order by messages.id asc`, so `<` here is the walk's own order. Under a dry
        // run this UPDATE rolls back with everything else: a plan advances only `afterId` in
        // memory.
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

  // THE STAMP IS EARNED, NOT REACHED. An empty page means the walk is past every candidate IN THE
  // ORDER IT WALKED, not that every candidate was examined: a row BEHIND the cursor can become a
  // candidate again, and the marker would certify the mailbox as corrected over mail nothing
  // looked at — permanently. The original writer (the reconciler restoring a pre-move value) IS
  // FIXED, and the check stays: five other `folder_state` writers take no mailbox row. The
  // detector is `folder_state.updated_at` against THE WALK's start — the cursor outlives an
  // invocation. On refusal the resume point is CLEARED: kept, the next run would never terminate.
  // NOT SEEN: an exclusion removed mid-run (the `rules.retro_cursor` limit); the remedy is to
  // NULL the marker, cursor and started-at. CHECK AND STAMP ARE ONE TRANSACTION UNDER THE MAILBOX
  // LOCK; the residual window is not worth SERIALIZABLE on an operator one-shot.
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

    // A DRY RUN LEAVES HERE, HAVING RUN THE CHECK AND NOTHING AFTER IT. The check is a READ under
    // the mailbox lock, so a plan may run it — and MUST, or the headline contract breaks: with it
    // skipped, a plan over a disturbed walk reports a clean completion while the apply returns
    // `disturbed` and throws the position away — the operator authorises on numbers the apply
    // cannot produce. What a plan skips is everything DURABLE below: the completion audit row and
    // the marker. Skipped rather than rolled back — `sensitive_rescreen_at` is the flag that
    // stops the pass ever looking again, so a bug in a sentinel path would leave a mailbox marked
    // corrected that never was. Not reaching the statements at all is the only shape with no such
    // failure mode.
    if (deps.dryRun) return null;

    await t.insert(auditLog).values({
      accountId, action: "sensitive_rescreen",
      payload: { mailboxId: mailbox.id, examined, rescreened, kept },
      inverse: null,
    });
    // THE STAMP LANDS AND THE RESUME POINT GOES, IN ONE STATEMENT.
    // `coalesce(sensitive_rescreen_at, $now)` rather than the old `WHERE … IS NULL`: the
    // predicate kept the database's answer for the stamp (two operators finishing at once produce
    // the first one's instant, which `coalesce` preserves) but made the whole statement a no-op
    // for the loser — leaving `sensitive_rescreen_cursor` set on a finished mailbox. A stale
    // resume point on a completed mailbox quietly breaks the `force` re-run: it starts at the
    // END, reads nothing, and reports the zero writes that are supposed to be EVIDENCE of
    // self-idempotency. The evidence would have become a tautology, and nothing would have
    // failed.
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
 * Where the rows THIS page moved were actually sent, grouped by destination. Scoped two ways,
 * both load-bearing: `seq > watermark` excludes any EARLIER `move` for the same message;
 * `entity_id in (movedIds)` excludes anything another session commits mid-page — under READ
 * COMMITTED a concurrent commit becomes visible, and without the id list a busy account inflates
 * the plan's numbers. Together they leave exactly the rows this page wrote. `coalesce(… ->> 'to',
 * …)`, not a bare `->>`: a `move` change whose `meta` lost its destination is a defect worth
 * SEEING — grouping on NULL would drop it and leave the CLI's sum check reporting a shortfall
 * with nothing to attribute it to.
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
 * CANDIDATES: `desired_folder = 'INBOX'` (also the whole idempotency — a moved row drops out) AND
 * `sensitivity_category IS NOT NULL`. EXCLUSIONS — a message the user expressed an intent about
 * is not ours to move: `last_set_by = 'us'` only; no enabled UN-NARROWED sender/domain rule (a
 * NARROWED rule's mail still reaches `evaluateRules`, the ONE matcher; `screener-auto.ts` keeps
 * the broad predicate — it never calls the evaluator); no non-`none` triage row; no reply draft;
 * no own-address reply in the thread. READ IS NOT AN EXCLUSION: reading is not consent. THE LOCK
 * is for the writers that take no mailbox row; a KEPT row is re-examined by the loser.
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
    // 2 — the user has ruled on this sender. UN-NARROWED RULES ONLY: see the numbered list above
    // and `rules.subject_contains`' own contract — a rule carrying a term is a statement about a
    // SUBSET of that sender's mail, so it has not ruled on the rest of it.
    sql`not exists (
      select 1 from ${rulesTbl} r
       where r.account_id = ${messages.accountId}
         and r.enabled = true
         and r.subject_contains is null
         and r.body_contains is null
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
 * The persisted row in the shape `evaluateRules` reads — and NOTHING else is invented. The rules
 * layer looks at exactly four things: sender, subject, headers and — since `body_contains` (mail
 * 0052) — the plain text, all four on disk. So this pass opens no IMAP and re-parses no MIME:
 * `textBody` is `message_bodies.text` read back, `""` where no body row exists (a body rule then
 * declines to fire — fail-closed). `htmlBody` stays empty because no rule reads it; if one ever
 * does, this function is where that becomes a visible lie rather than a silent one. Deliberately
 * identical in shape to the sibling passes' `asRuleInput` (`rule-retro.ts`, `ohbox-tidy.ts`), so
 * the passes cannot disagree about what a stored message looks like to the router.
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
