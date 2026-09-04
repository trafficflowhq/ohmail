import { and, eq, inArray, sql } from "drizzle-orm";
import { billingSubscriptions, PLAN_LIMITS } from "@trafficflow/db/cloud";
import { accounts as accountsTable, type Tx } from "@trafficflow/db";
import type { Db } from "./context.js";
import { costsForMonth, type CostProvider, type ProviderCost } from "./platform-costs.js";
import type {
  AdminCostSnapshot, AiModelCost, AccountUnitCost, ProviderCostView,
} from "./admin-dto.js";

/**
 * THE COST BOARD'S READ — what serving customers cost, and how much of it is a measurement.
 *
 * Three figures with three different epistemic statuses, and the DTO's whole job is to keep them
 * apart on the page:
 *
 *  · **infrastructure** — measured, or explicitly NOT. A provider with no key contributes `null`,
 *    never 0, and the total carries a count of how many providers are unmeasured beside it. A
 *    board that summed four measured providers and one absent one into a confident number would
 *    be understating the bill by exactly the amount nobody looked at.
 *  · **AI** — measured at the call, by model and by host (`ai_usage_daily`).
 *  · **AI per ACCOUNT** — APPORTIONED, and labelled as such at every level of the type. Nothing
 *    in this system knows which account a model call belonged to, deliberately: attributing one
 *    inside `packages/core/src/ai/*` was refused, because that package is desktop payload and
 *    knows nothing about accounts. So an account's share is derived from the credits it spent
 *    against the credits the deployment spent, and `attribution: "apportioned"` rides on every
 *    row so no surface can render it as if it were a measurement.
 *
 * ## The apportionment, stated exactly
 *
 * Per DAY and per MODEL FAMILY, never per call:
 *
 *     account's AI cost for a family, that day
 *       = (that account's credits spent on reasons in that family, that day)
 *       ÷ (the deployment's credits spent on reasons in that family, that day)
 *       × (what that family's models actually cost, that day)
 *
 * By FAMILY rather than by reason because two reasons map to one model — a drafted reply and a
 * workflow step are both Sonnet — so a per-reason split would have to invent a ratio between
 * them. By DAY because the price mix moves: a day of heavy proposing is Opus-weighted, and a
 * month-level ratio would smear that across accounts that never proposed.
 *
 * What it is NOT: a per-account measurement, a basis for a bill, or evidence about one account.
 * It is the only honest answer available to "which accounts cost us the most", and the label is
 * what keeps it that.
 */

/**
 * The four metered reasons, mapped to the model family each one spends on.
 *
 * EXPORTED and restated in TypeScript although the apportionment does the mapping in SQL, because
 * the two must agree and only one of them is readable from here. `admin-costs.test.ts` compares
 * this map against the `CASE` arms in the statement below — a reason added to the ledger without
 * a family lands in neither, and an arm that drifts from this map silently apportions somebody's
 * Opus spend at Haiku prices.
 */
export const FAMILY_OF_REASON: Readonly<Record<string, "haiku" | "sonnet" | "opus">> = {
  debit_classify: "haiku",
  debit_draft: "sonnet",
  debit_workflow: "sonnet",
  debit_propose: "opus",
};

/** How many accounts either ranking shows. */
export const COST_RANK_LIMIT = 10;

/**
 * How many accounts the per-account read walks before it stops.
 *
 * The ruling's scale note holds the console to ≤1 000 accounts before an `admin.account_summary`
 * view is needed, and this is well inside it. A pass that hits the cap reports `truncated`, which
 * the console renders — a ranking computed over an arbitrary subset must not present itself as
 * "the top ten".
 */
export const COST_ACCOUNT_SCAN_CAP = 500;

/** micro-USD → cents, rounded. The ledger's own rounding rule, one unit up. */
const microToCents = (micro: number): number => Math.round(micro / 10_000);

/** The month a date falls in, as `[start, end)` in UTC. */
function monthBounds(at: Date): { start: Date; end: Date; label: string } {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { start, end, label: start.toISOString().slice(0, 7) };
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** A provider's figure, projected for the wire (dates as ISO strings). */
const viewOf = (c: ProviderCost): ProviderCostView => ({
  provider: c.provider,
  cents: c.cents,
  currency: c.currency,
  fetchedAt: c.fetchedAt === null ? null : c.fetchedAt.toISOString(),
  source: c.source,
  note: c.note,
  enteredBy: c.enteredBy,
});

/**
 * The cost snapshot for the CURRENT month.
 *
 * Bounded reads only, `withAdminTimeout`'s rules: three aggregate statements over day-grained
 * tables plus one capped per-account walk. Nothing here scans `credit_ledger`, which is the whole
 * reason cloud 0028 exists.
 */
export async function adminCosts(db: Db, now: Date): Promise<AdminCostSnapshot> {
  const tx = db as unknown as Tx;
  const { start, end, label } = monthBounds(now);

  // ── 1. infrastructure ───────────────────────────────────────────────────────────────────
  const providers = (await costsForMonth(db, start, now)).map(viewOf);
  const measured = providers.filter((p) => p.cents !== null);
  const infraCents = measured.length === 0
    ? null
    : measured.reduce((sum, p) => sum + (p.cents ?? 0), 0);
  // FLAT vs USAGE-TO-DATE, for the projection below and for no other figure on this snapshot.
  // A `manual` row exists precisely for vendors billed a fixed amount for the month — three of
  // the five providers publish no billing API at all, so a person reading their invoice is the
  // only figure there will ever be for them (`API_COST_PROVIDERS` names the two that can be
  // asked). An operator typing a flat monthly platform fee on day 3 is typing the WHOLE month's
  // charge, not three days of it. Pro-rating it the way a usage-to-date
  // API reading is pro-rated would multiply a flat fee by (days-in-month ÷ days-elapsed): a $20
  // flat charge entered on day 3 of 30 would project as ~$200. `api` and `stale` readings ARE
  // usage-to-date (a `stale` row is simply an old one of those) and scale correctly.
  const flatCents = measured
    .filter((p) => p.source === "manual")
    .reduce((sum, p) => sum + (p.cents ?? 0), 0);
  const scalableInfraCents = (infraCents ?? 0) - flatCents;

  // ── 2. AI, by model and by host ─────────────────────────────────────────────────────────
  const modelRows = await tx.execute(sql`
    select model,
           sum(calls)::int          as calls,
           sum(ok_calls)::int       as ok_calls,
           sum(input_tokens)::bigint  as input_tokens,
           sum(output_tokens)::bigint as output_tokens,
           sum(cost_micro_usd)::bigint as cost_micro
      from ai_usage_daily
     where day >= ${isoDay(start)}::date and day < ${isoDay(end)}::date
     group by model
     order by 6 desc`);
  const models: AiModelCost[] = rowsOf<{
    model: string; calls: number; ok_calls: number;
    input_tokens: string | number; output_tokens: string | number; cost_micro: string | number;
  }>(modelRows).map((r) => ({
    model: r.model,
    calls: Number(r.calls),
    okCalls: Number(r.ok_calls),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cents: microToCents(Number(r.cost_micro)),
  }));

  const hostRows = await tx.execute(sql`
    select host, sum(calls)::int as calls, sum(cost_micro_usd)::bigint as cost_micro
      from ai_usage_daily
     where day >= ${isoDay(start)}::date and day < ${isoDay(end)}::date
     group by host`);
  const hosts = rowsOf<{ host: string; calls: number; cost_micro: string | number }>(hostRows)
    .map((r) => ({ host: r.host, calls: Number(r.calls), cents: microToCents(Number(r.cost_micro)) }));

  const aiCents = models.reduce((sum, m) => sum + m.cents, 0);

  // ── 3. the APPORTIONMENT, in ONE statement ──────────────────────────────────────────────
  //
  // Aggregated server-side rather than walked in this process: the naive shape is one row per
  // (account, day, reason), which on 500 accounts over a month is tens of thousands of rows
  // crossing a `max: 1` connection to be summed here. The join below returns one row per account.
  //
  // `nullif(t.credits, 0)` is the division guard, and it is not decoration: a family with a
  // recorded cost and no credits at all — the self-host tier is unmetered, and a failed call
  // refunds its credit — would otherwise divide by zero. Such a day contributes nothing to any
  // account, which is correct: nobody's credits paid for it.
  const apportioned = await tx.execute(sql`
    with fam as (
      select day,
             case when model ilike '%haiku%'  then 'haiku'
                  when model ilike '%sonnet%' then 'sonnet'
                  when model ilike '%opus%'   then 'opus'
             end as family,
             sum(cost_micro_usd)::numeric as cost_micro
        from ai_usage_daily
       where day >= ${isoDay(start)}::date and day < ${isoDay(end)}::date
       group by 1, 2
    ), acct as (
      select day, account_id,
             case when reason = 'debit_classify' then 'haiku'
                  when reason in ('debit_draft', 'debit_workflow') then 'sonnet'
                  when reason = 'debit_propose' then 'opus'
             end as family,
             sum(abs(credits))::numeric as credits
        from credit_usage_daily
       -- BOTH POOLS, deliberately. The numerator (fam.cost_micro) is the whole day's model spend
       -- regardless of which pool paid for it, and credit-rollup.ts writes a setup/debit_classify
       -- row for classification the Screener's setup pool drew -- screening-only, so
       -- debit_classify is the only reason that can carry that pool. A ledger-only filter here
       -- would exclude setup-funded classify credits from the DENOMINATOR while the numerator
       -- still included the cost those calls produced, so on any day with setup-pool spend every
       -- ledger-paying account would absorb a share of cost that setup credits actually paid for
       -- -- overstating their apportioned cost by exactly the setup pool's fraction of that day's
       -- classify volume. NO BACKTICKS in this comment on purpose: it lives inside a sql-tagged
       -- template literal, and a literal backtick here would close the JS string early.
       where pool in ('ledger', 'setup')
         and reason in ('debit_classify', 'debit_draft', 'debit_propose', 'debit_workflow')
         and day >= ${isoDay(start)}::date and day < ${isoDay(end)}::date
       group by 1, 2, 3
    ), tot as (
      select day, family, sum(credits) as credits from acct group by 1, 2
    )
    select a.account_id::text as account_id,
           sum(a.credits)::numeric                                    as credits,
           sum(f.cost_micro * a.credits / nullif(t.credits, 0))::numeric as micro
      from acct a
      join tot t on t.day = a.day and t.family = a.family
      join fam f on f.day = a.day and f.family = a.family
     where a.family is not null and f.family is not null
     group by 1
     order by 3 desc nulls last
     limit ${COST_ACCOUNT_SCAN_CAP + 1}`);
  const rawAccounts = rowsOf<{ account_id: string; credits: string | number; micro: string | number | null }>(apportioned);
  const truncated = rawAccounts.length > COST_ACCOUNT_SCAN_CAP;
  const walked = truncated ? rawAccounts.slice(0, COST_ACCOUNT_SCAN_CAP) : rawAccounts;

  // ── 4. what each of those accounts PAYS, monthly-equivalent ─────────────────────────────
  //
  // THROUGH THE QUERY BUILDER, and the ids are BOUND rather than interpolated. They come out of
  // our own `account_id` column and are uuids, so a raw list would be safe today — and it would
  // be a shape somebody copies to a read whose ids came from a request. `inArray` binds.
  const ids = walked.map((r) => r.account_id);
  const priced = ids.length === 0 ? [] : await tx
    .select({
      accountId: billingSubscriptions.accountId,
      name: accountsTable.name,
      plan: billingSubscriptions.plan,
      billingInterval: billingSubscriptions.billingInterval,
    })
    .from(billingSubscriptions)
    .innerJoin(accountsTable, eq(accountsTable.id, billingSubscriptions.accountId))
    .where(and(
      inArray(billingSubscriptions.accountId, ids),
      inArray(billingSubscriptions.status, ["active", "trialing", "past_due"]),
    ));
  const priceOf = new Map(priced.map((r) => [r.accountId, r]));

  const accounts: AccountUnitCost[] = walked.map((r) => {
    const sub = priceOf.get(r.account_id);
    const plan = sub && sub.plan in PLAN_LIMITS ? sub.plan as keyof typeof PLAN_LIMITS : null;
    // MONTHLY-EQUIVALENT, so an annual customer is comparable with a monthly one. Annual billing
    // is ten monthly months paid up front, so a twelfth of the year's price is what that customer
    // contributes in the month this board is looking at.
    const monthlyCents = plan === null ? null
      : sub!.billingInterval === "year"
        ? Math.round(PLAN_LIMITS[plan].priceUsd * 10 * 100 / 12)
        : PLAN_LIMITS[plan].priceUsd * 100;
    const cents = r.micro === null ? 0 : microToCents(Number(r.micro));
    return {
      accountId: r.account_id,
      name: sub?.name ?? null,
      plan: plan ?? null,
      credits: Number(r.credits),
      // ALWAYS labelled. No surface can render this beside a measured figure without saying so.
      attribution: "apportioned" as const,
      aiCents: cents,
      monthlyPriceCents: monthlyCents,
      // `null` rather than a percentage when there is no price: an account with no live
      // subscription has no margin, and 0 % or −100 % would both be inventions. The board renders
      // "no subscription", which is the fact.
      grossMarginPct: monthlyCents === null || monthlyCents === 0
        ? null
        : Math.round(((monthlyCents - cents) / monthlyCents) * 100),
    };
  });

  const byCost = [...accounts].sort((a, b) => b.aiCents - a.aiCents);
  const byMargin = accounts
    .filter((a) => a.grossMarginPct !== null)
    .sort((a, b) => (a.grossMarginPct ?? 0) - (b.grossMarginPct ?? 0));

  // ── 5. the projection, and the day count it rests on ────────────────────────────────────
  //
  // FLAT + (SCALABLE ÷ elapsed × the month's length). Elapsed counts the CURRENT day as one, so
  // the first hours of a month do not divide by zero and do not multiply a single morning's
  // usage-to-date spend by thirty-one. Only the scalable half is pro-rated — see `flatCents`
  // above for why a manual flat-fee entry must not be, and `monthToDateCents` is still the
  // simple, unscaled total: the split exists for the projection only.
  const daysInMonth = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  const elapsedDays = Math.max(1, now.getUTCDate());
  const monthToDate = (infraCents ?? 0) + aiCents;
  const scalableMonthToDate = scalableInfraCents + aiCents;
  const projectedCents = infraCents === null && aiCents === 0
    ? null
    : flatCents + Math.round((scalableMonthToDate / elapsedDays) * daysInMonth);

  return {
    now: now.toISOString(),
    month: label,
    providers,
    infrastructureCents: infraCents,
    // The QUALIFIER. A total over four measured providers and one absent is not a bill, and this
    // is the number that says so — `infrastructureCents` alone would read as complete.
    unmeasuredProviders: providers.length - measured.length,
    aiCents,
    models,
    hosts,
    monthToDateCents: monthToDate,
    projectedMonthCents: projectedCents,
    projectionBasisDays: elapsedDays,
    daysInMonth,
    accounts: {
      topByCost: byCost.slice(0, COST_RANK_LIMIT),
      bottomByMargin: byMargin.slice(0, COST_RANK_LIMIT),
      underwater: accounts.filter((a) => a.grossMarginPct !== null && a.grossMarginPct < 0).length,
      walked: accounts.length,
      truncated,
    },
  };
}

/** PGlite answers `{ rows }`; postgres-js answers the array. One shape for both. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}
