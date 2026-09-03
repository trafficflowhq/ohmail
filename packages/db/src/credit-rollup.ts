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
 * ## THE SETUP POOL'S RECOMPUTE HORIZON
 *
 * `setup_grant_spends` IS swept (see {@link SETUP_SPEND_RETENTION_DAYS}), so recomputing a day
 * whose rows have been swept would compute a truthful zero over an untruthful population and
 * overwrite a correct historical number with it. The setup half therefore only recomputes days
 * whose START is at or after the retention floor, and the sweep only removes rows created before
 * it. Both bounds are the same instant read from the same constant, and the comparison is against
 * the day's START on purpose: against the day's END the single day CONTAINING the floor satisfies
 * both, which is unreachable at the shipped two- and three-day windows and armed for exactly the
 * deep back-fill `days` invites.
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
 * creation, and its draws cannot predate it). The recompute horizon below is deliberately the
 * narrower 30 days, so the recompute window and the sweep window can never overlap.
 */
export const SETUP_SPEND_RETENTION_DAYS = 30;

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
  /** Sweep `setup_grant_spends` past {@link SETUP_SPEND_RETENTION_DAYS}. Nightly only. */
  prune?: boolean;
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
  let error: string | null = null;

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
    //  · **`setup`** ← `credit_usage_daily`. The opposite argument: `setup_grant_spends` IS
    //    swept, so aggregating it directly would produce a "lifetime" that SHRINKS as retention
    //    bites. The daily rows survive the sweep (that is what the recompute horizon protects),
    //    so they are the only complete record of setup spend once a row has been removed.
    //
    // THE COST OF THAT SPLIT, STATED: the setup pool's lifetime total is only as complete as the
    // daily table, so it under-reports days that predate the first roll-up on this deployment.
    // It is informational — the board's reconciliation reads `pool = 'ledger'` only, because the
    // setup pool has no `credit_balances` row to reconcile against — and it becomes complete for
    // every day the pass has ever seen.
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
        select account_id, pool, reason,
               sum(credits)::int, sum(rows)::int, ${computedAt}::timestamptz
          from credit_usage_daily
         where pool = 'setup'
         group by account_id, pool, reason
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

    // ── THE SETUP-POOL SWEEP ─────────────────────────────────────────────────────────────
    //
    // `setup_grant_spends` ONLY. Both halves of the predicate are required and they are not
    // redundant: the grant's expiry says the pool can no longer fund anything, and the row's own
    // age says no live retry can still be looking for it. A row whose grant expired yesterday
    // may still be the free-retry record of work done yesterday.
    if (opts.prune === true) {
      const cutoff = setupFloor.toISOString();
      const pruned = await db.execute(sql`
        delete from setup_grant_spends s
         using setup_grants g
         where g.id = s.grant_id
           and g.expires_at < ${cutoff}::timestamptz
           and s.created_at < ${cutoff}::timestamptz
        returning 1 as swept`);
      prunedSetupSpends = rowsOf(pruned).length;
    }
  } catch (err) {
    error = scrub(err);
  }

  // ── THE RUN ROW, WRITTEN WHETHER THE PASS COMPLETED OR NOT ─────────────────────────────
  //
  // A row per run is what makes "the roll-up has stopped" answerable by something other than the
  // roll-up. Its own failure is swallowed: a pass that did its work and could not record that it
  // did must not report as a pass that did nothing.
  try {
    await db.execute(sql`
      insert into credit_rollup_runs
             (ran_at, days_recomputed, rows_written, divergent_accounts, pruned_setup_spends, error)
      values (${computedAt}::timestamptz, ${daysRecomputed}, ${rowsWritten},
              ${divergentAccounts}, ${prunedSetupSpends}, ${error})`);
  } catch {
    /* the report below still carries the truth for the caller's log */
  }

  return { daysRecomputed, rowsWritten, divergentAccounts, prunedSetupSpends, error };
}
