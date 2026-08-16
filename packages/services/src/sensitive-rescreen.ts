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
   * completed mailbox again with `force` and requires zero writes. It is deliberately not a
   * "re-screen everything" switch — the candidate query is unchanged by it.
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
   * The marker transaction is SKIPPED rather than rolled back — see {@link runSensitiveRescreen}.
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
  /** The pass hit {@link SENSITIVE_RESCREEN_MAX_PAGES}; the marker is NOT written. */
  truncated: boolean;
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
};

/** One page's outcome — whether the page committed, or was rolled back under a dry run. */
interface PageResult {
  rows: RescreenRow[];
  moved: number;
  stayed: number;
  destinations: Record<string, number>;
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
  }).from(mailboxes).where(eq(mailboxes.id, deps.mailboxId)).limit(1);
  if (!mailbox) return EMPTY;
  if (mailbox.sensitiveRescreenAt && !deps.force) return EMPTY;

  const accountId = mailbox.accountId;

  // Rules and contacts are read ONCE. The pass is the only writer of the state it decides
  // against, so re-reading them per page would cost two queries per hundred rows to observe a
  // change that cannot happen — and would make two pages of one run decide under different
  // knowledge, which is a worse property than the staleness it would be avoiding.
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
  let afterId: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    // ONE PAGE, ONE TOP-LEVEL TRANSACTION — for a plan exactly as for an apply. The two differ
    // in the last statement of this callback and nowhere else: an apply falls off the end and
    // COMMITs, a plan throws {@link DryRunRollback} and ROLLBACKs. Keeping the transaction here
    // rather than around the whole loop is what keeps the per-account seq lock down to milliseconds; see
    // {@link SensitiveRescreenDeps.dryRun} for the incident the outer-transaction version causes.
    let result: PageResult;
    try {
      result = await tx.transaction(async (t) => {
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
        const outcome: PageResult = { rows, moved, stayed, destinations: dests };
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
    afterId = result.rows[result.rows.length - 1]!.messageId;
  }

  if (truncated) {
    log.warn("sensitive_rescreen_truncated", {
      mailboxId: mailbox.id, accountId, examined, rescreened, kept, maxPages,
      dryRun: deps.dryRun === true,
      reason: "the Ohbox backlog exceeded one pass — the marker is NOT written, so the next run " +
        "resumes it",
    });
    return { ran: true, examined, rescreened, kept, truncated: true, destinations };
  }

  // A DRY RUN SKIPS THE MARKER RATHER THAN ROLLING IT BACK.
  //
  // Everything above is discarded by a ROLLBACK the DATABASE performs; this block would be
  // discarded by a sentinel THIS FILE has to remember to throw. Those are not the same
  // assurance. `sensitive_rescreen_at` is the flag that stops the pass ever looking at a mailbox
  // again, so a bug in the sentinel path here would leave a mailbox marked corrected that never
  // was — permanent, silent, and precisely what marking-last exists to prevent. Not reaching the
  // statement at all is the only shape with no such failure mode.
  if (deps.dryRun) {
    log.info("sensitive_rescreen_plan_complete", {
      mailboxId: mailbox.id, accountId, examined, rescreened, kept, destinations,
      note: "every page was rolled back; the marker was not written and not attempted",
    });
    return { ran: true, examined, rescreened, kept, truncated: false, destinations };
  }

  await tx.transaction(async (t) => {
    await t.insert(auditLog).values({
      accountId, action: "sensitive_rescreen",
      payload: { mailboxId: mailbox.id, examined, rescreened, kept },
      inverse: null,
    });
    // `WHERE sensitive_rescreen_at IS NULL`, so the answer is the DATABASE's and not a
    // read-then-write this process performed: two operators running the pass at once produce
    // exactly one stamp. Same construction, same reason, as `markKickstarted`.
    await t.update(mailboxes).set({ sensitiveRescreenAt: now() })
      .where(and(eq(mailboxes.id, mailbox.id), sql`${mailboxes.sensitiveRescreenAt} is null`));
  });

  log.info("sensitive_rescreen_complete", {
    mailboxId: mailbox.id, accountId, examined, rescreened, kept, destinations,
  });
  return { ran: true, examined, rescreened, kept, truncated: false, destinations };
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
 * same row; the loser re-reads the committed row, finds it no longer desired into `INBOX`, and
 * drops it — so a message is moved once, and `change_log` gains one `move` and not two. That
 * claim is `sensitive-rescreen.pg.test.ts` on real Postgres, because PGlite is single-connection
 * and `FOR UPDATE` there is a no-op that always succeeds.
 */
async function selectCandidates(
  t: Tx,
  opts: { mailboxId: string; ownAddresses: readonly string[]; limit: number; afterId?: string },
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

  const rows = await t.select({
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
    .for("update", { of: folderState });

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
