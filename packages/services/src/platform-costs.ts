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
    if (typeof v !== "string" || v === "") return;
    const c = v.toLowerCase();
    if (this.seen === null) this.seen = c;
    else if (this.seen !== c) this.conflict = true;
  }
  /** `null` when the response mixed currencies. Absent throughout ⇒ the column's default. */
  resolve(): string | null {
    return this.conflict ? null : (this.seen ?? "usd");
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
          // Keyed by `starting_at`, which identifies a bucket for a fixed `bucket_width`. The
          // cursor was measured to be EXCLUSIVE of the page it came from (`page_` decodes to the
          // next bucket's start), so pages do not overlap today — but a total is the one thing
          // here that may not be wrong, and a vendor changing to an inclusive cursor would
          // double-count a day per page rather than fail. De-duplicating cannot lose a bucket
          // and removes the whole class.
          const buckets = new Map<string, unknown>();
          let page: string | null = null;
          const walked = new Set<string>();
          for (let asked = 0; asked < ANTHROPIC_MAX_PAGES; asked += 1) {
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
            if (body.has_more === false) return parseAnthropic([...buckets.values()], window);
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
  lines: string[], window: { start: Date; end: Date },
): PlatformCostFetch {
  const totals = new Map<string, { usd: number; quantity: number | null; unit: string | null }>();
  // Counted only for records that fall INSIDE the window. Counting every recognised record was
  // the previous shape and it manufactured a zero: minutes after a month starts, the response can
  // hold only the PREVIOUS month's last bucket, which was recognised, then filtered out, and the
  // empty-total arm below published a measured `$0.00` for the new month. What this number has to
  // answer is "did the vendor tell us anything about the month we asked about", and only an
  // in-window record does.
  let inWindow = 0;
  const currency = new Currency();
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
    currency.observe(record.BillingCurrency);
    if (billed < 0) credited = true;
    const acc = totals.get(service) ?? { usd: 0, quantity: null, unit: null };
    acc.usd += billed;
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

  const resolved = currency.resolve();
  if (resolved === null) return { failed: "mixed_currency" };

  // ── A CREDIT COSTS THE BREAKDOWN, NOT THE FIGURE ────────────────────────────────────────
  //
  // `cost_cents` is a non-negative integer (the migration's CHECK), so a month containing a
  // credit cannot be written as a per-service breakdown: clamping the credited service to zero
  // reports $100 for a month that was $100 of usage and a $5 credit. The provider gets ONE row
  // carrying the month's NET instead. The total is then right, the detail is gone, and the metric
  // name says which of the two you are looking at — the breakdown is what is given up, because a
  // figure that is wrong is worth less than a figure with no detail.
  if (credited) {
    const net = dollarsToCents([...totals.values()].reduce((sum, t) => sum + t.usd, 0));
    // A month whose credits outweigh its charges is REFUSED rather than floored: `$0.00` written
    // as a measurement would say the vendor charged nothing, and the vendor said it owed us.
    if (net < 0) return { failed: "negative_total" };
    return {
      rows: [{
        provider: "vercel", metric: "charges (net of credits)",
        periodStart: window.start, periodEnd: window.end,
        value: null, unit: null, costCents: net, currency: resolved,
      }],
    };
  }

  const rows: PlatformCostRow[] = [];
  for (const [metric, acc] of totals) {
    // A service the account has never touched contributes an exact 0 on every day in the range —
    // fifty-five of the sixty-five service names in a live response are that. Writing them would
    // fill the table with rows that say nothing. A SUB-CENT service (`0.0001` USD) is NOT this
    // case and is written, at zero cents, because it was genuinely used.
    //
    // Rounding is per service and that is inherent rather than a choice: the row IS the service
    // and the column is integer cents, so three separate $0.004 services are three zero-cent
    // rows. The alternative is to stop storing a breakdown at all, which costs more than the
    // half-cent it saves.
    if (acc.usd === 0) continue;
    rows.push({
      provider: "vercel", metric,
      periodStart: window.start, periodEnd: window.end,
      value: acc.quantity, unit: acc.unit,
      costCents: dollarsToCents(acc.usd),
      currency: resolved,
    });
  }

  // In-window records, and every one of them zero: a real month in which nothing was charged.
  // It gets a row that SAYS zero — the distinction the whole module is built on — under a metric
  // name that is the vendor's own word for the response rather than a service that was invented.
  if (rows.length === 0) {
    rows.push({
      provider: "vercel", metric: "charges",
      periodStart: window.start, periodEnd: window.end,
      value: null, unit: null, costCents: 0, currency: resolved,
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
  // Dollars, summed as dollars and rounded ONCE at the end. Rounding each result before adding
  // drifts: the recorded live month is 70.7614 + 10.3029 + 4.812 = 85.8763, which is 8588 cents,
  // and three separate roundings make it 8587.
  let usd = 0;
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
    if (from === null || to === null || to <= from || !Array.isArray(bucket.results)) {
      return { failed: "unrecognised_shape" };
    }
    // A bucket the caller did not ask about is not summed into the month it did ask about. The
    // timestamps were decorative before this line: a report that answered with a neighbouring
    // month's day would have had it added to the total.
    if (from < window.start.getTime() || from >= window.end.getTime()) continue;
    starts.push(from);
    for (const r of bucket.results as Array<Record<string, unknown>>) {
      const amount = typeof r?.amount === "string" && r.amount.trim() !== ""
        ? Number(r.amount) : num(r?.amount);
      // Same rule one level down: a result this parser cannot read is money it cannot account
      // for, so the report is refused rather than summed around.
      if (amount === null || !Number.isFinite(amount)) return { failed: "unrecognised_shape" };
      usd += amount;
      currency.observe(r?.currency);
    }
  }

  // No bucket of the shape this parser knows, inside the window it asked about ⇒ a report it
  // cannot read. NOT a zero: the one thing this module may never do is decide that an answer it
  // could not use means nothing was spent.
  if (starts.length === 0) return { failed: "unrecognised_shape" };

  // CONTINUITY. Quiet days are represented by explicit EMPTY buckets — a live August report
  // carries two — so a day that is simply ABSENT is data this walk did not receive, not a day
  // that cost nothing. Pages that between them skip a day would otherwise finish with
  // `has_more: false` and publish a month short by that day, which is exactly the shape of a
  // wrong total that looks complete.
  starts.sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i]! - starts[i - 1]! !== ANTHROPIC_BUCKET_MS) return { failed: "bucket_gap" };
  }

  const resolved = currency.resolve();
  if (resolved === null) return { failed: "mixed_currency" };
  const cents = dollarsToCents(usd);
  // A NET-NEGATIVE MONTH IS REFUSED, not floored. Flooring was the previous answer and it
  // publishes `$0.00` as a MEASUREMENT for a month in which the vendor said it owed us money —
  // "a zero on this board is only ever a row that says zero, written because a vendor said
  // zero", and the vendor did not say zero. `cost_cents` cannot hold the real figure, so the
  // honest outcome is the one the union already has for an answer that cannot be stored: nothing
  // written, the previous row standing, and the board saying so.
  if (cents < 0) return { failed: "negative_total" };
  return {
    rows: [{
      provider: "anthropic", metric: "tokens",
      periodStart: window.start, periodEnd: window.end,
      value: null, unit: null, costCents: cents, currency: resolved,
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
  const report: PlatformCostPassReport = { ranAt: at, providers: [] };

  for (const window of passWindows(at)) {
    const { start, end } = window;
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
    // case, since `parseVercel`/`parseSupabase` accept any finite line amount and a discount or
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
        await t.delete(platformCosts).where(and(
          eq(platformCosts.provider, provider),
          eq(platformCosts.periodStart, start),
          eq(platformCosts.periodEnd, end),
          eq(platformCosts.source, "api"),
        ));
        for (const row of result.rows) {
          await t.insert(platformCosts).values({
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
            // Kept although the DELETE above has already cleared this provider's API rows for
            // the window: a response carrying the same metric twice would otherwise abort the
            // whole provider on a primary-key collision, and the second line is the vendor's
            // own correction of the first.
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
      });
      report.providers.push({ provider, outcome: "written", rows: result.rows.length });
    } catch (err) {
      report.providers.push({
        provider, outcome: "failed", rows: 0,
        code: `write:${String((err as Error)?.name ?? "unknown")}`,
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
export const CLOSED_MONTH_GRACE_MS = 2 * 24 * 60 * 60 * 1000;

function passWindows(at: Date): Array<{ start: Date; end: Date }> {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  const windows = [{ start, end }];
  if (at.getTime() - start.getTime() < CLOSED_MONTH_GRACE_MS) {
    windows.push({
      start: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1)),
      end: start,
    });
  }
  return windows;
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
