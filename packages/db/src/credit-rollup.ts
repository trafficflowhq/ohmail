import { sql } from "drizzle-orm";
import { findCreditDivergence } from "./credits.js";
import type { Tx } from "./change-log.js";

/**
 * THE CREDIT ROLL-UP — day-grained aggregates so the console can read the money without
 * scanning it, and the retention sweep for the setup pool's draw record.
 *
 * ## What this pass is for, and the one thing it is NOT for
 *
 * The admin Billing board ran three UNCAPPED aggregates over `credit_ledger` on every read, and
 * the account page rendered the newest fifty raw rows. Both are correct and both stop being
 * affordable: the ledger is append-only, never pruned, and grows with every metered action —
 * order 1.6 M rows a month at the volumes this deployment is sized for. So the READS move to
 * aggregates.
 *
 * **The money trail itself is not shortened, and nothing in this file may ever shorten it.**
 * That is not caution, it is four separate mechanisms:
 *
 *  · `credit_ledger_append_only` (cloud 0002) is a STATEMENT-level trigger on UPDATE, DELETE and
 *    TRUNCATE. It raises. A prune here does not degrade — it aborts the transaction it is in,
 *    which on this pass means the whole roll-up fails, loudly, for ever.
 *  · the DEFERRED coupling triggers make the newest ledger row's `balance_after` and
 *    `credit_balances.balance` one fact, checked at COMMIT. Removing the newest rows of an
 *    account makes the two tables permanently unable to agree.
 *  · `debitCredits` reads the `UNIQUE (account_id, source)` row BEFORE it tests sufficiency, so a
 *    deleted debit turns a replayed charge from a reported `duplicate` into a second real one.
 *  · `refundCredits` bounds a reversal by reading the ORIGIN debit, and `latestInvoiceGrantSource`
 *    reads back through grants to build the next expiry's dedup identity. Both answer wrongly,
 *    and silently, over a truncated history.
 *
 * The retention sweep in this file therefore targets `setup_grant_spends` — the SETUP pool's own
 * draw record, which is not the money audit and has no coupled balance — and nothing else.
 *
 * ## IDEMPOTENT BY FULL-DAY RECOMPUTATION, NOT BY A WATERMARK
 *
 * This is the design decision the whole pass turns on. The obvious implementation keeps the
 * highest `credit_ledger.id` it has aggregated and starts from there next time. It is cheaper and
 * it is WRONG, because `bigserial` is not commit-ordered:
 *
 *   one transaction begins and takes id 100;
 *   a second begins, takes id 101, and commits;
 *   the pass runs, sees 101, parks its watermark at 101;
 *   the first commits. Row 100 is now visible, below the watermark, and never aggregated.
 *
 * The row is not delayed — it is lost, permanently, and the aggregate under-reports one
 * account's spend for the life of the deployment with nothing failing anywhere. Within ONE
 * account id order IS commit order (every ledger write holds that account's `credit_balances`
 * row lock, which is what makes `ORDER BY id DESC` a truthful per-account statement), but this
 * pass reads ACROSS accounts, where that guarantee does not exist.
 *
 * So the pass recomputes whole days from `created_at`, and recomputation is safe because the
 * source is append-only: running it twice over the same day can only ever find the same rows or
 * more of them, and the second answer is the better one. A day is rewritten, not added to.
 *
 * The recompute is EXACT rather than merely upsert-shaped: after the aggregate is written, rows
 * for that day and pool whose `computed_at` predates this run are deleted. Without that a
 * category that used to have rows and no longer does — every draw of a day refunded, an account
 * whose rows went with it — would keep a stale aggregate for ever, and an upsert cannot see the
 * absence it is supposed to record.
 *
 * ## THE SETUP POOL'S RECOMPUTE HORIZON, AND THE ORDERING THAT USED TO BE MISSING
 *
 * `setup_grant_spends` IS swept (see {@link SETUP_SPEND_RETENTION_DAYS}), so recomputing a day
 * whose rows have been swept would compute a truthful zero over an untruthful population and
 * overwrite a correct historical number with it. The setup half of the DAY LOOP therefore only
 * recomputes days whose START is at or after the retention floor, and it stays exactly as it was.
 *
 * **That guard answers one question and used to be read as answering two, which is how a day
 * could be swept having never been aggregated at all.** It stops a recompute writing over an
 * already-thinned population. It says nothing about whether the day was aggregated in the first
 * place — and it could not, because the two windows never touch: the loop recomputes two or three
 * days back, and the sweep bites at rows at least 30 days old. A day aggregated by no pass and
 * swept by this one was gone in both places at once, the raw rows deleted and no
 * `credit_usage_daily` row ever written, with nothing failing and the console's freshness stamp
 * green. No later pass could repair it: the source it would read is what was deleted.
 *
 * The repair is ORDER, and it is {@link foldAndSweepSetupSpends}, deliberately NOT this loop:
 * a `(day, account_id)` pair is folded into `credit_usage_daily` and only then are that pair's
 * rows deleted. The delete's predicate is the set of pairs folded in the same pass — never a
 * clock — which makes "deleted but never aggregated" unrepresentable rather than merely untested.
 *
 * ## WHY A PAIR AND NOT A DAY, WHICH IS THE WHOLE SUBTLETY
 *
 * Eligibility is a property of a ROW (its own age AND its grant's expiry), so one account can
 * hold two rows on one day whose grants expire months apart. Folding a DAY and deleting whatever
 * was eligible would mark that day aggregated while survivors remained; when the second grant
 * expired the day would re-enter the drain and be "recomputed" over the survivors alone, writing
 * a smaller number over the correct one — the very hazard the paragraph above describes, produced
 * by the fix for it. A pair is therefore folded only when EVERY row of it is eligible, which
 * leaves nothing behind and makes re-entry impossible.
 *
 * ## TWO CADENCES, AND THE PANELS SAY WHICH ONE THEY ARE ON
 *
 * The daily rows are refreshed HOURLY and the lifetime totals NIGHTLY, so an account page can
 * show today's spend while the Billing board's lifetime figure does not include today. That is a
 * real gap of up to a day between two numbers about one account, and it is not hidden: each
 * panel carries its OWN producer's stamp and its OWN cadence, so an operator reads "computed 4m
 * ago · expected hourly" beside one and "computed 6h ago · expected daily" beside the other.
 *
 * The alternative — running the lifetime aggregate hourly — is a whole-table `GROUP BY` over
 * `credit_ledger` twenty-four times a day, which is the cost the whole slice exists to remove.
 * A stated cadence is the honest trade; an unstated one would be the drift this design is against.
 */

/** Hourly cadence: today and yesterday. Yesterday, because a day is only whole once it is over. */
export const CREDIT_ROLLUP_HOURLY_DAYS = 2;

/**
 * Nightly cadence: three days. Wider than the hourly window on purpose — a deployment that was
 * down for an evening, a clock that moved, or a long transaction that committed after its day
 * closed all land inside three days, and re-reading two extra days costs one indexed range scan
 * each.
 */
export const CREDIT_ROLLUP_NIGHTLY_DAYS = 3;

/** The UTC hour the wide nightly pass runs at. Chosen for the trough, not for anything else. */
export const CREDIT_ROLLUP_NIGHTLY_HOUR_UTC = 3;

/**
 * How long a `setup_grant_spends` row survives after its grant has expired.
 *
 * The row's job is idempotency: a crash-retried Screener suggestion must find its own draw and
 * be a free retry rather than a second charge. Once the GRANT it drew from has expired, the pool
 * can fund nothing, so the row can only still matter to a retry of work that is itself months
 * old. The bound is stated rather than implied: a re-suggestion for a message older than the
 * grant's 90-day life plus this window then costs 1 credit through the inner gate instead of
 * being free. That is the whole cost, and it is bounded by the weight of one classification.
 *
 * Note the sweep's predicate needs BOTH the grant's expiry and the row's own age past this
 * horizon, so in practice a swept row is at least 120 days old (a grant lives 90 days from its
 * creation, and its draws cannot predate it). The day loop's recompute horizon is the same 30
 * days, so the loop and the sweep never act on the same day — which is why the sweep has to do
 * its own aggregating first, in {@link foldAndSweepSetupSpends}, rather than relying on the loop
 * to have been there.
 */
export const SETUP_SPEND_RETENTION_DAYS = 30;

/**
 * How many whole days one nightly pass will fold and sweep.
 *
 * The cap is in DAYS and not in pairs, and the difference decides whether a backlog ever drains:
 * at hundreds of accounts a day holds many pairs, so a pair-cap converges in years while a
 * day-cap converges in nights. A 200-day gap — the shape a deployment that predates the roll-up
 * actually has — drains in seven passes.
 *
 * Oldest first, always. Newest-first would sweep the days nearest the horizon and starve the
 * oldest for ever, which is the starvation this repository already paid for once in the
 * attachment-staging sweep.
 */
export const CREDIT_ROLLUP_SWEEP_CAP_DAYS = 30;

/** What one pass did — written to `credit_rollup_runs` and returned to the caller for its log. */
export interface CreditRollupReport {
  /** Whole days recomputed. */
  daysRecomputed: number;
  /** `credit_usage_daily` rows inserted or updated across every day and pool. */
  rowsWritten: number;
  /** `findCreditDivergence`'s count, or `null` when this pass did not measure it. */
  divergentAccounts: number | null;
  /** `setup_grant_spends` rows swept, or `null` when this pass did not sweep. */
  prunedSetupSpends: number | null;
  /**
   * Eligible days this pass did not reach, floored at 0; `null` when it did not sweep.
   *
   * `0` on a sweeping pass means the drain is complete — which is the ordinary state, and on a
   * deployment younger than 120 days it is also the state a completely broken fold would report,
   * because nothing is eligible yet. The pg positive control is what tells those apart.
   */
  setupSweepBacklog: number | null;
  /**
   * Pairs the fold REFUSED because their day already carries a folded aggregate — see
   * {@link foldAndSweepSetupSpends}. Non-zero means a row arrived for a pair that was already
   * closed, which no writer in this codebase can produce; it is counted rather than corrected.
   */
  frozenSetupPairsSkipped: number | null;
  /** Wall-clock milliseconds the pass took, whether it completed or failed. */
  durationMs: number;
  /** class:code, scrubbed. Non-null ⇒ the pass did not complete. */
  error: string | null;
}

export interface CreditRollupOptions {
  /** The pass's clock. The newest day recomputed is this instant's UTC day. */
  now: Date;
  /** How many whole UTC days back to recompute, counting the day of `now` as the first. */
  days: number;
  /**
   * Recompute the LIFETIME `credit_usage_totals`. Nightly.
   *
   * Independent of `days` and unaffected by it: the ledger pool's totals are aggregated from
   * `credit_ledger` whole, so they are complete on the first pass and there is no back-fill to
   * run and none to forget. The setup pool's come from `credit_usage_daily`, which `days` does
   * extend — see the block at the statement.
   */
  totals?: boolean;
  /** Count the accounts whose ledger and balance disagree. A full pass; nightly only. */
  divergence?: boolean;
  /**
   * Fold and sweep `setup_grant_spends` past {@link SETUP_SPEND_RETENTION_DAYS}. Nightly only.
   *
   * It rides this one flag and takes NO option of its own, deliberately: a separate `sweep` or
   * `catchUp` flag defaulting false is how a feature ships dark, working perfectly and reached by
   * nothing. There is one call site (`apps/worker/src/index.ts`) and it passes `nightly` here.
   */
  prune?: boolean;
  /**
   * How many days one sweep may fold. Defaults to {@link CREDIT_ROLLUP_SWEEP_CAP_DAYS}; present
   * so a test can drive the cap without seeding thirty days, and so an operator draining a deep
   * backlog by hand can widen it.
   */
  capDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** class + code, never message text — the rule `billing_events.error` already follows. */
function scrub(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; constructor?: { name?: string } } | null;
  const cls = typeof e?.name === "string" ? e.name : e?.constructor?.name ?? "unknown";
  const code = typeof e?.code === "string" ? e.code : null;
  return code ? `${cls}:${code}` : cls;
}

/** `execute` answers an array on one driver and `{ rows }` on the other. Normalize once. */
function rowsOf<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  const bag = res as { rows?: unknown } | null;
  return Array.isArray(bag?.rows) ? (bag!.rows as T[]) : [];
}

/** Midnight UTC of the day `at` falls in. */
function utcDayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** `2026-09-03` — the `date` literal the aggregate rows are keyed by. */
function dayKey(dayStart: Date): string {
  return dayStart.toISOString().slice(0, 10);
}

/**
 * Is this the pass's wide nightly slot? The worker asks once an hour, so the answer must be true
 * for exactly one of those asks: the hour must match AND the last run must not already have been
 * inside it.
 */
export function isNightlyRollupSlot(now: Date, lastNightlyAt: Date | null): boolean {
  if (now.getUTCHours() !== CREDIT_ROLLUP_NIGHTLY_HOUR_UTC) return false;
  if (lastNightlyAt === null) return true;
  return utcDayStart(lastNightlyAt).getTime() < utcDayStart(now).getTime();
}

/** What one fold-and-sweep did. Folded into {@link CreditRollupReport} by the caller. */
export interface SetupFoldReport {
  /** Whole days this pass folded and swept. */
  daysFolded: number;
  /** `(day, account_id)` pairs aggregated. */
  pairsFolded: number;
  /** `setup_grant_spends` rows removed — always rows of a pair folded in the same pass. */
  rowsSwept: number;
  /** Eligible days this pass did not reach, floored at 0. */
  backlogDays: number;
  /** Eligible pairs refused because their day already carries a folded aggregate. */
  frozenPairsSkipped: number;
}

/**
 * FOLD A `(day, account_id)` PAIR INTO THE AGGREGATE, THEN TAKE ITS ROWS — in that order, and
 * never the other, which is the whole point of this function existing separately.
 *
 * ## WHY THIS IS NOT PART OF THE DAY LOOP
 *
 * The loop refuses to recompute a setup day below the retention floor, and that refusal is
 * correct and stays: below the floor the population has been thinned, so a recompute there writes
 * a truthful zero over a correct historical number. This function is not a recompute. It runs
 * over a population that is still WHOLE — it is what makes the population stop being whole, one
 * statement later — so the floor does not apply to it and the guard is left exactly as written
 * rather than being relaxed for a special case. Two different questions, two different functions.
 *
 * ## THE PAIR IS THE UNIT, AND IT IS FOLDED ONLY WHEN EVERY ROW OF IT IS ELIGIBLE
 *
 * `bool_and(expired AND old)` per `(day, account_id)`. A pair with one eligible row and one
 * survivor is left entirely alone — not half-folded, not half-swept.
 *
 * The alternative, folding a DAY, is wrong in a way that takes a second reading to see. One
 * account can hold two draws on one day against grants that expire months apart. Fold the day,
 * delete what was eligible, and the day is marked aggregated with a survivor still on it; when
 * the second grant expires the day becomes eligible again and is "recomputed" over the survivor
 * alone — a smaller number written over the correct one, permanently, with every guard green.
 * A fully-eligible pair has nothing left behind it, so it can never re-enter.
 *
 * ## THE FROZEN PAIR — a refusal for a state no writer here can produce
 *
 * A pair whose day already carries a setup aggregate stamped more than
 * {@link SETUP_SPEND_RETENTION_DAYS} after that day began can only have been written by THIS
 * function: the day loop never stamps a setup day below the floor. So rows arriving for such a
 * pair mean somebody backdated `created_at`, which no writer in this repository does
 * (`setup-grant.ts` inserts without the column). Rather than fold again — overwriting a closed,
 * correct number with a partial one — the pair is refused, counted and warned about. The count is
 * derived by SUBTRACTION (eligible minus folded), so it is measured by the fold's own effect and
 * cannot report a refusal that did not happen.
 *
 * ## NO TRANSACTION, AND ORDER IS THE MECHANISM
 *
 * The caller hands us a pool, not a transaction, and the statements autocommit. That is
 * deliberate: a death between the fold and the delete leaves rows whose pair the next pass folds
 * again, identically, because the fold is a full recompute over the pair's population and not an
 * increment. The reverse order has no such recovery, which is why the order is the invariant and
 * a transaction is not needed to protect it.
 */
export async function foldAndSweepSetupSpends(
  db: Tx, opts: { now: Date; computedAt: string; capDays?: number },
): Promise<SetupFoldReport> {
  const { now, computedAt } = opts;
  const capDays = Math.max(0, Math.floor(opts.capDays ?? CREDIT_ROLLUP_SWEEP_CAP_DAYS));
  const floor = new Date(now.getTime() - SETUP_SPEND_RETENTION_DAYS * DAY_MS).toISOString();

  // ── EVERY FULLY-ELIGIBLE PAIR, OLDEST DAY FIRST ────────────────────────────────────────
  //
  // `(created_at at time zone 'utc')::date` and never `created_at::date`: the latter truncates in
  // the SESSION's zone, so on a server not set to UTC it would disagree with `dayKey` — and the
  // disagreement would be invisible except within a few hours of midnight, which is the shape
  // that reads as flakiness rather than as a defect.
  const pairs = rowsOf<{ day: string; account_id: string; frozen: boolean }>(await db.execute(sql`
    with elig as (
      select (s.created_at at time zone 'utc')::date as day,
             s.account_id as account_id,
             count(*)::int as raw_rows
        from setup_grant_spends s
        join setup_grants g on g.id = s.grant_id
       group by 1, 2
      having bool_and(g.expires_at < ${floor}::timestamptz
                  and s.created_at < ${floor}::timestamptz)
    )
    select to_char(e.day, 'YYYY-MM-DD') as day,
           e.account_id as account_id,
           coalesce((
             select d.rows > e.raw_rows
               from credit_usage_daily d
              where d.day = e.day and d.pool = 'setup' and d.account_id = e.account_id
                and d.computed_at > e.day + make_interval(days => ${SETUP_SPEND_RETENTION_DAYS})
           ), false) as frozen
      from elig e
     order by 1 asc`));

  // FROZEN PAIRS DO NOT CONSUME THE CAP, and this is the half of the repair that stops the
  // starvation rather than the loss. Thirty frozen days at the oldest end used to fill every slot
  // of an oldest-first drain, so nothing behind them was ever folded again.
  const workablePerDay = new Map<string, number>();
  const frozenPerDay = new Map<string, number>();
  for (const p of pairs) {
    const m = p.frozen === true ? frozenPerDay : workablePerDay;
    m.set(p.day, (m.get(p.day) ?? 0) + 1);
  }
  const workableDays = [...workablePerDay.keys()].sort();      // ascending: oldest first
  const take = workableDays.slice(0, capDays);
  const taken = new Set(take);
  // BACKLOG IS "DAYS STILL WAITING", frozen ones included. The old figure counted only days the
  // cap did not reach, so a pass that swept NOTHING because every eligible pair was frozen
  // reported 0 — a drained console over a drain that had stopped. A day is counted once whether
  // it waits because of the cap, because it is frozen, or both.
  const waiting = new Set<string>([
    ...workableDays.filter((d) => !taken.has(d)),
    ...frozenPerDay.keys(),
  ]);
  const backlogDays = waiting.size;

  let pairsFolded = 0;
  let rowsSwept = 0;
  let frozenPairsSkipped = 0;

  for (const key of take) {
    // The pair set is re-derived inside EVERY statement rather than passed in as a list. Two
    // reasons, and the second is the one that matters: a set-based predicate keeps this to three
    // statements a day whatever the account count, and it means the delete's predicate is
    // literally the fold's — not a copy of it that can drift.
    const eligibleForDay = sql`
      select s.account_id, count(*)::int as raw_rows
        from setup_grant_spends s
        join setup_grants g on g.id = s.grant_id
       where (s.created_at at time zone 'utc')::date = ${key}::date
       group by s.account_id
      having bool_and(g.expires_at < ${floor}::timestamptz
                  and s.created_at < ${floor}::timestamptz)`;

    // ── FROZEN IS A PROPERTY OF THE POPULATION, NOT OF THE STAMP ─────────────────────
    //
    // The first version asked only whether a fold-stamped row existed, and that refused the
    // WRONG case for ever. The aggregate commits, the process dies before the delete, and the
    // next pass reads its own predecessor's stamp as a closed pair — so the rows are stranded
    // permanently, the drain silently stops, and because those days sit at the oldest end of an
    // oldest-first cap they starve every day behind them. It needed no backdated row: a power
    // cut between two autocommitted statements was enough. Forty lines above, this file claimed
    // the opposite — that a death between the fold and the delete is re-folded identically —
    // and the two statements could not both be true.
    //
    // The discriminator is `d.rows > e.raw_rows`: did the stamped aggregate count MORE rows than
    // the pair holds now?
    //
    //  · INTERRUPTED FOLD — nothing was deleted, so the counts are equal and the pair is
    //    re-folded and swept. The recompute is over the same population, so it writes the same
    //    number: idempotent, which is what the header always promised.
    //  · A ROW ARRIVING AFTER A COMPLETED SWEEP — the stamp counted five, one row is present, so
    //    5 > 1 refuses. Folding there would write that single row's amount over a complete
    //    figure, which is the loss the frozen arm exists to prevent.
    //
    // It is compared against the pair's TOTAL row count rather than its non-refunded one on
    // purpose. The stamp counts non-refunded rows, so a refund landing after a fold would make a
    // non-refunded comparison read 5 > 4 and freeze a healthy pair; against the total it reads
    // 5 > 5, the pair re-folds, and the new number correctly excludes the refund.
    //
    // The old `computed_at < ${'$'}{computedAt}` guard is GONE rather than kept beside this: the
    // population test makes the within-pass self-freeze unreachable (statement 1 writes
    // rows == population, so the comparison is false immediately afterwards), and a condition
    // whose contrary state cannot be reached is one a later reader mistakes for a guarantee.
    const notFrozen = sql`
      select e.account_id from (${eligibleForDay}) e
       where not exists (
         select 1 from credit_usage_daily d
          where d.day = ${key}::date and d.pool = 'setup'
            and d.account_id = e.account_id
            and d.computed_at > ${key}::date + make_interval(days => ${SETUP_SPEND_RETENTION_DAYS})
            and d.rows > e.raw_rows
       )`;

    // ── 1. THE FOLD ──────────────────────────────────────────────────────────────────────
    //
    // `filter (where refunded_at is null)` on both aggregates: a refunded draw is an attempt the
    // model faulted on and gave the credit back for, so it is not spend. `coalesce(..., 0)`
    // because a pair whose every draw was refunded still gets a row — the row is what records
    // that the day was folded, and it is what the frozen check reads next time.
    const folded = await db.execute(sql`
      insert into credit_usage_daily
             (day, account_id, pool, reason, credits, rows, computed_at)
      select ${key}::date, s.account_id, 'setup', 'debit_classify',
             coalesce(-sum(s.amount) filter (where s.refunded_at is null), 0)::int,
             (count(*) filter (where s.refunded_at is null))::int,
             ${computedAt}::timestamptz
        from setup_grant_spends s
       where (s.created_at at time zone 'utc')::date = ${key}::date
         and s.account_id in (${notFrozen})
       group by s.account_id
      on conflict (day, account_id, pool, reason) do update
         set credits = excluded.credits,
             rows = excluded.rows,
             computed_at = excluded.computed_at
      returning account_id`);
    const foldedNow = rowsOf(folded).length;
    pairsFolded += foldedNow;
    // CLAMPED AT ZERO, and the clamp is not defensive dressing. The eligible count comes from the
    // survey query and the folded count from a statement that re-derives eligibility, so the two
    // read the table at different instants; if a pair became eligible in between, the difference
    // is NEGATIVE and would silently cancel a real refusal counted on another day — leaving the
    // worker's `> 0` warning dark in exactly the case it exists for. Nothing here can produce that
    // interleaving today (eligibility needs a row 30 days old, and `expires_at` is never updated
    // after a grant is minted), which is precisely why it must not be left to arithmetic nobody
    // re-checks when one of those two facts changes.
    frozenPairsSkipped += Math.max(0, (workablePerDay.get(key) ?? 0) - foldedNow);

    // ── 2. THE ABSENCE HALF, SCOPED TO THESE PAIRS ───────────────────────────────────────
    //
    // The same argument the day loop makes: an upsert rewrites a category and cannot remove one.
    // Here it can only fire if a setup row for one of these pairs carries a reason this build no
    // longer writes, which is a migration's leavings rather than a live case — kept because the
    // statement that makes a stale row unrepresentable costs one indexed delete a day.
    await db.execute(sql`
      delete from credit_usage_daily
       where day = ${key}::date and pool = 'setup'
         and computed_at < ${computedAt}::timestamptz
         and account_id in (${notFrozen})`);

    // ── 3. THE SWEEP — the only delete of `setup_grant_spends` in this file ───────────────
    //
    // Its predicate is the pair set, never a clock. That is what makes "deleted but never
    // aggregated" unrepresentable rather than merely untested: reaching this statement for a pair
    // means statement 1 wrote that pair's aggregate a moment ago, in the same pass.
    const swept = await db.execute(sql`
      delete from setup_grant_spends s
       where (s.created_at at time zone 'utc')::date = ${key}::date
         and s.account_id in (${notFrozen})
      returning 1 as swept`);
    rowsSwept += rowsOf(swept).length;
  }

  // Frozen pairs found by the SURVEY count too, not only ones a folded day happened to reveal:
  // a day whose every eligible pair is frozen is never taken, so the loop above never sees it.
  for (const n of frozenPerDay.values()) frozenPairsSkipped += n;
  return { daysFolded: take.length, pairsFolded, rowsSwept, backlogDays, frozenPairsSkipped };
}

/**
 * Recompute the daily aggregates, and — when asked — the totals, the divergence count and the
 * setup-pool sweep.
 *
 * NEVER THROWS. A roll-up is a read path's cache; a deployment whose aggregates are an hour
 * stale is a console with an honest freshness stamp, and a deployment whose maintenance tail
 * aborts is a worker that stops sweeping idempotency keys too. A failure is recorded on
 * `credit_rollup_runs` with a scrubbed class and returned in {@link CreditRollupReport.error}.
 */
export async function runCreditRollupPass(
  db: Tx, opts: CreditRollupOptions,
): Promise<CreditRollupReport> {
  const { now } = opts;
  const days = Math.max(1, Math.floor(opts.days));
  const computedAt = now.toISOString();
  // The floor the setup half will not recompute below — see the header. `getTime()` arithmetic
  // rather than a calendar walk: this is a horizon, not a day key.
  const setupFloor = new Date(now.getTime() - SETUP_SPEND_RETENTION_DAYS * DAY_MS);

  let daysRecomputed = 0;
  let rowsWritten = 0;
  let divergentAccounts: number | null = null;
  let prunedSetupSpends: number | null = null;
  let setupSweepBacklog: number | null = null;
  let frozenSetupPairsSkipped: number | null = null;
  let error: string | null = null;
  const startedAt = Date.now();

  try {
    const newest = utcDayStart(now);
    for (let back = 0; back < days; back++) {
      const dayStart = new Date(newest.getTime() - back * DAY_MS);
      const dayEnd = new Date(dayStart.getTime() + DAY_MS);
      const key = dayKey(dayStart);
      const from = dayStart.toISOString();
      const to = dayEnd.toISOString();

      // ── THE LEDGER POOL ────────────────────────────────────────────────────────────────
      //
      // `sum(delta)` keeps the ledger's sign convention, so a day's rows sum to that day's net
      // movement. `count(*)` is kept beside it because "12 credits" and "12 credits over 12
      // messages" are different operator facts and a count cannot be recovered from a sum.
      const ledger = await db.execute(sql`
        insert into credit_usage_daily
               (day, account_id, pool, reason, credits, rows, computed_at)
        select ${key}::date, account_id, 'ledger', reason,
               sum(delta)::int, count(*)::int, ${computedAt}::timestamptz
          from credit_ledger
         where created_at >= ${from}::timestamptz and created_at < ${to}::timestamptz
         group by account_id, reason
        on conflict (day, account_id, pool, reason) do update
           set credits = excluded.credits,
               rows = excluded.rows,
               computed_at = excluded.computed_at
        returning 1 as written`);
      rowsWritten += rowsOf(ledger).length;

      // ── THE SETUP POOL ─────────────────────────────────────────────────────────────────
      //
      // Every draw is a Screener classification, so the reason is that one, written as a literal
      // rather than joined from anywhere: the pool funds one gate and one gate only, which is
      // what "screening-only" means mechanically.
      //
      // `refunded_at IS NULL` — a refunded draw is an attempt the model faulted on and gave the
      // credit back for; it cost nothing and must not be reported as spend. A refund lands within
      // seconds of its draw (the fault path is synchronous), so it is inside the same day in
      // every case the code produces, and the three-day nightly window covers a midnight
      // boundary. Beyond that window a late reversal would leave a day overstated by one
      // classification, which is stated here rather than defended against with a second scan.
      //
      // Skipped below the retention floor: those rows are swept, so recomputing there would
      // write a truthful zero over an untruthful population.
      if (dayStart.getTime() >= setupFloor.getTime()) {
        const setup = await db.execute(sql`
          insert into credit_usage_daily
                 (day, account_id, pool, reason, credits, rows, computed_at)
          select ${key}::date, account_id, 'setup', 'debit_classify',
                 (-sum(amount))::int, count(*)::int, ${computedAt}::timestamptz
            from setup_grant_spends
           where created_at >= ${from}::timestamptz and created_at < ${to}::timestamptz
             and refunded_at is null
           group by account_id
          on conflict (day, account_id, pool, reason) do update
             set credits = excluded.credits,
                 rows = excluded.rows,
                 computed_at = excluded.computed_at
          returning 1 as written`);
        rowsWritten += rowsOf(setup).length;
      }

      // ── THE ABSENCE HALF OF THE RECOMPUTE ──────────────────────────────────────────────
      //
      // An upsert can rewrite a category and cannot remove one. A day whose every setup draw was
      // refunded, or an account whose rows are gone, produces no group and would keep the number
      // it had before — a stale aggregate that looks exactly like a fresh one. Rows this run did
      // not touch carry an older `computed_at` by construction, so that column IS the predicate.
      //
      // Scoped to the pools this iteration actually recomputed: below the retention floor the
      // setup half is skipped, and deleting its rows there would erase history the sweep is
      // responsible for having made unrecomputable.
      const stale = await db.execute(sql`
        delete from credit_usage_daily
         where day = ${key}::date
           and computed_at < ${computedAt}::timestamptz
           and (pool = 'ledger'
                ${dayStart.getTime() >= setupFloor.getTime() ? sql`or pool = 'setup'` : sql``})`);
      void stale;

      daysRecomputed++;
    }

    // ── TOTALS — LIFETIME, AND EACH POOL FROM THE SOURCE THAT IS COMPLETE FOR IT ─────────
    //
    // ## Why these are NOT derived from `credit_usage_daily`, which is the obvious answer
    //
    // The daily table only ever holds the days some pass has recomputed. Summing it gives the
    // total OF THE RECOMPUTE WINDOW wearing the word "lifetime" — three days on a deployment
    // whose ledger runs back to launch. The Billing board then compares that against
    // `outstanding`, a live `sum(balance)` over the whole history, and reports a permanent drift
    // of the deployment's entire lifetime on a database with nothing wrong with it. A back-fill
    // step would close it and is exactly the shape this repository has been bitten by:
    // built, tested, and reachable only through an operator remembering to run it.
    //
    // So each pool is aggregated from the source that is COMPLETE for it, which is a different
    // table for each and is the whole reason this is two statements:
    //
    //  · **`ledger`** ← `credit_ledger` directly. It is append-only and never pruned, so it IS
    //    the lifetime record, and the total is right on the first pass with nothing to back-fill.
    //    A whole-table `GROUP BY` is a real cost and it is a NIGHTLY one, on the worker, beside
    //    `findCreditDivergence`, which already walks the same table in the same pass. What the
    //    aggregates removed was this scan running on every console page load; moving it here
    //    costs one pass a night and removes the class of bug above entirely.
    //  · **`setup`** ← `setup_grants`, as `-sum(granted - remaining)` per account.
    //
    // THAT SOURCE IS A CORRECTION, and the claim it replaces was false. This comment used to say
    // the daily rows were "the only complete record of setup spend once a row has been removed",
    // and derived the lifetime figure from `credit_usage_daily`. But the daily table only ever
    // holds the days some pass recomputed, which is the exact defect this file's header describes
    // for the ledger pool — the total OF THE WINDOW wearing the word "lifetime" — and it made the
    // figure depend on the very rows the sweep removes.
    //
    // `setup_grants` is the pool's BALANCE table and it is complete by construction. `remaining`
    // is decremented in the same transaction that writes the draw row and restored in the same
    // transaction that marks a refund (`setup-grant.ts` — the only two writers of the column in
    // the repository), so `granted - remaining` IS the sum of non-refunded draws, per grant,
    // atomically. It is CHECK-bounded to `0 <= remaining <= granted`, `period_expiry` never
    // touches it, and it is never pruned: the only delete of the table is account deletion, which
    // cascades `credit_usage_totals` with it.
    //
    // So the lifetime figure is right on the first pass on any deployment, with no back-fill to
    // run and none to forget, and it stays right through every sweep — which is what lets the
    // sweep delete raw rows at all.
    //
    // `rows` still comes from `credit_usage_daily`, LEFT-joined and coalesced to 0: a count of
    // draws is not recoverable from a balance, and unlike the credits it is informational. An
    // account whose days all predate the first roll-up reports its spend exactly and its row
    // count low, which is the honest shape — a wrong count beside a right amount, never the
    // reverse.
    //
    // The trailing delete is the same absence argument as the day loop's.
    if (opts.totals === true) {
      await db.execute(sql`
        insert into credit_usage_totals
               (account_id, pool, reason, credits, rows, computed_at)
        select account_id, 'ledger', reason,
               sum(delta)::int, count(*)::int, ${computedAt}::timestamptz
          from credit_ledger
         group by account_id, reason
        on conflict (account_id, pool, reason) do update
           set credits = excluded.credits,
               rows = excluded.rows,
               computed_at = excluded.computed_at`);
      await db.execute(sql`
        insert into credit_usage_totals
               (account_id, pool, reason, credits, rows, computed_at)
        select g.account_id, 'setup', 'debit_classify',
               (-sum(g.granted - g.remaining))::int,
               coalesce(d.rows, 0)::int,
               ${computedAt}::timestamptz
          from setup_grants g
          left join (
            select account_id, sum(rows)::int as rows
              from credit_usage_daily
             where pool = 'setup'
             group by account_id
          ) d on d.account_id = g.account_id
         group by g.account_id, d.rows
        on conflict (account_id, pool, reason) do update
           set credits = excluded.credits,
               rows = excluded.rows,
               computed_at = excluded.computed_at`);
      await db.execute(sql`
        delete from credit_usage_totals where computed_at < ${computedAt}::timestamptz`);
    }

    // ── DIVERGENCE ───────────────────────────────────────────────────────────────────────
    //
    // The COUNT only. `findCreditDivergence` returns the accounts and their two disagreeing
    // numbers; the board needs to know whether the number is zero and, when it is not, that an
    // operator must look. Storing the rows would put a per-account money detail on a table the
    // blind staff role reads, which the reconciliation run ledger already declined to do with
    // its own `divergences` column for the same reason.
    if (opts.divergence === true) {
      divergentAccounts = (await findCreditDivergence(db)).length;
    }

    // ── THE SETUP-POOL FOLD AND SWEEP ────────────────────────────────────────────────────
    //
    // `setup_grant_spends` ONLY, and every row it removes belongs to a `(day, account_id)` pair
    // this same pass has just written into `credit_usage_daily`. Both halves of the eligibility
    // predicate are required and they are not redundant: the grant's expiry says the pool can no
    // longer fund anything, and the row's own age says no live retry can still be looking for it.
    // A row whose grant expired yesterday may still be the free-retry record of yesterday's work.
    //
    // There is no delete here. The only delete of this table lives in the function below, where
    // its predicate is the folded pair set — see {@link foldAndSweepSetupSpends}.
    if (opts.prune === true) {
      const fold = await foldAndSweepSetupSpends(db, { now, computedAt, capDays: opts.capDays });
      prunedSetupSpends = fold.rowsSwept;
      setupSweepBacklog = fold.backlogDays;
      frozenSetupPairsSkipped = fold.frozenPairsSkipped;
    }
  } catch (err) {
    error = scrub(err);
  }

  // Measured across the whole pass INCLUDING a failure, because the failure this column exists to
  // predict is a statement timeout — and a pass that died at 60 s is precisely the measurement an
  // operator needs, not a gap in the series.
  const durationMs = Date.now() - startedAt;

  // ── THE RUN ROW, WRITTEN WHETHER THE PASS COMPLETED OR NOT ─────────────────────────────
  //
  // A row per run is what makes "the roll-up has stopped" answerable by something other than the
  // roll-up. Its own failure is swallowed: a pass that did its work and could not record that it
  // did must not report as a pass that did nothing.
  try {
    await db.execute(sql`
      insert into credit_rollup_runs
             (ran_at, days_recomputed, rows_written, divergent_accounts, pruned_setup_spends,
              setup_sweep_backlog, duration_ms, error)
      values (${computedAt}::timestamptz, ${daysRecomputed}, ${rowsWritten},
              ${divergentAccounts}, ${prunedSetupSpends},
              ${setupSweepBacklog}, ${durationMs}, ${error})`);
  } catch {
    /* the report below still carries the truth for the caller's log */
  }

  return {
    daysRecomputed, rowsWritten, divergentAccounts, prunedSetupSpends,
    setupSweepBacklog, frozenSetupPairsSkipped, durationMs, error,
  };
}
