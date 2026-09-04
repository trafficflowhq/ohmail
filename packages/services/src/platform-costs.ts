import { and, desc, eq, gte, sql } from "drizzle-orm";
import { platformCosts } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import type { Db } from "./context.js";

/**
 * WHAT THE VENDORS CHARGE — the cost side of the margin, and the one place in this slice where
 * the dangerous branch is the one PRODUCTION IS IN TODAY.
 *
 * ## The risk this module is shaped around
 *
 * This module was written before any provider key existed, when the likely state of
 * `platform_costs` for its first weeks was EMPTY. Two of the five providers can be measured now
 * and the other three cannot ever be — so the empty state is still the one every decision here
 * is about, because the failure it guards is not a missing feature, it is a margin somebody
 * believes: an adapter that answers `0` when it could not ask, a DTO that defaults `cents: 0`,
 * and a console rendering "$0.00 infrastructure cost this month" in the same typeface it would
 * render a measurement.
 *
 * So the port has THREE outcomes and not two, and the third is the whole point:
 *
 *  · `{ rows }`          — measured. Written, with `fetched_at` stamped at the moment of asking.
 *  · `{ unconfigured }`  — no key. NOTHING is written. The DTO answers `cents: null` with
 *                          `source: 'unconfigured'`, and the board says "not configured".
 *  · `{ failed }`        — a key exists and the answer was unusable. Nothing is written, the
 *                          PREVIOUS row stands, and the DTO marks it `stale` with the date it
 *                          was last measured. A figure that stopped moving says so.
 *
 * There is no fourth outcome and no zero. A zero on this board is only ever a row that says
 * zero, written because a vendor said zero.
 *
 * ## THE ADAPTERS REFUSE SHAPES THEY DO NOT RECOGNISE, and that is not defensiveness
 *
 * Every adapter validates the shape it expects and answers `failed` for anything else, so the
 * worst outcome of a vendor changing a field is a board that says "not measured" rather than a
 * board that says a number nobody produced.
 *
 * That rule was written when none of these request shapes had ever been exercised against a live
 * key. Two of them have now, and BOTH GUESSES WERE PARTLY WRONG — which is the whole argument
 * for the rule, and the reason the endpoints below are stated with what a live call returns
 * rather than with what a document says it should:
 *
 *  · **anthropic** — `GET https://api.anthropic.com/v1/organizations/cost_report`
 *    `?starting_at=YYYY-MM-DD&ending_at=YYYY-MM-DD&bucket_width=1d&limit=31`, header
 *    `x-api-key: ANTHROPIC_ADMIN_API_KEY` (an ADMIN-scoped key, not the inference key this
 *    product spends on — a different credential with a different blast radius, which is why it
 *    has its own variable name rather than reusing `ANTHROPIC_API_KEY`). Answers
 *    `{ data: [{ starting_at, ending_at, results: [{ amount, currency, … }] }], has_more,
 *    next_page }`, one bucket per day.
 *
 *    **`limit` IS NOT OPTIONAL AND ITS DEFAULT IS SEVEN.** A month-long range asked without it
 *    answers 200 with the first SEVEN days and `has_more: true`, and an adapter that reads
 *    `data` and stops has just reported one week's spend as the month's bill — a wrong figure,
 *    which is the exact failure the three-outcome design above exists to make impossible. So the
 *    adapter asks for the maximum page (31, the API's own ceiling) AND follows `next_page` until
 *    `has_more` is false, and a page budget it cannot finish inside is `failed`, never a partial
 *    total. Measured 2026-09-04 against the live organization.
 *
 *  · **vercel** — `GET https://api.vercel.com/v1/billing/charges?teamId=…&from=…&to=…`, bearer
 *    `VERCEL_TOKEN`; the team is `VERCEL_TEAM_ID`. Answers FOCUS v1.3 newline-delimited JSON,
 *    one record per (day × service × region), each carrying `BilledCost` — the amount that is
 *    the basis for invoicing — beside `ServiceName`, `ConsumedQuantity` and `ConsumedUnit`.
 *
 *    **`GET /v1/usage` IS NOT THIS ENDPOINT AND IS NOT TO BE REACHED FOR AGAIN.** It is what
 *    this adapter was first written against, from a plausible guess. It exists, it authenticates,
 *    and it refuses every range: epoch milliseconds and `YYYY-MM-DD` fail its format check, full
 *    ISO-8601-with-milliseconds passes the format check and then fails `invalid_time_range` for
 *    a day, a week, thirty days, ninety days, the calendar month, and the team's own billing
 *    period read off `/v2/teams/{id}`. It appears nowhere in Vercel's published OpenAPI document
 *    (296 paths), i.e. it is an undocumented dashboard endpoint with no contract to hold it to.
 *    `/v1/billing/charges` is in that document, is a supported product surface, and answered on
 *    the first call. Measured 2026-09-04.
 *
 * `supabase`, `railway` and `resend` have no adapter at all and are MANUAL ONLY: there is no
 * usable billing API for any of them, and inventing one would be the fabricated-figure failure
 * wearing a friendlier face. Supabase joined the other two on evidence rather than on a hunch —
 * its published Management API is 115 paths and holds no usage, invoice, spend or cost surface;
 * the single billing path, `/v1/projects/{ref}/billing/addons`, returns the RATE CARD (which
 * compute add-on is selected, and what it lists at per hour) and no charged amount at all.
 * Deriving a month's bill from a rate would mean multiplying it by an assumed number of hours,
 * which is this module's forbidden move performed in arithmetic. Measured 2026-09-04.
 *
 * Manual figures arrive through `POST /admin/platform-costs`, typed by a person off an invoice,
 * and a manual row is FIRST-CLASS rather than a fallback — `source` is part of the primary key,
 * so an API row and a hand-entered row for one window coexist and the reader picks the manual
 * one.
 */

/** The five providers `platform_costs.provider` admits. A sixth is an adapter and a review. */
export type CostProvider = "vercel" | "supabase" | "anthropic" | "railway" | "resend";

/**
 * Which providers have an adapter at all. The other THREE are manual by design — see the header.
 *
 * `supabase` was in this list and is not any more: the adapter it named could never answer,
 * because the surface it called does not exist. Leaving an adapter in place for a vendor with no
 * billing API is worse than having none, because `failed` reads on the board as "the vendor is
 * having a bad day" when the truth is "nobody can ever measure this one from here".
 */
export const API_COST_PROVIDERS: readonly CostProvider[] = ["vercel", "anthropic"];

/** One measured line of somebody's bill. */
export interface PlatformCostRow {
  provider: CostProvider;
  /** The vendor's own metric name. Free text, because the vocabulary is theirs. */
  metric: string;
  periodStart: Date;
  periodEnd: Date;
  /** The measured quantity in `unit` — kept beside the money so a price change is separable. */
  value: number | null;
  unit: string | null;
  costCents: number;
  currency: string;
}

/**
 * The port's three outcomes. The union IS the design — see the module header for why a two-armed
 * version (rows or nothing) is the shape that produces a believed margin.
 */
export type PlatformCostFetch =
  | { rows: PlatformCostRow[] }
  | { unconfigured: true }
  | { failed: string };

export interface PlatformCostPort {
  fetch(provider: CostProvider, window: { start: Date; end: Date }): Promise<PlatformCostFetch>;
}

/**
 * The credentials this port reads, under the variable names a host holds them under.
 *
 * Injected rather than read from `process.env` so a test can be honest, and so the ONE place
 * that names an environment variable for costs is the host's own configuration loader
 * (`apps/api-vercel/src/config.ts#loadPlatformCostCredentials`) rather than a module three
 * layers down. `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` were members here and are
 * gone: a variable a deployment can set that changes nothing is the reassuring half-sentence
 * that becomes a support question.
 */
export interface PlatformCostEnv {
  VERCEL_TOKEN?: string | undefined;
  VERCEL_TEAM_ID?: string | undefined;
  ANTHROPIC_ADMIN_API_KEY?: string | undefined;
}

const trimmed = (v: string | undefined): string => (v ?? "").trim();

/** USD → cents, rounded. A float of dollars is never stored; the column is an integer. */
const dollarsToCents = (usd: number): number => Math.round(usd * 100);

/** A shape guard that answers `null` rather than throwing — every parser below is built on it. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** `YYYY-MM-DD` — what Anthropic's cost report accepts for `starting_at`/`ending_at`. */
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The biggest page Anthropic's cost report will serve, and the API's own ceiling: `limit=32`
 * answers 400 `Input should be less than or equal to 31`. One page therefore covers any
 * calendar month in a single request, and the paging loop below is what happens when that stops
 * being true rather than the ordinary path.
 */
const ANTHROPIC_PAGE_LIMIT = 31;

/**
 * How many pages the cost report may be followed for before the answer is `failed`.
 *
 * A month of daily buckets is ONE page at the limit above, so this is pure slack against a
 * vendor changing its page size. It is a refusal and not a truncation on purpose: a partial
 * total is a wrong figure, and a wrong figure is the one thing this module may not produce.
 */
const ANTHROPIC_MAX_PAGES = 12;

/**
 * The most JSONL a billing-charges response may be before this adapter refuses to parse it.
 *
 * Vercel emits one record per (day × service × region) for every day in the requested range —
 * INCLUDING days with nothing on them, so the size is set by the length of the range and not by
 * how much was spent. Measured 2026-09-04: 932 records ≈ 480 KB per day, so a full 31-day month
 * is ≈ 14 MB and does not grow with traffic. 64 MB is four months of that; a response past it is
 * a vendor whose shape has changed, and spending a serverless invocation's whole budget parsing
 * it would cost the pass the OTHER provider it could have measured.
 */
const MAX_CHARGES_BYTES = 64 * 1024 * 1024;

/**
 * How far past "now" the charges range is allowed to reach.
 *
 * ── IT LOOKS LIKE A SIZE OPTIMISATION AND IT IS A CORRECTNESS ONE ────────────────────────
 *
 * The obvious reading is bytes: the window this port is asked about is the whole calendar month,
 * and asking for days that have not happened returns a zero record per service per region for
 * each of them. That is true and it is the smaller half.
 *
 * The larger half is that **the range decides how much of a FLAT FEE the answer contains.**
 * Measured 2026-09-04, four days into the month, same account, same call, two ranges: asking
 * `to = 2026-10-01` reports the plan subscription at $19.04 — the WHOLE month's fee, accrued
 * forward into days that have not happened — while asking `to = now + 1 day` reports $2.57, the
 * part of it that has actually accrued. The board's headline is month-TO-DATE and its projection
 * multiplies that figure by (days in month ÷ days elapsed), so the unclamped answer would be
 * projected to roughly eight times the real bill. The clamped one projects back to about $19,
 * which is the fee. So this constant is what makes the figure the one the projection is written
 * against, and removing it to "simplify the request" silently breaks the number.
 *
 * A DAY rather than zero, because `to` is exclusive and the vendor's buckets are 24 hours offset
 * by its billing timezone: clamping to the instant of asking can fall inside the open bucket and
 * drop it. Including it costs nothing — the vendor reports that bucket's accrual so far, not a
 * whole day of it.
 *
 * The rows this adapter returns are still stamped with the calendar month, which is the window
 * the board reads and the key the upsert replaces on.
 */
const CHARGES_LOOKAHEAD_MS = 24 * 60 * 60 * 1000;

/**
 * Build the live port.
 *
 * `fetchImpl` is injectable and every test passes one, so the default suite makes no network
 * call — the same rule `makeAnthropicClient` follows, and for the same reason: a cost adapter
 * that dialled a vendor from a test would be a zero-external-requests violation and a flake.
 */
export function makePlatformCostPort(
  env: PlatformCostEnv,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => Date } = {},
): PlatformCostPort {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  // Injected for the same reason `fetchImpl` is: the charges range is clamped to the present
  // (see CHARGES_LOOKAHEAD_MS) and a test that could not move the clock would have to assert
  // against whatever day the suite happens to run on.
  const now = opts.now ?? ((): Date => new Date());

  /** One bounded GET. Every failure — transport, status, non-JSON — is a CODE, never a throw. */
  const get = async (
    url: string, headers: Record<string, string>,
  ): Promise<{ ok: true; body: unknown } | { ok: false; code: string }> => {
    let res: Response;
    try {
      res = await doFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      // The NAME only, never the message: a fetch error's message carries the URL, and this
      // string is written to a column granted to the blind staff role.
      return { ok: false, code: `transport:${String((err as Error)?.name ?? "unknown")}` };
    }
    if (!res.ok) return { ok: false, code: `http_${res.status}` };
    try {
      return { ok: true, body: await res.json() };
    } catch {
      return { ok: false, code: "non_json" };
    }
  };

  /**
   * The same GET for a NEWLINE-DELIMITED body, which `res.json()` cannot read at all.
   *
   * Vercel's billing charges stream as `application/jsonl`, so the whole response is not a JSON
   * document and asking for one would answer `non_json` on a perfectly good bill. Every failure
   * is a CODE here too, on the same rule and for the same reason: the string reaches an operator
   * surface, and a fetch error's message carries the URL.
   */
  const getLines = async (
    url: string, headers: Record<string, string>,
  ): Promise<{ ok: true; lines: string[] } | { ok: false; code: string }> => {
    let res: Response;
    try {
      res = await doFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      return { ok: false, code: `transport:${String((err as Error)?.name ?? "unknown")}` };
    }
    if (!res.ok) return { ok: false, code: `http_${res.status}` };
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      return { ok: false, code: `transport:${String((err as Error)?.name ?? "unknown")}` };
    }
    // REFUSED, not truncated. See MAX_CHARGES_BYTES: a body past the ceiling is a vendor whose
    // shape changed, and half of a bill is a wrong number rather than a partial one.
    if (text.length > MAX_CHARGES_BYTES) return { ok: false, code: "response_too_large" };
    return { ok: true, lines: text.split("\n") };
  };

  return {
    async fetch(provider, window) {
      switch (provider) {
        case "vercel": {
          const token = trimmed(env.VERCEL_TOKEN);
          const team = trimmed(env.VERCEL_TEAM_ID);
          // BOTH or neither. A token with no team would ask about the personal scope and answer
          // a number that belongs to somebody's own account, which is a wrong figure rather than
          // a missing one — strictly the worse of the two.
          if (!token || !team) return { unconfigured: true };
          // ISO-8601 with milliseconds, which is what the endpoint's own documented example is
          // (`2025-01-01T00:00:00.000Z`) and what `Date.prototype.toISOString` produces. `to` is
          // exclusive and clamped to just past the present — see CHARGES_LOOKAHEAD_MS.
          const askedTo = new Date(Math.min(
            window.end.getTime(), now().getTime() + CHARGES_LOOKAHEAD_MS,
          ));
          const url = `https://api.vercel.com/v1/billing/charges?teamId=${encodeURIComponent(team)}`
            + `&from=${window.start.toISOString()}&to=${askedTo.toISOString()}`;
          const res = await getLines(url, { authorization: `Bearer ${token}` });
          if (!res.ok) return { failed: res.code };
          return parseVercelCharges(res.lines, window);
        }
        case "anthropic": {
          const key = trimmed(env.ANTHROPIC_ADMIN_API_KEY);
          if (!key) return { unconfigured: true };
          const headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
          const base = "https://api.anthropic.com/v1/organizations/cost_report"
            + `?starting_at=${isoDay(window.start)}&ending_at=${isoDay(window.end)}`
            + `&bucket_width=1d&limit=${ANTHROPIC_PAGE_LIMIT}`;
          // THE PAGING LOOP IS THE ADAPTER. Reading `data` from the first response and stopping
          // is what this code used to do, and against a month-long range with the API's default
          // page size that reports the first SEVEN DAYS as the month's bill. See the module
          // header: the failure is a wrong figure, not a missing one, so nothing here may return
          // a total it knows is partial.
          const buckets: unknown[] = [];
          let page: string | null = null;
          for (let asked = 0; asked < ANTHROPIC_MAX_PAGES; asked += 1) {
            const url = page === null ? base : `${base}&page=${encodeURIComponent(page)}`;
            const res = await get(url, headers);
            if (!res.ok) return { failed: res.code };
            const body = res.body as
              { data?: unknown; has_more?: unknown; next_page?: unknown } | null;
            if (!body || typeof body !== "object" || !Array.isArray(body.data)) {
              return { failed: "unrecognised_shape" };
            }
            buckets.push(...body.data);
            if (body.has_more !== true) return parseAnthropic(buckets, window);
            const next = typeof body.next_page === "string" && body.next_page ? body.next_page : null;
            // `has_more` with no cursor, or a cursor that repeats, is an answer this adapter
            // cannot finish. Reporting the buckets it has would be the partial total again.
            if (next === null || next === page) return { failed: "paging_stalled" };
            page = next;
          }
          return { failed: "too_many_pages" };
        }
        case "supabase":
        case "railway":
        case "resend":
          // MANUAL ONLY, and `unconfigured` is the honest word for it: there is no key to add and
          // no endpoint to call, so the board should say "not configured" until somebody types
          // the figure off an invoice. A `failed` here would page about a decision.
          //
          // `supabase` sits here rather than above because its Management API has no billing
          // surface to call — see the module header for what 115 published paths do and do not
          // contain. It reached this arm by deleting an adapter, which is the honest direction:
          // an adapter that can only ever answer `failed` teaches an operator to ignore the word.
          return { unconfigured: true };
      }
    },
  };
}

/**
 * Vercel's FOCUS billing charges → one row per SERVICE, for the whole calendar month.
 *
 * The response is newline-delimited JSON, one record per (day × service × region), each holding
 * `BilledCost` — FOCUS v1.3's "charge amount serving as the basis for invoicing", i.e. what the
 * invoice will say, which is the question the board asks. `EffectiveCost` sits beside it and is
 * the amortized figure including committed-spend draw-down; it is deliberately not used, because
 * a board headed "what the vendors charge" that reported an amortized number would disagree with
 * the invoice it is meant to predict.
 *
 * ── WHY PER SERVICE PER MONTH, AND NOT PER DAY ────────────────────────────────────────────
 *
 * The grain that reaches the board is the month: `costsForMonth` sums every metric a provider
 * has in one month and hands the total to one tile. So the day grain buys nothing that is
 * rendered, costs thirty times the writes on a pass that runs four times a day — and, worse, it
 * cannot be written honestly. Vercel's charge buckets are 24 hours offset by the billing
 * timezone (`2026-08-31T07:00:00.000Z → 2026-09-01T07:00:00.000Z` is the first bucket a
 * September query returns), and `costsForMonth` selects on `period_start >= monthStart`. Day
 * rows carrying the vendor's own boundaries would therefore drop the first bucket of every month
 * out of both months' sums — a silent understatement of one day in thirty, which is precisely
 * the class of error this module is built to refuse. The SERVICE breakdown is the part an
 * operator actually reads (a $19 plan fee is a different fact from $1.50 of function time), and
 * `metric` carries it with no boundary to get wrong.
 *
 * Every row is stamped with the calendar month it was asked for, so re-asking the open month
 * replaces the same primary key and `fetched_at` moves with it.
 */
function parseVercelCharges(
  lines: string[], window: { start: Date; end: Date },
): PlatformCostFetch {
  const totals = new Map<string, { usd: number; quantity: number | null; unit: string | null }>();
  // A RECOGNISED record is one carrying the four FOCUS fields this parser reads. Counting them
  // is what separates "the vendor reported nothing charged" from "this parser did not understand
  // the answer" — the two must never produce the same thing. See the module header.
  let recognised = 0;
  let currency = "usd";

  for (const line of lines) {
    const text = line.trim();
    if (text === "") continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // ONE unreadable line is skipped rather than failing the response: a JSONL stream is a
      // sequence of independent records. A response where NO line parses lands on `recognised
      // === 0` below and is refused as a whole.
      continue;
    }
    const service = typeof record.ServiceName === "string" ? record.ServiceName : null;
    const billed = num(record.BilledCost);
    // `ChargePeriodStart`/`ChargePeriodEnd` are required in FOCUS v1.3. Requiring them here is
    // what stops an unrelated JSON object that happens to carry a `BilledCost` from counting as
    // a bill.
    const periodShaped = typeof record.ChargePeriodStart === "string"
      && typeof record.ChargePeriodEnd === "string";
    if (service === null || billed === null || !periodShaped) continue;
    recognised += 1;
    if (typeof record.BillingCurrency === "string" && record.BillingCurrency) {
      currency = record.BillingCurrency.toLowerCase();
    }
    const acc = totals.get(service) ?? { usd: 0, quantity: null, unit: null };
    acc.usd += billed;
    const quantity = num(record.ConsumedQuantity);
    if (quantity !== null) acc.quantity = (acc.quantity ?? 0) + quantity;
    if (acc.unit === null && typeof record.ConsumedUnit === "string" && record.ConsumedUnit) {
      acc.unit = record.ConsumedUnit;
    }
    totals.set(service, acc);
  }

  // NOT A ZERO BILL. A response with no record this parser recognises is a response it could not
  // read, and the one thing this module may never do is decide that means nothing was spent.
  if (recognised === 0) return { failed: "unrecognised_shape" };

  const rows: PlatformCostRow[] = [];
  for (const [metric, acc] of totals) {
    // A service the account has never touched contributes an exact 0 on every day in the range —
    // fifty-five of the sixty-five service names in a live response are that. Writing them would
    // fill the table with rows that say nothing, and it is safe to leave them out precisely
    // because a month-to-date total only ever grows: a service that starts costing money gets
    // its row on the next pass. A SUB-CENT service (`0.0001` USD) is NOT this case and is
    // written, at zero cents, because it was genuinely used.
    if (acc.usd === 0) continue;
    rows.push({
      provider: "vercel", metric,
      periodStart: window.start, periodEnd: window.end,
      value: acc.quantity, unit: acc.unit,
      // FLOORED, on the same reasoning as `parseAnthropic`'s total: this is a SUM over a month
      // of that service's charges, so a credit inside the month legitimately reduces it, and
      // dropping the credit would overstate the bill. The migration's `cost_cents >= 0` CHECK
      // still has to be satisfied.
      costCents: Math.max(0, dollarsToCents(acc.usd)),
      currency,
    });
  }

  // Recognised records, and every one of them zero: a real month in which nothing was charged.
  // It gets a row that SAYS zero — the distinction the whole module is built on — under a metric
  // name that is the vendor's own word for the response rather than a service that was invented.
  if (rows.length === 0) {
    rows.push({
      provider: "vercel", metric: "charges",
      periodStart: window.start, periodEnd: window.end,
      value: null, unit: null, costCents: 0, currency,
    });
  }
  return { rows };
}

/**
 * Anthropic's organization cost report → one row.
 *
 * Takes the buckets ALREADY COLLECTED ACROSS PAGES rather than one response body, because a
 * single body is not the month: the API's default page is seven daily buckets and the caller
 * follows `next_page` until `has_more` is false. A parser that took one body would make the
 * partial-total bug expressible again.
 *
 * Summed into a single `tokens` row per window, because the board's question is "what did the
 * model cost this month" and the per-bucket detail is the Console's job.
 *
 * `amount` is a STRING of dollars in that report (`"70.7614"`), so it is parsed rather than read
 * — and a value that does not parse is skipped rather than treated as zero.
 */
function parseAnthropic(
  buckets: unknown[], window: { start: Date; end: Date },
): PlatformCostFetch {
  let cents = 0;
  // A RECOGNISED bucket is the shape a live report returns: a time window carrying a `results`
  // array. Requiring `starting_at` is what makes an arbitrary object with a `results` key fail
  // rather than count — and counting these, rather than counting readable amounts, is what lets
  // a genuinely quiet month be told apart from an answer this parser did not understand.
  let recognised = 0;
  let currency = "usd";
  for (const raw of buckets) {
    const bucket = raw as Record<string, unknown> | null;
    if (!bucket || typeof bucket !== "object") continue;
    if (typeof bucket.starting_at !== "string" || !Array.isArray(bucket.results)) continue;
    recognised += 1;
    for (const r of bucket.results as Array<Record<string, unknown>>) {
      const amount = typeof r?.amount === "string" ? Number(r.amount) : num(r?.amount);
      if (amount === null || !Number.isFinite(amount)) continue;
      cents += dollarsToCents(amount);
      if (typeof r?.currency === "string" && r.currency) currency = r.currency.toLowerCase();
    }
  }
  // No bucket of the shape this parser knows ⇒ a report it cannot read, which is `failed`. A
  // report whose buckets ARE that shape and carry no results is a month in which nothing was
  // charged, and it lands as a real zero row below — a live August report holds two such days
  // beside twenty-nine that cost money, so this is the ordinary case and not a hypothetical.
  if (recognised === 0) return { failed: "unrecognised_shape" };
  return {
    rows: [{
      provider: "anthropic", metric: "tokens",
      periodStart: window.start, periodEnd: window.end,
      // FLOORED AT ZERO. This total is a SUM across every result in the window, so a credit note
      // legitimately reduces it — that is real, and dropping the entry would overstate the bill
      // by the credited amount. The migration's `cost_cents >= 0` CHECK still has to be
      // satisfied, so a window whose credits outweigh its usage reports as zero rather than
      // failing the whole provider for one period.
      value: null, unit: null, costCents: Math.max(0, cents), currency,
    }],
  };
}

/** What one pass did, per provider. Codes only — never a vendor's message text. */
export interface PlatformCostPassReport {
  ranAt: Date;
  providers: Array<{
    provider: CostProvider;
    outcome: "written" | "unconfigured" | "failed";
    rows: number;
    /** A closed code on `failed` (`http_401`, `transport:TimeoutError`, `unrecognised_shape`). */
    code?: string;
  }>;
}

export interface PlatformCostPassOptions {
  port: PlatformCostPort;
  now?: () => Date;
  /** Which providers to ask. Defaults to the three with adapters. */
  providers?: readonly CostProvider[];
}

/**
 * Ask every configured provider for the CURRENT calendar month and record what they say.
 *
 * The month rather than a rolling window, because that is the unit every one of these vendors
 * bills in and the unit the board projects from: a rolling 30 days would produce a figure that
 * cannot be compared against the invoice that eventually arrives.
 *
 * Re-asking the same open month is the point rather than a cost. `source` is in the primary key
 * and so is the window, so today's answer replaces this morning's for the same month, and
 * `fetched_at` moves with it — which is what makes "measured an hour ago" a fact rather than a
 * hope. A CLOSED month stops moving on its own: the vendor stops changing the number, and the
 * last pass over it is the final one.
 *
 * It NEVER throws. A provider that fails is a recorded outcome and the other two still run —
 * one vendor's outage must not cost the board the two figures it could have had.
 */
export async function runPlatformCostPass(
  db: Db, opts: PlatformCostPassOptions,
): Promise<PlatformCostPassReport> {
  const now = opts.now ?? ((): Date => new Date());
  const tx = db as unknown as Tx;
  const at = now();
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  const report: PlatformCostPassReport = { ranAt: at, providers: [] };

  for (const provider of opts.providers ?? API_COST_PROVIDERS) {
    let result: PlatformCostFetch;
    try {
      result = await opts.port.fetch(provider, { start, end });
    } catch (err) {
      // A port that THROWS is a port that failed; the union exists so it does not have to, and
      // this is the belt to that. The class only — never the message.
      result = { failed: `threw:${String((err as Error)?.name ?? "unknown")}` };
    }

    if ("unconfigured" in result) {
      // NOTHING IS WRITTEN. Not a zero, not a placeholder, not a null-cost row. The absence of a
      // row IS the state, and the DTO turns it into `cents: null` + `source: 'unconfigured'`.
      report.providers.push({ provider, outcome: "unconfigured", rows: 0 });
      continue;
    }
    if ("failed" in result) {
      // Also nothing. The PREVIOUS row stands, and the DTO marks it `stale` with the date it was
      // measured — a figure that stopped moving says so, rather than silently becoming a zero.
      report.providers.push({ provider, outcome: "failed", rows: 0, code: result.failed });
      continue;
    }

    // THE WRITE IS ITS OWN TRY/CATCH, and it is what keeps this loop's outer promise: "one
    // vendor's outage must not cost the board the other two". A row can reach here with a shape
    // the parser accepted but the database refuses — the `cost_cents >= 0` CHECK is the reachable
    // case, since `parseVercel`/`parseSupabase` accept any finite line amount and a discount or
    // credit line in a vendor's response is a negative one — and before this guard existed, that
    // one bad row aborted the WHOLE PASS: the insert threw, nothing caught it, and every provider
    // later in this loop was never asked, while any providers already written this run stayed
    // committed. A write failure is recorded exactly like a parse failure: nothing for THIS
    // provider, the previous row stands, and the loop continues.
    try {
      for (const row of result.rows) {
        await tx.insert(platformCosts).values({
          provider: row.provider,
          metric: row.metric,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          value: row.value === null ? null : String(row.value),
          unit: row.unit,
          costCents: row.costCents,
          currency: row.currency,
          source: "api",
          fetchedAt: at,
        }).onConflictDoUpdate({
          target: [
            platformCosts.provider, platformCosts.metric,
            platformCosts.periodStart, platformCosts.periodEnd, platformCosts.source,
          ],
          set: {
            value: sql`excluded.value`,
            unit: sql`excluded.unit`,
            costCents: sql`excluded.cost_cents`,
            currency: sql`excluded.currency`,
            fetchedAt: sql`excluded.fetched_at`,
          },
        });
      }
      report.providers.push({ provider, outcome: "written", rows: result.rows.length });
    } catch (err) {
      report.providers.push({
        provider, outcome: "failed", rows: 0,
        code: `write:${String((err as Error)?.name ?? "unknown")}`,
      });
    }
  }
  return report;
}

/** A note shorter than this is refused — the migration's CHECK, in the service. */
export const MANUAL_COST_MIN_NOTE = 8;

export interface ManualCostEntry {
  provider: CostProvider;
  metric: string;
  periodStart: Date;
  periodEnd: Date;
  costCents: number;
  currency?: string;
  value?: number | null;
  unit?: string | null;
  note: string;
  /** The `staff_users` id of the operator who typed it. */
  enteredBy: string;
}

/**
 * Record a figure a person read off an invoice.
 *
 * FIRST-CLASS, not a fallback. Two of the five providers have no usable billing API at all, and
 * for the other three a person reading the invoice is better evidence than an API reporting
 * usage-to-date. `source` is part of the primary key, so this row and the API's row for the same
 * window COEXIST — the reader prefers this one, and the API's own number stays there to disagree
 * with, which is what makes the override auditable rather than a deletion.
 *
 * The actor and the note live ON THE ROW rather than in `audit_log`, following
 * `oauth_provider_config.updated_by` exactly and for its stated reason: `audit_log.account_id` is
 * NOT NULL, and a payment to our own hosting provider belongs to no account — forcing one in
 * would be a lie in the column the audit trail is keyed by.
 */
export async function recordManualPlatformCost(db: Db, entry: ManualCostEntry): Promise<void> {
  const tx = db as unknown as Tx;
  await tx.insert(platformCosts).values({
    provider: entry.provider,
    metric: entry.metric,
    periodStart: entry.periodStart,
    periodEnd: entry.periodEnd,
    value: entry.value === null || entry.value === undefined ? null : String(entry.value),
    unit: entry.unit ?? null,
    costCents: entry.costCents,
    currency: entry.currency ?? "usd",
    source: "manual",
    enteredBy: entry.enteredBy,
    note: entry.note,
  }).onConflictDoUpdate({
    target: [
      platformCosts.provider, platformCosts.metric,
      platformCosts.periodStart, platformCosts.periodEnd, platformCosts.source,
    ],
    set: {
      value: sql`excluded.value`,
      unit: sql`excluded.unit`,
      costCents: sql`excluded.cost_cents`,
      currency: sql`excluded.currency`,
      // A correction is a new entry by a new person: both move, so the row always names whoever
      // stands behind the number that is on it.
      enteredBy: sql`excluded.entered_by`,
      note: sql`excluded.note`,
      fetchedAt: sql`now()`,
    },
  });
}

/** One provider's newest figure, and how it was obtained. The DTO's own vocabulary. */
export interface ProviderCost {
  provider: CostProvider;
  /** `null` means NOT MEASURED. It is never 0 for want of a measurement. */
  cents: number | null;
  currency: string;
  /** When the figure was obtained; `null` when there is none. */
  fetchedAt: Date | null;
  source: "api" | "manual" | "unconfigured" | "stale";
  /** The operator's note, on a manual row. */
  note: string | null;
  enteredBy: string | null;
}

/**
 * How old an API row may be before the board calls it `stale`.
 *
 * Four cadences of the six-hourly pass. Tighter would call a deployment stale for one missed
 * pass, which happens on every deploy; looser would let a provider that has been failing for a
 * day read as measured.
 */
export const COST_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Read one month's cost per provider, MANUAL PREFERRED.
 *
 * The preference is the whole reason `source` is in the primary key. A manual row is a person
 * who read the invoice; an API row is a vendor reporting usage-to-date. When they disagree the
 * person is right, and the API's number is still on the table to disagree with.
 */
export async function costsForMonth(
  db: Db, monthStart: Date, now: Date,
): Promise<ProviderCost[]> {
  const tx = db as unknown as Tx;
  const rows = await tx
    .select({
      provider: platformCosts.provider,
      costCents: platformCosts.costCents,
      currency: platformCosts.currency,
      fetchedAt: platformCosts.fetchedAt,
      source: platformCosts.source,
      note: platformCosts.note,
      enteredBy: platformCosts.enteredBy,
    })
    .from(platformCosts)
    .where(and(
      gte(platformCosts.periodStart, monthStart),
      sql`${platformCosts.periodStart} < ${new Date(Date.UTC(
        monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1,
      )).toISOString()}::timestamptz`,
    ))
    .orderBy(desc(platformCosts.fetchedAt));

  const byProvider = new Map<CostProvider, ProviderCost>();
  for (const p of ["vercel", "supabase", "anthropic", "railway", "resend"] as const) {
    byProvider.set(p, {
      provider: p, cents: null, currency: "usd", fetchedAt: null,
      source: "unconfigured", note: null, enteredBy: null,
    });
  }

  // Sum each provider's metrics, per source, then pick. Summing before picking is what makes
  // "Vercel cost $41" a whole answer rather than whichever metric happened to sort first.
  const totals = new Map<string, { cents: number; fetchedAt: Date; note: string | null; enteredBy: string | null; currency: string }>();
  for (const r of rows) {
    const key = `${r.provider}|${r.source}`;
    const acc = totals.get(key);
    if (acc) {
      acc.cents += r.costCents;
      if (r.fetchedAt > acc.fetchedAt) acc.fetchedAt = r.fetchedAt;
    } else {
      totals.set(key, {
        cents: r.costCents, fetchedAt: r.fetchedAt, note: r.note,
        enteredBy: r.enteredBy, currency: r.currency,
      });
    }
  }

  for (const [key, acc] of totals) {
    const [provider, source] = key.split("|") as [CostProvider, "api" | "manual"];
    const current = byProvider.get(provider)!;
    // MANUAL WINS, whatever the API said and whenever it said it.
    if (current.source === "manual" && source === "api") continue;
    byProvider.set(provider, {
      provider,
      cents: acc.cents,
      currency: acc.currency,
      fetchedAt: acc.fetchedAt,
      // A manual figure does not go stale: a person read an invoice, and an invoice does not
      // change. An API figure does — a provider that stopped answering leaves its last row
      // standing, and this is the word that stops it reading as current.
      source: source === "manual"
        ? "manual"
        : now.getTime() - acc.fetchedAt.getTime() > COST_STALE_AFTER_MS ? "stale" : "api",
      note: source === "manual" ? acc.note : null,
      enteredBy: source === "manual" ? acc.enteredBy : null,
    });
  }

  return [...byProvider.values()];
}
