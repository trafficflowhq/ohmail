import { and, desc, eq, gt, gte, lt, sql } from "drizzle-orm";
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
 *    **THE AMOUNTS ARE CENTS, NOT DOLLARS.** The vendor's documentation settles it in one line:
 *    *"All costs in USD, reported as decimal strings in lowest units (cents)."* So `"70.7614"`
 *    is seventy-one cents, and NOTHING on this path multiplies by 100 —
 *    {@link microCentsFromDecimalString} scales the digits and {@link centsFromMicroCents}
 *    divides back. It is the one fact about either vendor that no response reveals and only the
 *    documentation settles, and this adapter published every figure a hundredfold for its whole
 *    life because the parser and its own test shared the assumption.
 *
 *    **IT EXCLUDES PRIORITY TIER**, by the vendor's own statement: *"Priority Tier costs use a
 *    different billing model and are not included in the cost endpoint."* This deployment has no
 *    Priority Tier commitment and its request builders never set `service_tier`, so today the
 *    report is the whole bill. An organization that later buys one would find this figure
 *    silently short, and nothing here could detect it — recorded so the next reader knows the
 *    limit is the vendor's rather than this parser's.
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
 *    **IT SELECTS BUCKETS BY THEIR END, WHICH IS NOT WHAT A CALENDAR MONTH IS.** Asking for
 *    August with August's own UTC boundaries returns THIRTY buckets, not thirty-one: the one
 *    starting `2026-08-31T07:00Z` ends seven hours past the range and is dropped, while the one
 *    starting `2026-07-31T07:00Z` — July's — is returned. Both ends wrong, in opposite
 *    directions, and no request range can fix both. So the range is deliberately widened past
 *    the month and the parser assigns each bucket to the month its own START falls in. Measured
 *    2026-09-05 and cross-checked against an independent count of the same stream: August is 31
 *    buckets and $7.07, where the range-bounded read was 30 buckets missing the final day.
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
  /**
   * THE VENDOR REPORTED A POSITIVE AMOUNT FOR THIS LINE, whatever `costCents` rounded to.
   *
   * The standing invariant of this module is that a zero written with `source = 'api'` and a
   * fresh stamp means the VENDOR said zero. `costCents` alone cannot carry that: a line the
   * vendor charged a hundredth of a cent for, and a line it charged nothing for, are both `0`
   * after rounding, and only the parser knows which is which. So the parser states it and
   * {@link writeMeasuredRows} refuses the combination that would be a lie.
   */
  charged: boolean;
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
/**
 * Every way this module reports a failure — a CLOSED union, not free text.
 *
 * The code reaches `report.providers[].code`, an INFO log line, and the body of
 * `GET /internal/platform-costs/run`. Three of the sites that produce one used to interpolate
 * `Error.name`, which is a mutable property of an object a vendor's runtime can supply, so
 * arbitrary text could ride out through all three. A transport or write failure now maps to a
 * fixed member and the original class is dropped: what is lost is a shade of diagnosis, what is
 * gained is that no value from outside this process is ever echoed by an operator surface.
 */
export type PlatformCostFailure =
  | "unrecognised_shape"     // a body, line or bucket this parser does not recognise
  | "non_json"               // a document response that is not JSON at all
  | "response_too_large"     // past MAX_CHARGES_BYTES; refused rather than parsed
  | "paging_stalled"         // `has_more` with no cursor, or a cursor already walked
  | "paging_conflict"        // two pages disagree about one bucket
  | "too_many_pages"         // the page budget could not finish the walk
  | "bucket_gap"             // a day missing between pages, or at a window boundary
  | "day_coverage_short"     // a stream that stopped before the window's days were covered
  | "period_conflict"        // two records at the vendor's own grain disagree about a period
  | "mixed_currency"         // more than one currency in one answer
  | "missing_currency"       // a monetary record that names no currency at all
  | "currency_unsupported"   // a currency this board cannot render; every figure here is USD
  | "negative_total"         // credits outweighed charges; the column cannot hold it
  | "window_not_started"     // asked about a window that has not begun
  | "empty_response"         // a success carrying no rows
  | "stale_pass"             // a newer pass already wrote this window; this one is behind
  | "transport"              // the request never produced a status
  | "write"                  // the database refused the rows
  | `http_${number}`;        // a status the vendor returned

export type PlatformCostFetch =
  | { rows: PlatformCostRow[] }
  | { unconfigured: true }
  | { failed: PlatformCostFailure };

/**
 * The window a provider is asked about, and whether its first day is REQUIRED to be present.
 *
 * `requireFullStart` is database evidence rather than a preference: it is true when this
 * deployment already holds an `api` row for an EARLIER month, which proves the account was
 * billing before this window and makes a late first day a short answer rather than an inception.
 * See `passWindows`, and the July measurement recorded there.
 */
export interface PlatformCostWindow {
  start: Date;
  end: Date;
  requireFullStart?: boolean;
}

export interface PlatformCostPort {
  fetch(provider: CostProvider, window: PlatformCostWindow): Promise<PlatformCostFetch>;
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

/**
 * ── ONE INTEGER MONEY UNIT: MICRO-CENTS ─────────────────────────────────────────────────
 *
 * Every amount either vendor reports is converted to an integer number of MILLIONTHS OF A CENT
 * on arrival, summed as integers, and rounded to cents exactly once at the end. Integers sum
 * exactly; a running total of binary floats does not, and neither does rounding each line.
 *
 * 1e6 because it is comfortably finer than either vendor's precision (Anthropic reports four
 * decimal places of a cent) and a month in micro-cents stays far inside `MAX_SAFE_INTEGER`: a
 * $1,000,000 month is 1e14 against a ceiling near 9e15.
 */
const MICRO_CENTS_PER_CENT = 1_000_000;

/**
 * A DOLLAR AMOUNT THAT ARRIVED AS A JSON NUMBER → integer micro-cents. Vercel's `BilledCost`.
 *
 * MEASURED before this comment was written, because the version of it that stood here described
 * what the code should do rather than what it did — which is the defect this round found, in the
 * commit that claimed to fix it:
 *
 *     Math.round(1.005 * 100) === 100          ← a cent lost, every time that value appears
 *     Math.round(1.005 * 1e8) === 100500000    → 101 cents
 *
 * `1.005 * 100` is `100.49999999999999`, so rounding at the cent scale rounds DOWN a value that
 * is exactly half. Scaling to micro-cents first puts the binary error six orders of magnitude
 * below the digit being decided, and the one rounding at the end sees `100.5`.
 *
 * There is no decimal string to parse here — FOCUS sends a JSON number, so this float IS what
 * the vendor gave us. Anthropic sends strings, and {@link microCentsFromDecimalString} reads
 * those with no floating-point step at all.
 */
function microCentsFromDollars(usd: number): number {
  return Math.round(usd * MICRO_CENTS_PER_CENT * 100);
}

/**
 * A DECIMAL STRING OF CENTS → integer micro-cents, with NO floating-point step.
 *
 * Anthropic's `amount` is a string (`"70.7614"`, in cents — see the module header), so the
 * digits are available exactly and there is no reason to route them through a float. The two
 * halves are read as digits, the fraction is padded or rounded at the sixth place, and the
 * result is assembled with integer arithmetic.
 *
 * `null` for anything that is not a plain decimal — no exponent, no separator, no `Infinity`.
 * A number this cannot read EXACTLY is money it cannot account for, and the caller refuses the
 * whole report rather than guessing at it.
 */
function microCentsFromDecimalString(raw: string): number | null {
  const m = /^\s*(-?)(\d*)(?:\.(\d*))?\s*$/.exec(raw);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return null;
  const scale = 6;
  const frac = (m[3] ?? "").padEnd(scale + 1, "0");
  const kept = `${m[2] || "0"}${frac.slice(0, scale)}`;
  const magnitude = Number(kept) + (frac.charCodeAt(scale) - 48 >= 5 ? 1 : 0);
  if (!Number.isSafeInteger(magnitude)) return null;
  return m[1] === "-" ? -magnitude : magnitude;
}

/**
 * Micro-cents → the integer cents the column stores. ONE rounding, at the end of the sum.
 *
 * A POSITIVE TOTAL NEVER BECOMES ZERO. A vendor that charged a hundredth of a cent charged
 * something, and `0` written with `source = 'api'` and a fresh stamp is this module's forbidden
 * sentence — "the vendor said nothing was spent" — in the one case where the vendor said the
 * opposite. Rounding up to one cent overstates by under a cent; rounding down asserts something
 * false. Only an EXACT zero rounds to zero.
 */
function centsFromMicroCents(micro: number): number {
  if (micro === 0) return 0;
  const cents = Math.round(micro / MICRO_CENTS_PER_CENT);
  return micro > 0 ? Math.max(1, cents) : cents;
}

/**
 * Split a provider's cent total across its NON-NEGATIVE service shares so the parts sum EXACTLY
 * to the whole. Negative shares are refused, not handled — see the guard.
 *
 * Largest remainder: each service takes the floor of its exact share and the cents left over go
 * to the services whose discarded fractions were biggest. Rounding each service separately gave
 * rows that did not add up to the figure the board renders — three services at $0.004 became
 * three zeroes against a total of one cent — and the previous fix, handing the difference to the
 * largest row and clamping at zero, could not represent a NEGATIVE residual and left the rows
 * summing ABOVE the total. This cannot: the allocation is exact by construction.
 */
function allocateCents(total: number, shares: number[]): number[] {
  // THE DOMAIN, stated because the claim above is only true inside it. `allocateCents(5, [-1])`
  // returns `[0]`, which does not sum to 5 — a negative share has no meaning as a proportion of
  // a positive whole. It is unreachable: a negative line routes to the credit branch before this
  // is called. The guard makes that a refusal rather than an assumption, and the sentence above
  // is now about the inputs this actually receives rather than about every input imaginable —
  // which is the class of over-broad claim this lane has been pulled up on twice.
  if (shares.some((v) => v < 0)) throw new Error("allocateCents: negative share");
  const sum = shares.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return shares.map(() => 0);
  const exact = shares.map((v) => (v / sum) * total);
  const out = exact.map((v) => Math.floor(v));
  let left = total - out.reduce((a, b) => a + b, 0);
  for (const { i } of exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac)) {
    if (left <= 0) break;
    out[i] = out[i]! + 1;
    left -= 1;
  }
  return out;
}

/** A shape guard that answers `null` rather than throwing — every parser below is built on it. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * An ISO-8601 instant that carries its own OFFSET, as milliseconds — or `null`.
 *
 * `Date.parse` is not enough on its own and the difference is a month boundary: a timestamp with
 * no offset (`2026-09-01T07:00:00`) is interpreted in the PROCESS timezone, so the same vendor
 * response would be attributed to different months on a machine in Berlin and a function in
 * `fra1`. Both vendors send `Z`; requiring the offset is what makes that a checked fact rather
 * than an assumption, and a string without one is refused rather than guessed at.
 */
function instantMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * One currency for the whole answer, or the answer is refused.
 *
 * Summing across currencies produces a number no currency supports, and labelling it with
 * whichever one happened to be read last makes it look like a figure. `cost_cents` has exactly
 * one `currency` column per row, so a response carrying two is not a bill this schema can hold.
 */
class Currency {
  private seen: string | null = null;
  private conflict = false;
  observe(v: unknown): void {
    // TRIMMED before the emptiness test. `"   "` used to count as a currency, resolve to
    // whitespace, and be written on a fresh monetary row that the board still renders with a
    // dollar sign — the missing-currency refusal defeated by three spaces.
    const t = typeof v === "string" ? v.trim() : "";
    if (t === "") return;
    const c = t.toLowerCase();
    if (this.seen === null) this.seen = c;
    else if (this.seen !== c) this.conflict = true;
  }
  /** True when a monetary record named no currency at all — see `resolve`. */
  private missing = false;
  /** Call for every record that carries MONEY. A monetary record must name its currency. */
  observeRequired(v: unknown): void {
    if (typeof v !== "string" || v.trim() === "") { this.missing = true; return; }
    this.observe(v);
  }
  /**
   * The one currency this answer is in, or a REASON there is not one.
   *
   * `"mixed"` and `"missing"` are separate because they are different faults with the same
   * consequence. Defaulting a missing currency to USD was the previous behaviour and it is the
   * false-measurement shape again one level down: the figure would be stored and rendered as
   * dollars on the word of a field the vendor did not send. A response with NO monetary record
   * at all (a genuinely quiet month) never calls `observeRequired`, so it still resolves to the
   * column's default and a real zero is still expressible.
   */
  resolve(): string | { failed: "mixed_currency" | "missing_currency" | "currency_unsupported" } {
    if (this.conflict) return { failed: "mixed_currency" };
    if (this.missing) return { failed: "missing_currency" };
    const one = this.seen ?? "usd";
    // A COHERENT FOREIGN CURRENCY IS STILL REFUSED, and this is the half that was missing:
    // refusing only a MIXED answer let a response entirely in euros through, to be stored fresh,
    // added to dollar providers by `adminCosts` and rendered with a `$`. Every figure on this
    // board is dollars and nothing between here and the render carries a unit, so a currency
    // this board cannot display is a figure it cannot hold.
    return one === "usd" ? one : { failed: "currency_unsupported" };
  }
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
 * And the same ceiling in wall-clock terms, because the page count never bounded the time.
 *
 * Twelve pages at the 15-second request timeout is 180 seconds inside a 60-second route. Held
 * well under the pass budget so one provider's paging cannot consume the whole invocation and
 * leave the other provider unasked with nothing recorded about why.
 */
const ANTHROPIC_WALK_BUDGET_MS = 25_000;

/** `bucket_width=1d`, in milliseconds — what the continuity check in `parseAnthropic` steps by. */
const ANTHROPIC_BUCKET_MS = 24 * 60 * 60 * 1000;

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
 * How much further than the month's end the charges range must reach to CONTAIN the month.
 *
 * Vercel selects charge buckets by their END, not by overlap: a range ending `2026-09-01T00:00Z`
 * returns the bucket `2026-08-30T07:00Z → 2026-08-31T07:00Z` and NOT the one starting
 * `2026-08-31T07:00Z`, because that one ends at `2026-09-01T07:00Z`, seven hours past the range.
 * So asking for "August" with August's own UTC boundaries silently loses August's LAST DAY —
 * measured 2026-09-05, a 31-bucket month coming back as 30 with the missing day at the end.
 *
 * One day of tail is enough for any billing-timezone offset, and it over-collects on purpose: the
 * request is deliberately wider than the month and `parseVercelCharges` then keeps only the
 * buckets whose START falls inside it. Selecting on the bucket's own start is what makes every
 * bucket belong to exactly one month — no gap at the end, no duplicate at the front.
 */
const CHARGES_BUCKET_TAIL_MS = 24 * 60 * 60 * 1000;

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

/** One charge period, in milliseconds — the vendor's granularity is one day. */
const CHARGES_DAY_MS = 24 * 60 * 60 * 1000;

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
  ): Promise<{ ok: true; body: unknown } | { ok: false; code: PlatformCostFailure }> => {
    let res: Response;
    try {
      res = await doFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      // A CLOSED MEMBER, not the error's name. The name is a mutable property of an object a
      // vendor's runtime supplies, and this string reaches an operator surface — see
      // {@link PlatformCostFailure}. The message was never used: it carries the URL.
      return { ok: false, code: "transport" };
    }
    if (!res.ok) return { ok: false, code: `http_${res.status}` as PlatformCostFailure };
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
  ): Promise<{ ok: true; lines: string[] } | { ok: false; code: PlatformCostFailure }> => {
    let res: Response;
    try {
      res = await doFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      return { ok: false, code: "transport" };
    }
    if (!res.ok) return { ok: false, code: `http_${res.status}` as PlatformCostFailure };
    let text: string;
    try {
      text = await res.text();
    } catch {
      return { ok: false, code: "transport" };
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
          // (`2025-01-01T00:00:00.000Z`) and what `Date.prototype.toISOString` produces.
          //
          // `to` is the smaller of two bounds and each one is load-bearing for a DIFFERENT
          // number. CHARGES_BUCKET_TAIL_MS reaches past the month's end so the month's last
          // bucket is inside the range at all (the endpoint selects on a bucket's END);
          // CHARGES_LOOKAHEAD_MS holds the range near the present so a flat monthly fee is only
          // accrued as far as today. On a CLOSED month the first wins, on the OPEN month the
          // second does, and the parser filters the extra buckets the first one pulls in.
          const askedTo = new Date(Math.min(
            window.end.getTime() + CHARGES_BUCKET_TAIL_MS,
            now().getTime() + CHARGES_LOOKAHEAD_MS,
          ));
          // A window that has not begun is REFUSED rather than dialled, and the test is the
          // CLOCK against the window rather than `askedTo` against it — which was a day late,
          // because `askedTo` carries the lookahead and so reaches into a month that has not
          // started during the 24 hours before it does. The pass always asks about the month it
          // is in, so this is unreachable from production; the port is exported, and a caller
          // with a future window would otherwise be handed forward-accrued flat fees for a month
          // that has not started, stamped as a measurement.
          if (now().getTime() < window.start.getTime()) return { failed: "window_not_started" };
          const url = `https://api.vercel.com/v1/billing/charges?teamId=${encodeURIComponent(team)}`
            + `&from=${window.start.toISOString()}&to=${askedTo.toISOString()}`;
          const res = await getLines(url, { authorization: `Bearer ${token}` });
          if (!res.ok) return { failed: res.code };
          return parseVercelCharges(res.lines, window, now());
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
          // Keyed by `starting_at`, which identifies a bucket for a fixed `bucket_width`. The
          // cursor was measured to be EXCLUSIVE of the page it came from (`page_` decodes to the
          // next bucket's start), so pages do not overlap today — but a total is the one thing
          // here that may not be wrong, and a vendor changing to an inclusive cursor would
          // double-count a day per page rather than fail. De-duplicating cannot lose a bucket
          // and removes the whole class.
          const buckets = new Map<string, unknown>();
          let page: string | null = null;
          const walked = new Set<string>();
          // ── THE WALK IS BOUNDED IN TIME AS WELL AS IN PAGES ─────────────────────────────
          //
          // Twelve pages at fifteen seconds each is three minutes, inside a route the platform
          // kills at sixty seconds. The page count alone never bounded the wall clock, so the
          // arithmetic that mattered was never the one being checked. A walk that runs out of
          // time REFUSES — `has_more` is still true, nothing partial is returned, and the
          // caller records a failure rather than a short month. Reported as the same budget
          // code as the page ceiling because it is the same fact: the walk did not finish.
          const walkStartedAt = Date.now();
          for (let asked = 0; asked < ANTHROPIC_MAX_PAGES; asked += 1) {
            if (asked > 0 && Date.now() - walkStartedAt >= ANTHROPIC_WALK_BUDGET_MS) {
              return { failed: "too_many_pages" };
            }
            const url = page === null ? base : `${base}&page=${encodeURIComponent(page)}`;
            const res = await get(url, headers);
            if (!res.ok) return { failed: res.code };
            const body = res.body as
              { data?: unknown; has_more?: unknown; next_page?: unknown } | null;
            if (!body || typeof body !== "object" || !Array.isArray(body.data)) {
              return { failed: "unrecognised_shape" };
            }
            for (const raw of body.data) {
              const at = (raw as { starting_at?: unknown } | null)?.starting_at;
              // A bucket with no usable identity cannot be de-duplicated, so it is kept under a
              // key that cannot collide and refused downstream by the parser's shape guard.
              const key = typeof at === "string" ? at : `#${buckets.size}`;
              const already = buckets.get(key);
              if (already !== undefined) {
                // ONLY AN IDENTICAL REPEAT IS SAFE TO DROP. Two pages carrying the same day with
                // DIFFERENT amounts is not a duplicate, it is a disagreement — and silently
                // keeping whichever arrived last picks one of two bills at random. There is no
                // coherent month to publish, so nothing is.
                if (JSON.stringify(already) !== JSON.stringify(raw)) {
                  return { failed: "paging_conflict" };
                }
                continue;
              }
              buckets.set(key, raw);
            }
            // ONLY a literal `false` finishes the walk. `has_more` absent, or arriving as the
            // STRING "true" after some future change, would otherwise read as completion — and
            // completion here means writing seven days as a month, the exact defect this loop
            // exists to remove. Anything that is not a boolean is an answer this adapter does
            // not understand, which is `failed` and never a total.
            if (body.has_more === false) return parseAnthropic([...buckets.values()], window, now());
            if (body.has_more !== true) return { failed: "unrecognised_shape" };
            const next = typeof body.next_page === "string" && body.next_page ? body.next_page : null;
            // `has_more` with no cursor, or a cursor already walked, is an answer this adapter
            // cannot finish. Reporting the buckets it has would be the partial total again.
            // `walked` rather than a comparison with the previous cursor: an A→B→A cycle repeats
            // no cursor consecutively and would otherwise spin to the page budget.
            if (next === null || walked.has(next)) return { failed: "paging_stalled" };
            walked.add(next);
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
  lines: string[], window: PlatformCostWindow, asOf: Date,
): PlatformCostFetch {
  const totals = new Map<string, {
    micro: number; quantity: number | null; unit: string | null; charged: boolean;
  }>();
  // Counted only for records that fall INSIDE the window. Counting every recognised record was
  // the previous shape and it manufactured a zero: minutes after a month starts, the response can
  // hold only the PREVIOUS month's last bucket, which was recognised, then filtered out, and the
  // empty-total arm below published a measured `$0.00` for the new month. What this number has to
  // answer is "did the vendor tell us anything about the month we asked about", and only an
  // in-window record does.
  let inWindow = 0;
  // WHETHER THE VENDOR REPORTED ANYTHING POSITIVE AT ALL, read from the amounts as they arrive
  // and BEFORE any rounding. `charged` used to be derived from the accumulated micro-cents,
  // which is already rounded per record — so a positive amount below half a micro-cent became
  // `charged: false` and `writeMeasuredRows` accepted a fresh API zero for it. The provenance
  // has to come from what the vendor said, not from what the arithmetic made of it.
  //
  // THIS IS OBSERVABLE, and it was worth checking rather than asserting: replacing the raw test
  // with a rounded one (`microCentsFromDollars(billed) >= MICRO_CENTS_PER_CENT`) turns
  // `THREE SUB-CENT SERVICES...` and `A REAL BREAKDOWN SURVIVES...` red. A review round read
  // this derivation as output-equivalent because a micro-zero line is filtered by `used` before
  // the drop rule sees it; that is true only of the vanishing case where the amount rounds to no
  // micro-cents at all. A sub-cent service has micro > 0, survives `used`, reaches the drop rule,
  // and is dropped or written according to exactly this flag.
  let vendorCharged = false;
  const currency = new Currency();
  // The distinct charge-period starts seen inside the window, for the coverage check below, and
  // the furthest END any of them reached — a period is only evidence for the time it covers.
  // ── KEYED BY DAY × SERVICE × REGION, WHICH IS THE SERIES THAT RUNS DAY AFTER DAY ────────
  //
  // `periods` was keyed by START ALONE, so two records sharing a start overwrote each other and
  // whichever survived decided the contiguity join — reversing the line order changed the
  // verdict, and a record covering 23 hours could be hidden behind one covering 24.
  //
  // Contiguity is now checked PER SERIES rather than over a merged set. The project is NOT part
  // of this key: the vendor reports one service-day once per project, and adding the project
  // changed no input's verdict because this same grouping re-collapses them. What the repeats
  // do require is the disagreement refusal below.
  const periods = new Map<string, { from: number; to: number }>();
  let lastCoveredEnd = 0;
  // Detected on a RECORD rather than on a service's total: a credit that happens to be offset by
  // usage under the SAME service would otherwise keep a per-service breakdown, which is exactly
  // the shape that cannot represent a credit.
  let credited = false;

  for (const line of lines) {
    const text = line.trim();
    if (text === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // ONE UNREADABLE LINE FAILS THE WHOLE RESPONSE. Skipping looked right — a JSONL stream is a
      // sequence of independent records — and is wrong for a BILL: the commonest way a line fails
      // to parse is a TRUNCATED STREAM, and summing the records that did arrive writes an
      // understatement wearing the typeface of a total.
      return { failed: "unrecognised_shape" };
    }
    // `JSON.parse("null")` succeeds and answers `null`, which then threw on the first property
    // read — a rejected promise out of a port whose whole contract is that every failure is a
    // code. Same for a bare array or number.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { failed: "unrecognised_shape" };
    }
    const record = parsed as Record<string, unknown>;
    const service = typeof record.ServiceName === "string" ? record.ServiceName : null;
    const billed = num(record.BilledCost);
    // FOCUS v1.3 requires both period fields, and both are parsed as INSTANTS WITH AN OFFSET
    // rather than with a bare `Date.parse` — see `instantMs`: a timestamp with no offset is read
    // in the process timezone and can cross the month boundary, so the same response would be
    // attributed differently on two machines. The end must also follow the start; it used to be
    // accepted as any string at all, including one before it.
    const from = instantMs(record.ChargePeriodStart);
    const to = instantMs(record.ChargePeriodEnd);
    if (service === null || billed === null || from === null || to === null || to <= from) {
      // Same rule as the unparseable line, for the same reason: a record this parser cannot read
      // is a piece of the bill it cannot account for. `num` already refuses a string, a NaN and
      // an Infinity, so a `BilledCost` that is any of those lands here rather than in the sum.
      return { failed: "unrecognised_shape" };
    }
    // THE MONTH IS DECIDED BY THE BUCKET'S OWN START, not by the request range, and this is what
    // makes the figure whole. The request is deliberately wider than the month at both ends (see
    // CHARGES_BUCKET_TAIL_MS): the endpoint selects buckets by their END, so a range stopping at
    // the month's UTC midnight loses the month's last billing day, and a range starting at it
    // still returns the PREVIOUS month's final bucket. Filtering on the start assigns every
    // bucket to exactly one calendar month — nothing dropped at the end, nothing counted twice
    // at the front.
    if (from < window.start.getTime() || from >= window.end.getTime()) continue;
    inWindow += 1;
    // ── A BILLING DAY IS NOT ALWAYS 24 HOURS, AND THE PROOF IS NOT AVAILABLE HERE ───────────
    //
    // This required EXACTLY 24 hours, which refuses a whole month at a daylight-saving
    // transition: every observed start is `07:00:00Z`, i.e. UTC-7, which is US Pacific in
    // summer — so a period spanning the November change is 25 hours and one spanning March is
    // 23, and one such period fails the month.
    //
    // I COULD NOT MEASURE IT. This account has NO DATA before July 2026 (a June query answers
    // 404 `costs_not_found`), so the 2025-11-02 and 2026-03-08 transitions predate it and the
    // next one, 2026-11-01, has not happened. Writing a timezone table from the 07:00Z offset
    // would be an inference presented as a measurement — the exact shape of the error that made
    // every Anthropic figure a hundred times too large.
    //
    // So the check moves to the property coverage actually needs, which IS measurable:
    // CONTIGUITY — each period ending where the next begins — asserted below. A 23- or 25-hour
    // period at a transition is contiguous with its neighbours and passes; a one-hour period is
    // not, because the hours it does not cover leave a hole. The bound here only rejects the
    // absurd. Measured 2026-09-05 over a live month: 32 periods, every start at 07:00:00Z, every
    // duration 24.0 h, zero non-contiguous joins.
    //
    // **FIRST CHANCE TO OBSERVE IT: 2026-11-01**, the next daylight-saving change in the
    // UTC-7 offset every period so far has carried. Whoever is here then can settle in one call
    // what this comment could only reason about — whether the period spanning it is 25 hours,
    // whether the boundary moves to 08:00Z, or neither.
    //
    // THIS CHECK IS EXPECTED TO PASS EITHER WAY, and that is the point of choosing contiguity
    // over a duration table: it does not depend on the answer. If the observation contradicts
    // the UTC-7 reading, what changes is this comment, not the guard. Record what is seen —
    // including "nothing changed" — rather than deleting the note, so the next reader knows the
    // question was asked and answered instead of asking it again.
    if (to - from < 23 * 60 * 60 * 1000 || to - from > 25 * 60 * 60 * 1000) {
      return { failed: "day_coverage_short" };
    }
    const region = typeof record.RegionId === "string" ? record.RegionId : "";
    const series = `${service}\u0000${region}`;
    // ── ONE SERVICE-DAY ARRIVES MANY TIMES, AND THAT IS THE ORDINARY SHAPE ─────────────────
    //
    // Measured over the live account's August: 3,534 of 20,615 (day, service, region) keys carry
    // MORE THAN ONE record, in groups of up to eleven, and 224 of those groups carry a non-zero
    // amount. A group of eight differs only in `EffectiveCost`, `ConsumedQuantity`,
    // `PricingQuantity` and `Tags` — and `Tags` names the project (`ohmail-api`, `ohmail-admin`,
    // `ohmail-landing`, …). They are per-PROJECT line items of one service's day. Summing them
    // is right, and the code has always summed them.
    //
    // So REFUSING the response on a repeated key would refuse every real month. What was wrong
    // was narrower: repeats overwrote each other here while both amounts were counted, so when
    // two of them disagreed about the period END, whichever arrived last silently decided
    // contiguity for the whole month. That is the order-dependence, and it is what is refused.
    // Measured: 0 of those 3,534 groups disagree, so this fires on nothing the vendor sends
    // today and guards a change in what it sends. The verdict no longer depends on record order
    // either way.
    //
    // The project deliberately does NOT enter this key. It was tried: the per-series pass below
    // re-groups by (service, region) and applies the same rule, so adding the project changed no
    // input's verdict — an unfalsifiable elaboration, which is worse than nothing because it
    // reads as protection.
    const prior = periods.get(`${from}\u0000${series}`);
    if (prior !== undefined && prior.to !== to) return { failed: "period_conflict" };
    periods.set(`${from}\u0000${series}`, { from, to });
    if (to > lastCoveredEnd) lastCoveredEnd = to;
    currency.observeRequired(record.BillingCurrency);
    if (billed < 0) credited = true;
    if (billed > 0) vendorCharged = true;
    const acc = totals.get(service) ?? { micro: 0, quantity: null, unit: null, charged: false };
    acc.micro += microCentsFromDollars(billed);
    if (billed > 0) acc.charged = true;
    const quantity = num(record.ConsumedQuantity);
    if (quantity !== null) acc.quantity = (acc.quantity ?? 0) + quantity;
    if (acc.unit === null && typeof record.ConsumedUnit === "string" && record.ConsumedUnit) {
      acc.unit = record.ConsumedUnit;
    }
    totals.set(service, acc);
  }

  // NOT A ZERO BILL. A response that said nothing about the window asked for is a response this
  // parser could not use, and the one thing this module may never do is decide that means
  // nothing was spent.
  if (inWindow === 0) return { failed: "unrecognised_shape" };

  // DAY COVERAGE. Refusing a MALFORMED line caught a stream that broke mid-record and nothing
  // else: a body that stops cleanly after day fifteen of a finished month is syntactically
  // perfect, and the replacement below would publish those fifteen days as the month. The
  // vendor's granularity is one day, so the days it should have covered are computable — and a
  // prefix is exactly what a partial read looks like from here.
  // EVERY DAY, NOT JUST THE LAST ONE, and CONTIGUOUSLY. Checking only the maximum start accepted
  // a response that reached the final day while omitting the first, or the fifteenth — a month
  // with a hole in it, published as the month. Contiguity is each period ENDING where the next
  // BEGINS, rather than a fixed stride, so a daylight-saving day of 23 or 25 hours is covered
  // without this code needing to know the vendor's timezone — see the note above.
  // Contiguity PER SERIES. A merged set hid a short record behind a full-length one from another
  // series that happened to share its start; each series is now walked on its own, so a 23-hour
  // record leaves a gap in its own run and is caught wherever the other series sit.
  // Contiguity PER SERIES, a series being one (service, region). A merged set hid a short record
  // behind a full-length one from another series that happened to share its start.
  //
  // ── WHY THERE IS NO SECOND, PER-SERVICE PASS OVER THE UNION OF ITS REGIONS ────────────────
  //
  // There was one once; it was deleted in an earlier round for a BAD REASON — that mutating it
  // away left every test green — and a review then produced the case it was supposed to catch:
  // `Build/fra1` on day 1, no Build on day 2, `Build/iad1` on day 3, where both region series
  // are trivially contiguous and only the union over the service sees the hole. Green under
  // mutation had meant NO FIXTURE COVERED THE PROPERTY, not that no property was there.
  //
  // It is not being restored, and this time the reason is an argument rather than an absence.
  // With the per-series TRAILING EDGE below in place, every series must be contiguous AND must
  // reach `lastBillable`. Intervals that are each contiguous and all end at the same instant
  // have a union that is a single interval: it cannot contain a hole. So no input can
  // distinguish the two checks — the union pass could not be made to fail while the trailing
  // edge holds, and a guard nobody can make fail is not a guard.
  //
  // That claim is falsifiable, which is the difference: delete the trailing-edge loop and the
  // region-migration case below goes red. The fixture is kept for exactly that reason.
  const bySeries = new Map<string, Map<number, number>>();
  for (const [key, period] of periods) {
    const series = key.slice(key.indexOf("\u0000") + 1);
    let run = bySeries.get(series);
    if (run === undefined) {
      run = new Map<number, number>();
      bySeries.set(series, run);
    }
    run.set(period.from, period.to);
  }
  for (const run of bySeries.values()) {
    const days = [...run.entries()].sort((a, b) => a[0] - b[0]);
    for (let d = 1; d < days.length; d += 1) {
      if (days[d - 1]![1] !== days[d]![0]) return { failed: "day_coverage_short" };
    }
  }
  const covered = [...periods.values()].sort((a, b) => a.from - b.from);
  // THE LEADING EDGE, WHEN THE DATABASE PROVES THE ACCOUNT EXISTED — see `PlatformCostWindow`.
  if (window.requireFullStart && covered[0]!.from >= window.start.getTime() + CHARGES_DAY_MS) {
    return { failed: "day_coverage_short" };
  }
  // ── AND NEVER OTHERWISE, BECAUSE OF THE LIVE DATA ────────────────────────────────────────
  //
  // A first version of this required the run to begin within the window's first day, by the same
  // argument as the trailing edge. Measured 2026-09-05 against the live account, it REFUSED July
  // outright: the stream begins on 2026-07-14T07:00Z with no interior gap, because the account
  // did not exist before the 14th. There was nothing wrong with that month and nothing this code
  // could have done about it — the guard was asking the vendor to report days that never
  // happened, and would have kept a real month permanently unmeasurable.
  //
  // The asymmetry is not arbitrary. A truncated read loses the END of a stream, never the
  // beginning, so a late first day is evidence about when the account started and a missing last
  // day is evidence the answer is short. Interior contiguity still catches a hole in the middle.
  // The trailing edge, compared by the period's own END rather than against UTC midnight — the
  // comparison that let a closed September ending on the 29th at 07:00Z pass, because
  // `29th + 24h` is the 30th at 07:00Z and that is after the 30th at 00:00Z. What must hold is
  // that the last period reported ENDS at or after the last instant that could have been billed:
  // the window's own end for a month that is over, or the start of today for one in progress.
  const lastBillable = Math.min(
    window.end.getTime(),
    Math.floor(asOf.getTime() / CHARGES_DAY_MS) * CHARGES_DAY_MS,
  );
  if (lastCoveredEnd < lastBillable) return { failed: "day_coverage_short" };

  // ── AND THE TRAILING EDGE PER SERIES, BECAUSE A GLOBAL ONE IS SATISFIED BY ANY SERIES ─────
  //
  // `lastCoveredEnd` is the maximum over every series, so one series reaching the end of the
  // month satisfied it for all of them. `Build/iad1` present through the 29th and absent on the
  // 30th, while `Pro/fra1` reaches month end: every run internally contiguous, the global edge
  // met, and the parser returned a total missing Build's last day — written fresh, with
  // `source = 'api'`, which says the vendor was asked and this is the answer. That is the one
  // thing this module may never do.
  //
  // Each series must therefore reach the last billable instant on its own.
  //
  // THIS IS THE CHECK THAT LOOKS LIKE THE LEADING-EDGE MISTAKE, so it was measured before it was
  // written. The leading-edge version of this argument refused all of July, because the account
  // did not exist before the 14th and the guard was demanding days that never happened. Here,
  // over 39,773 live August records: 665 (service, region) series, ALL present on all 31 days —
  // zero terminating early, zero interior gaps. The guard refuses nothing the vendor really
  // sends. A service that genuinely stops mid-month WOULD be refused, and that is the residual
  // cost of the rule: the month is then reported unmeasured with a reason, which is a state the
  // board can render, rather than published short, which is a number nobody can tell is wrong.
  for (const run of bySeries.values()) {
    let seriesEnd = 0;
    for (const to of run.values()) if (to > seriesEnd) seriesEnd = to;
    if (seriesEnd < lastBillable) return { failed: "day_coverage_short" };
  }

  const resolved = currency.resolve();
  if (typeof resolved !== "string") return resolved;

  // ── A CREDIT COSTS THE BREAKDOWN, NOT THE FIGURE ────────────────────────────────────────
  //
  // `cost_cents` is a non-negative integer (the migration's CHECK), so a month containing a
  // credit cannot be written as a per-service breakdown: clamping the credited service to zero
  // reports $100 for a month that was $100 of usage and a $5 credit. The provider gets ONE row
  // carrying the month's NET instead. The total is then right, the detail is gone, and the metric
  // name says which of the two you are looking at — the breakdown is what is given up, because a
  // figure that is wrong is worth less than a figure with no detail.
  if (credited) {
    const netMicro = [...totals.values()].reduce((sum, t) => sum + t.micro, 0);
    // A month whose credits outweigh its charges is REFUSED rather than floored: `$0.00` written
    // as a measurement would say the vendor charged nothing, and the vendor said it owed us. The
    // sign is tested on the UNROUNDED total, because `Math.round(-0.004 * 100)` is negative zero
    // and `-0 < 0` is false — rounding first would let a small credit through as a measured zero.
    if (netMicro < 0) return { failed: "negative_total" };
    const net = centsFromMicroCents(netMicro);
    return {
      rows: [{
        provider: "vercel", metric: TOTAL_METRIC,
        periodStart: window.start, periodEnd: window.end,
        value: null, unit: null, costCents: net, currency: resolved,
        charged: vendorCharged && netMicro >= 0,
      }],
    };
  }

  // ── ROUNDING ONCE, AT THE TOTAL, THEN ALLOCATING ────────────────────────────────────────
  //
  // Rounding each service on its own loses the invoice's cent: three separate services at
  // $0.004 are three zero-cent rows and a provider total of nothing, where the bill says one
  // cent. The month's total is therefore rounded ONCE and the difference handed to the largest
  // service, so the rows always sum to the figure the board renders and no cent is invented or
  // lost. The arithmetic runs in INTEGER TENTHS-OF-A-CENT rather than on the dollar floats:
  // `Math.round(1.005 * 100)` is 100 because the float is really 1.00499…, which silently
  // shortchanges a legitimate charge by a cent every time it appears.
  const providerCents = centsFromMicroCents(
    [...totals.values()].reduce((sum, t) => sum + t.micro, 0),
  );
  // The services that were actually used, in one order, so the allocation below can be indexed.
  const used = [...totals.entries()].filter(([, acc]) => acc.micro !== 0 || acc.charged);
  const allocation = allocateCents(providerCents, used.map(([, acc]) => acc.micro));

  // ── A SERVICE THAT CANNOT CARRY A CENT GETS NO LINE, RATHER THAN A LINE SAYING ZERO ─────
  //
  // Allocation makes the rows sum to the provider's total exactly, and for services whose share
  // rounds below a cent it does that by handing them ZERO — three services at $0.004 become
  // `[1, 0, 0]`. Two of those rows say a vendor that charged them charged nothing, with
  // `source = 'api'` and a fresh stamp: the module's forbidden sentence, produced by the fix for
  // the previous version of it.
  //
  // The first answer here was to abandon the breakdown entirely and publish one total row, and
  // that was far too blunt — measured against the live account, a nine-service month collapsed
  // to a single line because one service had charged a hundredth of a cent. What is actually
  // unpublishable is the ZERO LINE, not the breakdown: a service allocated no cents contributed
  // no cents, so omitting it costs the reader nothing and the remaining rows still sum to the
  // provider's total exactly. The total is never short and no line ever lies.
  //
  // `writeMeasuredRows` refuses a charged zero outright, so this is enforced downstream as well
  // as chosen here.
  const rows: PlatformCostRow[] = [];
  for (const [i, [metric, acc]] of used.entries()) {
    if ((allocation[i] ?? 0) === 0 && acc.charged) continue;
    // A service the account has never touched contributes an exact 0 on every day in the range —
    // fifty-five of the sixty-five service names in a live response are that. Writing them would
    // fill the table with rows that say nothing. A SUB-CENT service (`0.0001` USD) is NOT this
    // case: it is DROPPED rather than written at zero, because a fresh `source='api'` row
    // saying zero for a line the vendor charged is this module's forbidden sentence. Its cents
    // are not lost — the allocation gives them to the lines that can carry them, so the rows
    // still sum to the provider's total. (This said "is written, at zero cents" until 2026-09-06,
    // describing the behaviour the round before last removed.)
    //
    // Rounding is per service and that is inherent rather than a choice: the row IS the service
    // and the column is integer cents, so three separate $0.004 services are three zero-cent
    // rows. The alternative is to stop storing a breakdown at all, which costs more than the
    // half-cent it saves.
    rows.push({
      provider: "vercel", metric,
      periodStart: window.start, periodEnd: window.end,
      value: acc.quantity, unit: acc.unit,
      // From the allocation, never from this service's own rounding: the rows must sum to
      // `providerCents` exactly, which per-service rounding could not promise in either
      // direction. See `allocateCents`.
      costCents: allocation[i] ?? 0,
      currency: resolved,
      charged: acc.charged,
    });
  }

  // In-window records, and every one of them zero: a real month in which nothing was charged.
  // It gets a row that SAYS zero — the distinction the whole module is built on — under a metric
  // name that is the vendor's own word for the response rather than a service that was invented.
  if (rows.length === 0) {
    rows.push({
      provider: "vercel", metric: TOTAL_METRIC,
      periodStart: window.start, periodEnd: window.end,
      // The vendor answered and its answer was nothing — `charged: false` is what makes this
      // zero legal at the writer, and the only kind of zero that is.
      // `charged` is what the VENDOR said, not what rounding produced: if any amount in the
      // window was positive this cannot be a legal zero, and the writer will refuse it.
      value: null, unit: null, costCents: 0, currency: resolved, charged: vendorCharged,
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
 * `amount` is a STRING OF CENTS in that report (`"70.7614"` is seventy-one cents, not seventy
 * dollars — the vendor's words are *"decimal strings in lowest units (cents)"*), so it is parsed
 * digit-by-digit rather than read as a number, and a value that cannot be read exactly refuses
 * the whole report rather than being skipped.
 *
 * This sentence said "dollars" until 2026-09-06, directly above the code that had been corrected
 * to treat it as cents — a comment stating the opposite of its own function, which is how the
 * original hundredfold error would have been re-introduced by the next person to trust it.
 */
function parseAnthropic(
  buckets: unknown[], window: PlatformCostWindow, asOf: Date,
): PlatformCostFetch {
  // MICRO-CENTS, parsed from the decimal strings with no floating-point step — see the module
  // header for why these are cents and not dollars, and what that assumption cost. Summed as
  // integers and rounded ONCE at the end: the recorded live month is
  // 70.7614 + 10.3029 + 4.812 = 85.8763 cents → 86.
  let micro = 0;
  // See `parseVercelCharges`: provenance from what the vendor said, before rounding.
  let vendorCharged = false;
  const currency = new Currency();
  // The bucket STARTS that landed inside the window, for the continuity check below.
  const starts: number[] = [];

  for (const raw of buckets) {
    const bucket = raw as Record<string, unknown> | null;
    // MALFORMED IS `failed`, NOT SKIPPED — and this is the reversal round two asked for. The
    // guard used to `continue` past a bucket it did not recognise and only refuse when NOTHING
    // was readable, so one good $5 bucket beside a malformed one published $5 as the whole
    // month: a partial total in the typeface of a complete one, which is the same defect the
    // Vercel side already refuses. A report is one answer; a piece of it missing makes the
    // answer wrong rather than shorter.
    if (!bucket || typeof bucket !== "object") return { failed: "unrecognised_shape" };
    const from = instantMs(bucket.starting_at);
    const to = instantMs(bucket.ending_at);
    if (from === null || to === null || !Array.isArray(bucket.results)) {
      return { failed: "unrecognised_shape" };
    }
    // `bucket_width=1d` was asked for, so a bucket that spans anything else is not the answer to
    // the question. `to > from` alone let a one-hour bucket satisfy a day of coverage.
    if (to - from !== ANTHROPIC_BUCKET_MS) return { failed: "unrecognised_shape" };
    // ALIGNED TO THE UTC DAY, not merely a day long. Thirty noon-to-noon buckets running from
    // 1 September to 1 October are each 24 hours, are contiguous, and reach both edges — and they
    // omit September's first twelve hours while including October's. A duration check alone
    // cannot see that; the offset can.
    if (from % ANTHROPIC_BUCKET_MS !== 0) return { failed: "unrecognised_shape" };
    // A bucket the caller did not ask about is not summed into the month it did ask about. The
    // timestamps were decorative before this line: a report that answered with a neighbouring
    // month's day would have had it added to the total.
    if (from < window.start.getTime() || from >= window.end.getTime()) continue;
    starts.push(from);
    for (const r of bucket.results as Array<Record<string, unknown>>) {
      // The vendor sends a STRING, so it is parsed exactly. A number is accepted too and scaled
      // the same way, for a response shape that has not been seen but would be readable.
      const amount = typeof r?.amount === "string"
        ? microCentsFromDecimalString(r.amount)
        : (num(r?.amount) === null ? null : Math.round(num(r?.amount)! * MICRO_CENTS_PER_CENT));
      // Same rule one level down: a result this parser cannot read is money it cannot account
      // for, so the report is refused rather than summed around.
      if (amount === null) return { failed: "unrecognised_shape" };
      micro += amount;
      if (amount > 0) vendorCharged = true;
      currency.observeRequired(r?.currency);
    }
  }

  // No bucket of the shape this parser knows, inside the window it asked about ⇒ a report it
  // cannot read. NOT a zero: the one thing this module may never do is decide that an answer it
  // could not use means nothing was spent.
  if (starts.length === 0) return { failed: "unrecognised_shape" };

  // CONTINUITY, AT BOTH ENDS AS WELL AS IN THE MIDDLE. Quiet days are represented by explicit
  // EMPTY buckets — a live August report carries two — so a day that is simply ABSENT is data
  // this walk did not receive, not a day that cost nothing.
  //
  // Stepping the returned starts catches an INTERIOR omission and nothing else, which was the
  // hole: a report that answered days 2–30, or 1–15 of a month that has ended, is internally
  // consecutive and passes. So the run is also required to REACH THE WINDOW'S OWN EDGES —
  // the first expected day, and the last day that can already have been billed.
  starts.sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i]! - starts[i - 1]! !== ANTHROPIC_BUCKET_MS) return { failed: "bucket_gap" };
  }
  if (window.requireFullStart && starts[0]! !== window.start.getTime()) {
    return { failed: "bucket_gap" };
  }
  // Only when the database proves the account existed — see `parseVercelCharges` at length: an
  // organization created mid-month has no buckets before it existed, and requiring them would
  // make that month permanently unmeasurable. Interior contiguity and the trailing edge are what
  // a short answer actually looks like.
  // The last day the vendor can be REQUIRED to have reported: the last day that has fully
  // CLOSED, or the window's own last day for a month that has ended — whichever is earlier.
  //
  // Yesterday rather than today, measured: a report asked on 4 September returned buckets for
  // the 1st, 2nd and 3rd and none for the 4th. Requiring today's partial bucket would refuse
  // every open month for the hours before the vendor writes it, which is a false `bucket_gap` on
  // a healthy provider — and this check must only ever fire on data that is genuinely missing.
  const lastExpected = Math.min(
    window.end.getTime() - ANTHROPIC_BUCKET_MS,
    Math.floor(asOf.getTime() / ANTHROPIC_BUCKET_MS) * ANTHROPIC_BUCKET_MS - ANTHROPIC_BUCKET_MS,
  );
  if (starts[starts.length - 1]! < lastExpected) return { failed: "bucket_gap" };

  const resolved = currency.resolve();
  if (typeof resolved !== "string") return resolved;
  // THE SIGN IS TESTED BEFORE THE ROUNDING, and the ordering is the guard rather than a detail:
  // `Math.round(-0.4)` is NEGATIVE ZERO and `-0 < 0` is false, so a small credit balance rounded
  // first slips past the refusal below and is written as a measured $0.00 — the false zero this
  // check exists to prevent, reintroduced by the rounding meant to satisfy the column.
  if (micro < 0) return { failed: "negative_total" };
  const rounded = centsFromMicroCents(micro);
  // A NET-NEGATIVE MONTH IS REFUSED, not floored. Flooring was the previous answer and it
  // publishes `$0.00` as a MEASUREMENT for a month in which the vendor said it owed us money —
  // "a zero on this board is only ever a row that says zero, written because a vendor said
  // zero", and the vendor did not say zero. `cost_cents` cannot hold the real figure, so the
  // honest outcome is the one the union already has for an answer that cannot be stored: nothing
  // written, the previous row standing, and the board saying so.
  return {
    rows: [{
      provider: "anthropic", metric: "tokens",
      periodStart: window.start, periodEnd: window.end,
      value: null, unit: null, costCents: rounded, currency: resolved,
      charged: vendorCharged,
    }],
  };
}

/**
 * ── THE ONE PLACE `platform_costs` IS WRITTEN WITH `source = 'api'` ─────────────────────
 *
 * Every measured row in this system passes through here, and the module's standing invariant is
 * enforced HERE rather than in each parser, because a rule spread across two parsers is a rule
 * that holds until somebody writes a third:
 *
 *     A ZERO WITH `source = 'api'` AND A FRESH STAMP MEANS THE VENDOR SAID ZERO.
 *
 * The write is REFUSED when a row says zero for a line the vendor charged for. That is not a
 * hypothetical: the previous round's own fix produced it. Three services at $0.004 each give a
 * provider total of one cent, largest-remainder allocation hands it out as `[1, 0, 0]`, and two
 * rows then say a vendor that charged them charged nothing. The caller's answer is to stop
 * claiming a breakdown it cannot make honestly and write the provider's total as one row —
 * `parseVercelCharges` does exactly that before it ever reaches this function, and this refusal
 * is what makes the omission impossible rather than merely intended.
 *
 * A census (`platform-cost-write-census.test.ts`) asserts no other `insert`/`update` into the
 * table exists outside this function and `recordManualPlatformCost`, so the guard cannot be
 * bypassed by a new caller that simply did not know about it.
 */
export async function writeMeasuredRows(
  t: Tx, provider: CostProvider, window: { start: Date; end: Date },
  rows: PlatformCostRow[], at: Date,
): Promise<void> {
  // THE GUARD FAILS CLOSED. `charged` is a required boolean at the type, and checked again here
  // at runtime: a row reaching this function with it UNDEFINED used to skip the refusal
  // entirely, because `undefined && …` is falsy — a guard that waves through exactly the rows
  // whose provenance nobody stated. The type stops a caller in this repository; the check stops
  // one that came through a cast, a fixture, or a future boundary the type does not cross.
  for (const row of rows) {
    if (typeof row.charged !== "boolean") {
      throw new ZeroForChargedLine(`${provider}:${row.metric}:charged_unstated`);
    }
    if (row.charged && row.costCents === 0) {
      throw new ZeroForChargedLine(`${provider}:${row.metric}`);
    }
    if (row.costCents < 0) throw new ZeroForChargedLine(`${provider}:${row.metric}:negative`);
  }
  // ONE TOTAL KEY PER PROVIDER-MONTH, refused rather than summed. Two names for one figure is two
  // primary keys for it, and `costsForMonth` adds rows it cannot tell apart — a $23 month
  // rendered as $46. A response carrying both a breakdown and a total, or two total spellings, is
  // not a month this schema can hold.
  const totals = rows.filter((r) => isTotalMetric(r.metric));
  if (totals.length > 1 || (totals.length === 1 && rows.length > 1)) {
    throw new ZeroForChargedLine(`${provider}:two_total_keys`);
  }
  await t.delete(platformCosts).where(and(
    eq(platformCosts.provider, provider),
    eq(platformCosts.periodStart, window.start),
    eq(platformCosts.periodEnd, window.end),
    eq(platformCosts.source, "api"),
  ));
  for (const row of rows) {
    await t.insert(platformCosts).values({
      provider: row.provider,
      metric: row.metric,
      // THE WINDOW, NOT THE ROW'S OWN DATES. The DELETE above clears the window this pass was
      // asked about, and inserting on a row's own period would write outside what was cleared —
      // leaving the previous row for that period standing beside the new one under a different
      // key. Every row of a pass belongs to the window the pass asked for, and the parsers stamp
      // them that way; this makes the two impossible to disagree.
      periodStart: window.start,
      periodEnd: window.end,
      value: row.value === null ? null : String(row.value),
      unit: row.unit,
      costCents: row.costCents,
      currency: row.currency,
      source: "api",
      fetchedAt: at,
    }).onConflictDoUpdate({
      // Kept although the DELETE above has already cleared this provider's API rows for the
      // window: a response carrying the same metric twice would otherwise abort the whole
      // provider on a primary-key collision, and the second line is the vendor's own correction.
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
}

/**
 * Thrown by {@link recordManualPlatformCost} when the figure being entered belongs to a different
 * SHAPE from the one this provider-month already holds — a total against a breakdown, or the
 * reverse. Surfaced as a refusal rather than stored and then filtered out of the reader.
 */
export class ManualCostShapeConflict extends Error {}

/** Thrown by {@link writeMeasuredRows} when a row would say zero for a line the vendor charged. */
export class ZeroForChargedLine extends Error {}

/** What one pass did, per provider. Codes only — never a vendor's message text. */
export interface PlatformCostPassReport {
  ranAt: Date;
  providers: Array<{
    provider: CostProvider;
    /**
     * `deferred` is work the pass did not START, because the budget ran out. It is not a
     * failure: nobody asked the vendor, so nothing is known and nothing is written. The next
     * invocation begins with the window this one ran out on.
     */
    outcome: "written" | "unconfigured" | "failed" | "deferred";
    rows: number;
    /** A closed code on `failed` — see {@link PlatformCostFailure}. Never a vendor's own text. */
    code?: PlatformCostFailure;
  }>;
}

/**
 * How long one pass may spend before it stops STARTING work.
 *
 * The catch-all route this runs behind allows 60 seconds. One fetch is allowed 15, a paged
 * Anthropic walk up to twelve of them, and windows and providers are sequential — so the
 * arithmetic reached 180 seconds for a single provider/window and the platform would kill the
 * invocation mid-pass. A killed invocation reports nothing at all: no rows, no failure, no
 * record that the vendor was asked, which is the state this module exists to make impossible.
 *
 * Below 60 with room for the database work on either side. The budget stops the pass from
 * BEGINNING another request, never from finishing one — a half-read response is exactly the
 * thing the coverage rules refuse, and cutting one short to save time would be self-defeating.
 */
const PASS_BUDGET_MS = 45_000;

export interface PlatformCostPassOptions {
  port: PlatformCostPort;
  now?: () => Date;
  /** Overrides {@link PASS_BUDGET_MS}; a test uses it to make the deadline observable. */
  budgetMs?: number;
  /** Monotonic clock for the budget only. Injected so a test need not sleep. */
  elapsed?: () => number;
  /** Which providers to ask. Defaults to {@link API_COST_PROVIDERS}, the two with adapters. */
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
  const report: PlatformCostPassReport = { ranAt: at, providers: [] };

  const budgetMs = opts.budgetMs ?? PASS_BUDGET_MS;
  // A MONOTONIC clock, not `opts.now`. `now` is the pass's business clock and tests move it by
  // whole days; a budget measured on it would expire instantly in every fixture that does.
  const startedAt = opts.elapsed ? opts.elapsed() : Date.now();
  const elapsed = (): number => (opts.elapsed ? opts.elapsed() : Date.now()) - startedAt;
  const windows = await passWindows(tx, at, opts.providers ?? API_COST_PROVIDERS);
  for (const window of windows) {
    const { start, end } = window;
  for (const provider of opts.providers ?? API_COST_PROVIDERS) {
    // THE BUDGET IS CHECKED BEFORE ASKING, NEVER AFTER. Past it, the remaining providers and
    // windows are reported as deferred and the invocation returns while it still can: a report
    // that names what was not attempted is worth more than a process killed mid-request, which
    // names nothing. The open month is first in `windows`, so what gets deferred under pressure
    // is the closed month being re-asked for settlement, which has all month to settle.
    // RESERVING WHAT THE NEXT REQUEST COULD COST, not merely counting what is spent. "Am I past
    // the budget?" still allows a request to BEGIN at 44.9 seconds and run for another 25, which
    // is the same overrun with an extra check in front of it. The reserve is the longest a
    // single provider's turn can take — the paged walk's own ceiling.
    if (elapsed() + ANTHROPIC_WALK_BUDGET_MS > budgetMs) {
      report.providers.push({ provider, outcome: "deferred", rows: 0 });
      continue;
    }
    let result: PlatformCostFetch;
    try {
      // The flag is resolved for THIS provider — see `PassWindow`.
      result = await opts.port.fetch(provider, {
        start, end, requireFullStart: window.requireFullStart(provider),
      });
    } catch (err) {
      // A port that THROWS is a port that failed; the union exists so it does not have to, and
      // this is the belt to that. The class only — never the message.
      result = { failed: "transport" };
    }

    if ("unconfigured" in result) {
      // NOTHING IS WRITTEN. Not a zero, not a placeholder, not a null-cost row. The absence of a
      // row IS the state, and the DTO turns it into `cents: null` + `source: 'unconfigured'`.
      report.providers.push({ provider, outcome: "unconfigured", rows: 0 });
      continue;
    }
    // AN EMPTY SUCCESS IS A FAILURE. The union permits `{ rows: [] }`, and letting it through
    // would run the replacement below — deleting the month's real measurement, inserting
    // nothing, and reporting `written` — after which the board says "not configured" for a
    // provider that had been measured an hour earlier. No adapter here can produce it (both
    // answer at least one row or a code), so this guards the seam rather than a caller.
    if ("rows" in result && result.rows.length === 0) {
      report.providers.push({ provider, outcome: "failed", rows: 0, code: "empty_response" });
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
    // case, since `parseVercelCharges` accepts any finite line amount and a discount or
    // credit line in a vendor's response is a negative one — and before this guard existed, that
    // one bad row aborted the WHOLE PASS: the insert threw, nothing caught it, and every provider
    // later in this loop was never asked, while any providers already written this run stayed
    // committed. A write failure is recorded exactly like a parse failure: nothing for THIS
    // provider, the previous row stands, and the loop continues.
    try {
      // ONE TRANSACTION PER PROVIDER, and it opens with a DELETE. Both halves answer a defect
      // the previous shape had, and both are about a figure that is wrong rather than missing.
      //
      // THE DELETE. A successful measurement REPLACES this provider's API rows for the window;
      // it does not merge into them. Upserting alone left behind any metric the vendor no longer
      // reports — a service whose charge was revised down to nothing, or renamed — and
      // `costsForMonth` SUMS a provider's metrics, so a stale row was added to a current one and
      // the total carried the newest row's timestamp. The board then showed an overstatement
      // labelled "measured". The parser's own skip of exact-zero services made it likelier, not
      // less: a service that stops costing money is exactly the case that leaves a row nobody
      // overwrites. `source` is in the predicate, so a MANUAL row for the same window is
      // untouched — the operator's figure outranks the API's and must survive its refresh.
      //
      // THE TRANSACTION. The rows were written one statement at a time, so a row the database
      // refused left every row before it committed while the pass reported `failed` for the
      // provider — a half-written month presented as an unwritten one, which is the worst of
      // both readings. All of it lands or none of it does.
      await tx.transaction(async (t) => {
        // ONE WRITER PER (PROVIDER, WINDOW), serialized by the database rather than by hoping.
        // Two passes overlapping — a manual trigger beside the clock, or two replicas — could
        // both run their DELETE before either INSERT landed, after which one pass's per-service
        // rows and the other's net row both survive (different primary keys) and the month read
        // SUMS them into a doubled total wearing a fresh timestamp. A transaction-scoped
        // advisory lock makes the second pass wait for the first to commit; it is released with
        // the transaction, so a crash cannot strand it.
        await t.execute(sql`select pg_advisory_xact_lock(
          hashtext(${`platform_costs:${provider}:${start.toISOString()}`}))`);
        // THE FENCE. The lock serializes writers and says nothing about WHICH is newer. A pass
        // that stalls on a slow vendor and arrives afterwards would delete the newer rows and
        // write its own older snapshot — a regression that looks exactly like a measurement.
        //
        // `>=` ON THE STAMP, not `>`: two passes can share a millisecond, and with `>` both
        // proceed and the later-committing one wins by luck. `>=` fences a pass out against
        // anything not strictly older than itself, so a tie resolves to whichever committed
        // first rather than to whichever committed last.
        //
        // IT DOES NOT SURVIVE A CLOCK THAT MOVES BACKWARDS, and a version of this comment
        // claimed it did. If the host clock jumps forward and is corrected, the row carries the
        // future stamp and every later pass is fenced out until wall time catches up — the row
        // freezes, and `costsForMonth`'s age arithmetic reads the negative age as current rather
        // than stale. Closing that needs a monotonic sequence stored beside the stamp, which is
        // a column this table does not have; it is recorded here as a known limit rather than
        // described as handled.
        const newer = await t.select({ at: platformCosts.fetchedAt })
          .from(platformCosts)
          .where(and(
            eq(platformCosts.provider, provider),
            eq(platformCosts.periodStart, start),
            eq(platformCosts.periodEnd, end),
            eq(platformCosts.source, "api"),
            gte(platformCosts.fetchedAt, at),
          ))
          .limit(1);
        if (newer.length > 0) throw new StalePass();
        await writeMeasuredRows(t as unknown as Tx, provider, { start, end }, result.rows, at);
      });
      report.providers.push({ provider, outcome: "written", rows: result.rows.length });
    } catch (err) {
      // A pass that found a newer one had already written this window is not a write FAILURE —
      // nothing is wrong, and the row standing is the better of the two. It is reported as its
      // own outcome so an operator reading the log can tell "we were overtaken" from "the
      // database refused the rows".
      report.providers.push({
        provider, outcome: "failed", rows: 0,
        code: err instanceof StalePass ? "stale_pass" : "write",
      });
    }
  }
  }
  return report;
}

/**
 * The windows one pass measures: the OPEN month, and the month before it while it is still
 * settling.
 *
 * ── WHY THE PREVIOUS MONTH IS ASKED AT ALL ────────────────────────────────────────────────
 *
 * A pass that only ever asked about the month it was in could never finish one. A vendor's last
 * charge bucket for September runs to `2026-10-01T07:00Z`, so the final September pass — which
 * by definition runs before midnight UTC — reads that bucket PART-ACCRUED, and from `00:00Z`
 * every subsequent pass asks about October and filters September's last bucket out. September's
 * stored total then stays permanently short by part of its own last day, and nothing ever
 * revisits it. The board's closed months would each be quietly missing their tail, for ever, and
 * no failure would be reported: every pass succeeded.
 *
 * So the pass re-asks the previous month until it has settled. Two days of grace covers the
 * widest billing-timezone offset several times over and is cheap — the closed month's answer
 * stops changing, so the second day's write is the same rows with a newer `fetched_at`.
 *
 * A closed month is asked SECOND, deliberately. The open month is what the board projects from
 * and the invocation has a platform deadline; if only one of the two can finish, it must be the
 * one somebody is looking at.
 */
/**
 * How long a closed month may go unsettled before the pass gives up asking.
 *
 * A CEILING, not the schedule: the re-ask stops when the month is SETTLED, and this only stops
 * it asking for ever when a vendor never answers. Seven days is far past any billing lag either
 * vendor has shown and still bounded.
 */
/**
 * How long past a month's own end a reading must be taken before it can SETTLE that month.
 *
 * ── A DECLARED END IS A PROMISE, NOT EVIDENCE ────────────────────────────────────────────
 *
 * Settlement used to be "an api row stamped at or after the month's end", and that is satisfiable
 * before the month has actually finished billing. Vercel's final September charge period DECLARES
 * that it ends at `2026-10-01T07:00Z`; a poll at `00:09Z` on 1 October returns that period,
 * carrying nine minutes of it, and the row it writes is stamped after the calendar month ended.
 * The month was then marked finished and never re-read — permanently short by most of its last
 * day, with every pass reporting success.
 *
 * A day past the month's end clears the widest billing-timezone offset either vendor uses (seven
 * hours) with most of a day to spare for indexing lag. The alternative evidence — a reading of the
 * NEXT month that already carries data, which can only exist once the vendor has moved on — is
 * accepted too, and is what settles a month whose own final poll was late.
 */
export const SETTLE_LAG_MS = 24 * 60 * 60 * 1000;

/**
 * How long a closed month is re-asked on EVERY pass before the re-ask drops to once a day.
 *
 * NOT AN ABANDONMENT. A seven-day ceiling stood here and it threw the month away: if every
 * post-close request failed until the ceiling, the last pre-close part-accrued figure was left
 * standing for ever and nothing asked again. A figure nobody can refresh is what `stale` is FOR —
 * the board already says so — and giving up on it is the one thing that makes the staleness
 * unrecoverable. So past this the month is asked ONCE A DAY rather than on every pass, and the
 * asking does not stop.
 *
 * WHAT SETTLES IT is one signal and not two: an `api` row for the month stamped `SETTLE_LAG_MS`
 * past its end. There is no "the next month already has data" query — that was described here
 * before it was written, and it was never written.
 */
export const CLOSED_MONTH_EAGER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Which windows this pass measures, in the order it measures them.
 *
 * The CLOSED month comes first while it is unsettled. The open month is asked again in six hours;
 * the closed one has to be finished, and both providers' open-month requests can spend the whole
 * 60-second invocation between them — so ordering the settling month last is ordering it to be
 * dropped, silently, with the pass reporting success.
 */
interface PassWindow {
  start: Date;
  end: Date;
  /** Per PROVIDER — one vendor's history says nothing about another's inception. */
  requireFullStart: (p: CostProvider) => boolean;
}

async function passWindows(
  tx: Tx, at: Date, providers: readonly CostProvider[],
): Promise<PassWindow[]> {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  const prev = {
    start: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1)),
    end: start,
  };

  // ── THE LEADING EDGE IS REQUIRED WHEN THE ACCOUNT DEMONSTRABLY EXISTED ───────────────────
  //
  // A stream that begins mid-window is either an account that did not exist yet or an answer
  // missing its first days, and the stream alone cannot separate them: a live July returns
  // eighteen periods from the 14th because the account was created then, and refusing that would
  // make a real month permanently unmeasurable. But the DATABASE can separate them. An `api` row
  // for an EARLIER month is proof the account was already billing, and from then on a late first
  // day is a short answer rather than an inception.
  //
  // TWO THINGS THIS GOT WRONG AND BOTH ARE FIXED HERE.
  //
  // The comparison was against `prev.start` for BOTH windows, so while measuring September it
  // looked for rows before AUGUST — and a complete August row, which is exactly the proof the
  // account was billing, did not count. A September response beginning on the 2nd then passed as
  // the whole month. Each window asks about ITS OWN start now.
  //
  // And it was one flag for every provider (`providers.some(...)`), so one vendor's history
  // demanded a first day from a DIFFERENT vendor whose account legitimately started mid-month —
  // rejecting that vendor's inception month and writing no measurement for it at all. It is per
  // provider, which is the only scope the evidence actually covers.
  const earlierRows = await tx
    .select({ provider: platformCosts.provider, periodStart: platformCosts.periodStart })
    .from(platformCosts)
    .where(and(eq(platformCosts.source, "api"), lt(platformCosts.periodStart, start)));
  /** Providers with an `api` row for a month strictly before `windowStart`. */
  const establishedFor = (windowStart: Date): Set<CostProvider> =>
    new Set(earlierRows
      .filter((r) => r.periodStart < windowStart)
      .map((r) => r.provider as CostProvider));

  // SETTLED IS EVIDENCE: a reading taken a full day past the month's end (so the vendor's own
  // final period has closed and been indexed), or a reading of the NEXT month that already
  // carries data — which can only exist once the vendor has moved on.
  const settledRows = await tx
    .select({ provider: platformCosts.provider })
    .from(platformCosts)
    .where(and(
      eq(platformCosts.periodStart, prev.start),
      eq(platformCosts.periodEnd, prev.end),
      eq(platformCosts.source, "api"),
      gte(platformCosts.fetchedAt, new Date(prev.end.getTime() + SETTLE_LAG_MS)),
    ));
  const settled = new Set(settledRows.map((r) => r.provider));

  const openEstablished = establishedFor(start);
  const openWindow = {
    start, end,
    // Per provider — see above. The pass asks one provider at a time, so the flag it hands the
    // port is that provider's own history.
    requireFullStart: (p: CostProvider): boolean => openEstablished.has(p),
  };
  if (providers.every((p) => settled.has(p))) return [openWindow];

  const sinceClose = at.getTime() - prev.end.getTime();
  // Past the eager window the closed month is asked once a day instead of four times, and NEVER
  // abandoned — see CLOSED_MONTH_EAGER_MS. Four passes a day for ever on a month that will not
  // settle is spend for nothing; stopping is worse.
  const eager = sinceClose < CLOSED_MONTH_EAGER_MS;
  const dailySlot = at.getUTCHours() < 6;
  if (!eager && !dailySlot) return [openWindow];

  const prevEstablished = establishedFor(prev.start);
  // THE OPEN MONTH FIRST. The comment on SETTLE_LAG_MS has always said the closed month is
  // asked second so that a deadline cannot take the window somebody is looking at — and the
  // code returned the closed month first, so under a deadline it took exactly that window. The
  // comment described a safety property the code inverted; this is the code catching up.
  return [
    openWindow,
    {
      ...prev,
      // A month earlier than the one being RE-ASKED is the proof here, per provider.
      requireFullStart: (p: CostProvider): boolean => prevEstablished.has(p),
    },
  ];
}

/** Thrown inside the replacement transaction when a NEWER pass has already written the window. */
class StalePass extends Error {}

/**
 * THE ONE METRIC NAME A PROVIDER-WIDE TOTAL IS EVER STORED UNDER.
 *
 * A provider's month is either a per-service BREAKDOWN or a single TOTAL, and the two are
 * mutually exclusive shapes. There used to be two names for the total — `charges` for a month
 * with nothing to break down, and `charges (net of credits)` for one containing a credit — and
 * two names for one thing is two primary keys for one figure. A hand-entered `charges` row then
 * sat beside an API `charges (net of credits)` row and `costsForMonth` SUMMED them: a $23 month
 * rendered as $46, and the projection scaled the doubled figure.
 *
 * One name. A credited month is not distinguished at all any more: `note` is a MANUAL-row
 * column and `writeMeasuredRows` has no path to it, so an API total carries no mark saying a
 * credit was folded in. That is a real loss of detail and it is recorded here rather than
 * described as handled — an earlier version of this sentence claimed the note carried it.
 * Every writer normalizes to
 * this, and {@link writeMeasuredRows} refuses a second total key for the same provider-month
 * rather than letting one through to be summed.
 */
export const TOTAL_METRIC = "charges";

/**
 * Names that MEANT "this is the provider's whole month" before {@link TOTAL_METRIC} was the only
 * one. Read-side only: rows written under the old name are still in the table, and the family
 * filter has to recognise them as totals or it will sum one with a breakdown.
 */
export const LEGACY_TOTAL_METRICS: readonly string[] = ["charges (net of credits)"];

/** True for any metric that means "the provider's whole month", current or legacy. */
export function isTotalMetric(metric: string): boolean {
  return metric === TOTAL_METRIC || LEGACY_TOTAL_METRICS.includes(metric);
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
  const outer = db as unknown as Tx;
  // ── THE FAMILY GUARD APPLIES HERE TOO, AND A DROPPED WRITE MUST NOT ANSWER OK ───────────
  //
  // The guard lived only on the measured path, so the manual one could produce both defects it
  // was written to prevent. A manual `compute = $20` beside a manual `charges = $30` total for
  // one provider — three providers are manual-only, so this is their ordinary shape — was SUMMED
  // to $50 for a month that cost $30. And a manual TOTAL entered while the API is reporting a
  // BREAKDOWN is filtered out by the family rule on the read, so the operator saw
  // `200 {ok:true}` and the board went on publishing the vendor's figure: a write that was
  // accepted, stored, and then ignored.
  //
  // A row that will not be counted is REFUSED at the moment it is entered, with the reason. The
  // operator can then do the thing that works — correct the line, or replace the whole month —
  // instead of believing a figure that was never going to appear.
  const metricNormalized = isTotalMetric(entry.metric) ? TOTAL_METRIC : entry.metric;
  // ── CHECK AND WRITE IN ONE TRANSACTION, UNDER THE MEASURED WRITER'S OWN LOCK ───────────
  //
  // The guard below reads the month's existing rows and then writes; those were two
  // statements on a bare connection, with `const tx = db as unknown as Tx` — a CAST, which
  // is not a transaction and was easy to read as one. Two entries arriving together both saw
  // an empty month, one inserted a `compute` line and the other a `charges` total, both
  // answered 200, and `costsForMonth` summed them: exactly the shape the guard refuses when
  // it can see it. An API pass changing a provider's shape could race a manual correction the
  // same way and leave the accepted correction filtered out of the read.
  //
  // The lock is the SAME key the measured writer takes, per provider and period, because the
  // two paths write the same rows and a lock only serializes writers that agree on the name.
  await outer.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(
      hashtext(${`platform_costs:${entry.provider}:${entry.periodStart.toISOString()}`}))`);
    const siblings = await tx
      .select({ metric: platformCosts.metric, source: platformCosts.source })
      .from(platformCosts)
      .where(and(
        eq(platformCosts.provider, entry.provider),
        eq(platformCosts.periodStart, entry.periodStart),
        eq(platformCosts.periodEnd, entry.periodEnd),
      ));
    const wantsTotal = isTotalMetric(metricNormalized);
    // What shape is this provider-month already in? The newest API rows decide the family; with no
    // API rows at all, the manual rows themselves do.
    const apiRows = siblings.filter((r) => r.source === "api");
    const deciding = apiRows.length > 0 ? apiRows : siblings;
    const familyIsTotal = deciding.length > 0 && deciding.some((r) => isTotalMetric(r.metric));
    const familyIsBreakdown = deciding.length > 0 && deciding.some((r) => !isTotalMetric(r.metric));
    if (deciding.length > 0 && wantsTotal !== familyIsTotal && !(wantsTotal && !familyIsBreakdown)) {
      throw new ManualCostShapeConflict(
        wantsTotal
          ? "this month is recorded as a per-service breakdown; correct a line, or clear it first"
          : "this month is recorded as a single total; replace the total, or clear it first",
      );
    }
    // NORMALIZED TO THE ONE TOTAL NAME. An operator typing a provider's whole month used to store
    // it under whichever word they were given, so a hand-entered `charges` sat beside an API
    // `charges (net of credits)` and the two were SUMMED — a $23 month rendered as $46. They are
    // one figure and they now share one key, which is what makes the manual row REPLACE the API's
    // total rather than add to it.
    await tx.insert(platformCosts).values({
      provider: entry.provider,
      metric: metricNormalized,
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
  });
}

/** One provider's newest figure, and how it was obtained. The DTO's own vocabulary. */
export interface ProviderCost {
  provider: CostProvider;
  /**
   * The part of {@link cents} that is a FLAT monthly charge — the hand-entered lines.
   *
   * The projection pro-rates usage-to-date and must not pro-rate a fee somebody typed off an
   * invoice: a $20 flat charge entered on day 3 of 30 would project as ~$200. Split per METRIC
   * rather than per provider, because a provider can carry both and classifying the whole of it
   * by one line got both directions wrong.
   */
  flatCents: number;
  /** The oldest API line's stamp — what the scalable half is projected FROM. `null` if none. */
  scalableFetchedAt: Date | null;
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
      // The METRIC, because manual precedence is per line now — see the note below.
      metric: platformCosts.metric,
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
      flatCents: 0, scalableFetchedAt: null,
    });
  }

  // Sum each provider's metrics, per source, then pick. Summing before picking is what makes
  // "Vercel cost $41" a whole answer rather than whichever metric happened to sort first.
  // ── MANUAL PRECEDENCE IS PER LINE, NOT PER PROVIDER ─────────────────────────────────────
  //
  // A manual row used to replace a provider's WHOLE API total. So an operator correcting one
  // line of an invoice — the plan fee from $19 to $20, say — silently discarded every other line
  // the API had measured: `Pro $19 + Functions $5` became `$20`, not `$25`, and the board called
  // it "entered manually" as though a person had checked the whole bill. Precedence now applies
  // where the disagreement is, which is the METRIC: the operator's `Pro` replaces the API's
  // `Pro`, and `Functions` keeps the figure the vendor gave.
  //
  // A provider is labelled `manual` when ANY of its lines came from a person, because that is
  // what the chip has to warn about; the notes below carry who said what.
  // ── ONE METRIC FAMILY PER PROVIDER ──────────────────────────────────────────────────────
  //
  // Vercel writes one of TWO mutually exclusive shapes: a per-service breakdown, or a single
  // total row when a credit or a sub-cent month makes a breakdown impossible to state honestly.
  // Per-metric precedence treated them as unrelated lines, so a manual `Pro` row surviving beside
  // a later `charges (net of credits)` row was SUMMED with it — and the net row already contains
  // Pro. The transition either way doubled the month.
  //
  // The newest API shape a provider has decides the family, and only lines in that family count.
  // Manual precedence applies WITHIN the family and never across it: an operator correcting `Pro`
  // is correcting a line of the breakdown, and has nothing to say about a total row that
  // supersedes the breakdown entirely.
  const newestApi = new Map<string, { at: Date; total: boolean }>();
  for (const r of rows) {
    if (r.source !== "api") continue;
    const held = newestApi.get(r.provider);
    if (!held || r.fetchedAt > held.at) {
      newestApi.set(r.provider, { at: r.fetchedAt, total: isTotalMetric(r.metric) });
    }
  }

  const byMetric = new Map<string, typeof rows[number]>();
  for (const r of rows) {
    const family = newestApi.get(r.provider);
    // A row from the shape this provider is no longer reporting in is not part of the month.
    if (family && isTotalMetric(r.metric) !== family.total) continue;
    // EVERY TOTAL IS ONE KEY. A legacy name and the canonical one are the same figure, so they
    // collapse onto the same key here rather than being summed as two lines — which is precisely
    // what a hand-entered `charges` beside an API `charges (net of credits)` used to do.
    const key = `${r.provider}|${isTotalMetric(r.metric) ? TOTAL_METRIC : r.metric}`;
    const held = byMetric.get(key);
    // Manual beats API for the same metric; between two of a kind the newer stamp wins.
    if (!held
      || (r.source === "manual" && held.source === "api")
      || (r.source === held.source && r.fetchedAt > held.fetchedAt)) {
      byMetric.set(key, r);
    }
  }

  const totals = new Map<CostProvider, {
    cents: number; flat: number; fetchedAt: Date;
    notes: Array<{ note: string | null; enteredBy: string | null }>;
    currency: string; anyManual: boolean; anyApi: boolean; oldestApi: Date | null; mixed: boolean;
  }>();
  for (const r of byMetric.values()) {
    const key = r.provider as CostProvider;
    const acc = totals.get(key);
    if (!acc) {
      totals.set(key, {
        cents: r.costCents,
        flat: r.source === "manual" ? r.costCents : 0,
        fetchedAt: r.fetchedAt,
        notes: r.source === "manual" ? [{ note: r.note, enteredBy: r.enteredBy }] : [],
        currency: r.currency,
        anyManual: r.source === "manual", anyApi: r.source === "api",
        oldestApi: r.source === "api" ? r.fetchedAt : null,
        mixed: false,
      });
      continue;
    }
    acc.cents += r.costCents;
    if (r.source === "manual") acc.flat += r.costCents;
    if (r.fetchedAt > acc.fetchedAt) acc.fetchedAt = r.fetchedAt;
    // CURRENCIES ARE NOT ADDED. Rows in two currencies summed into one number carrying whichever
    // sorted first, and the board renders every figure with a `$`. The adapters refuse a foreign
    // currency now and the manual endpoint refuses one too, so this is the last door — and a
    // provider whose stored rows disagree reports as unmeasured rather than as a number no
    // currency supports.
    if (r.currency !== acc.currency) acc.mixed = true;
    if (r.source === "manual") {
      acc.anyManual = true;
      acc.notes.push({ note: r.note, enteredBy: r.enteredBy });
    } else {
      acc.anyApi = true;
      // The STALENESS verdict is the OLDEST api line's, not the newest: a provider whose plan
      // fee refreshed while its usage line went stale is not current.
      if (acc.oldestApi === null || r.fetchedAt < acc.oldestApi) acc.oldestApi = r.fetchedAt;
    }
  }

  for (const [provider, acc] of totals) {
    // MIXED, OR SIMPLY NOT DOLLARS. Every write door refuses a foreign currency now, but a row
    // stored before those doors existed is still in the table — and being internally consistent,
    // it was not "mixed", so it was returned, added to dollar providers and rendered with a `$`.
    // The read is the last door and it refuses here: unmeasured, with the reason on the row.
    if (acc.mixed || acc.currency !== "usd") continue;
    const stale = acc.anyApi && acc.oldestApi !== null
      && now.getTime() - acc.oldestApi.getTime() > COST_STALE_AFTER_MS;
    byProvider.set(provider, {
      provider,
      cents: acc.cents,
      currency: acc.currency,
      fetchedAt: acc.fetchedAt,
      // A manual figure does not go stale: a person read an invoice, and an invoice does not
      // change. An API figure does — a provider that stopped answering leaves its last row
      // standing, and this is the word that stops it reading as current. A provider carrying
      // BOTH is `manual` if any line is stale-free, and `stale` when an API line it still
      // depends on has stopped moving.
      source: acc.anyManual && !stale ? "manual" : stale ? "stale" : "api",
      // EVERY operator's note, not one row's. Alice's compute line and Bob's network line summed
      // to one figure that carried only Bob's provenance, which attributed her figure to him.
      note: acc.notes.length === 0 ? null
        : acc.notes.map((n) => n.note).filter((n): n is string => !!n).join(" · ") || null,
      enteredBy: acc.notes.length === 1 ? acc.notes[0]!.enteredBy : null,
      // THE FLAT HALF, SPLIT OUT PER METRIC. The projection classifies a whole provider as flat
      // or scalable from `source`, so one hand-entered line used to make an entire provider
      // unscaled — a $20 manual plan fee beside $5 of measured usage meant none of the usage was
      // pro-rated, and when the API half went stale the inverse happened and the flat fee was.
      // The two halves are separated here, where the per-metric rows still exist to separate.
      flatCents: acc.flat,
      // The oldest API line's stamp, which is what the projection has to scale FROM: a provider
      // whose plan fee refreshed while its usage line went stale is not current.
      scalableFetchedAt: acc.oldestApi,
    });
  }

  return [...byProvider.values()];
}
