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

/**
 * The provider whose bill IS the AI line, and which is therefore excluded from the
 * infrastructure aggregate. See section 1 of {@link adminCosts} for what including it cost.
 */
const AI_VENDOR = "anthropic" as const;

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
  //
  // THE MODEL VENDOR IS NOT INFRASTRUCTURE HERE, and leaving it in double-counted the headline.
  // Its `platform_costs` row is the vendor's own invoice-side figure for the same model calls
  // that section 2 totals from `ai_usage_daily`, and both were added into month-to-date and the
  // projection — one spend, counted twice, on the board an operator judges margin from.
  //
  // The AI half keeps `ai_usage_daily` as the headline's number: it is measured at the call, it
  // is per-model, it exists on every deployment, and the apportionment and every margin figure
  // are computed from it. The vendor's row stays in `providers` — the table below still shows
  // it — where it is worth more than it was in the sum: it is the RECONCILIATION. Measured
  // 2026-09-05, the two disagree by two orders of magnitude for this deployment (the ledger
  // records ~$0.01 for a month the vendor bills at ~$0.87), which is a metering gap an operator
  // should be looking at rather than a number that should be silently added to another.
  const providers = (await costsForMonth(db, start, now)).map(viewOf);
  const infraProviders = providers.filter((p) => p.provider !== AI_VENDOR);
  const measured = infraProviders.filter((p) => p.cents !== null);
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
  // Retained for the DTO's own figure; the projection below scales each provider by the day its
  // reading was taken rather than working from this single total.
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

  // A STALE READING IS PROJECTED FROM THE DAY IT WAS TAKEN, not from today, and the comment
  // above used to claim staleness "scales correctly" while the arithmetic did the opposite. A
  // usage-to-date figure fetched on day 10 and read on day 20 was divided by 20: it projected to
  // $15 on a 30-day month where the reading itself implies $30, and it SHRANK further every day
  // the provider stayed down — a bill that quietly falls while nobody can measure it, which is
  // the wrong direction for the one number an operator watches for surprises.
  //
  // Each scalable provider is therefore scaled by ITS OWN elapsed days. A `stale` row carries
  // the date it was obtained; an `api` row's date is today's by definition, so this changes
  // nothing for a healthy provider.
  const scalableRate = measured
    .filter((p) => p.source !== "manual")
    .reduce((sum, p) => {
      const takenOn = p.fetchedAt === null ? now : new Date(p.fetchedAt);
      const daysAtReading = takenOn >= start && takenOn < end
        ? Math.max(1, takenOn.getUTCDate())
        : elapsedDays;
      return sum + (p.cents ?? 0) / daysAtReading;
    }, 0);
  // The AI half is written continuously by the recorder, so its elapsed count is today's.
  const projectedCents = infraCents === null && aiCents === 0
    ? null
    : flatCents + Math.round((scalableRate + aiCents / elapsedDays) * daysInMonth);

  return {
    now: now.toISOString(),
    month: label,
    providers,
    infrastructureCents: infraCents,
    // The QUALIFIER. A total over four measured providers and one absent is not a bill, and this
    // is the number that says so — `infrastructureCents` alone would read as complete.
    // Counted over the INFRASTRUCTURE providers only, for the reason section 1 gives: the model
    // vendor's tile is a reconciliation against `aiCents`, not a term in `infrastructureCents`,
    // so counting it here would describe a sum it is not part of.
    unmeasuredProviders: infraProviders.length - measured.length,
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
