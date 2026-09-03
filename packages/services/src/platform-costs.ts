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
 * None of the three provider keys exists in production. Not one. So the overwhelmingly likely
 * state of `platform_costs` for its first weeks is EMPTY, and every decision here is about what
 * happens then — because the failure is not a missing feature, it is a margin somebody believes:
 * an adapter that answers `0` when it could not ask, a DTO that defaults `cents: 0`, and a
 * console rendering "$0.00 infrastructure cost this month" in the same typeface it would render
 * a measurement.
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
 * These three request shapes have never been exercised against a live key, because there is no
 * live key to exercise them against — and they cannot be, until one is minted. That makes
 * a wrong guess about an endpoint or a response field a live possibility, and it decides how the
 * parsing is written: every adapter validates the shape it expects and answers `failed` for
 * anything else, so the worst outcome of a wrong guess is a board that says "not measured"
 * rather than a board that says a number nobody produced.
 *
 * The endpoints, named here so a first verification is one curl each:
 *
 *  · **vercel** — `GET https://api.vercel.com/v1/usage?teamId=…&from=…&to=…`, bearer
 *    `VERCEL_TOKEN`; the team is `VERCEL_TEAM_ID`.
 *  · **supabase** — `GET https://api.supabase.com/v1/projects/{ref}/billing/usage`, bearer
 *    `SUPABASE_ACCESS_TOKEN`; the project is `SUPABASE_PROJECT_REF`.
 *  · **anthropic** — `GET https://api.anthropic.com/v1/organizations/cost_report`, header
 *    `x-api-key: ANTHROPIC_ADMIN_API_KEY` (an ADMIN-scoped key, not the inference key this
 *    product spends on — a different credential with a different blast radius, which is why it
 *    has its own variable name rather than reusing `ANTHROPIC_API_KEY`).
 *
 * `railway` and `resend` have no adapter at all and are MANUAL ONLY: there is no usable billing
 * API for either, and inventing one would be the fabricated-figure failure wearing a friendlier
 * face. They arrive through `POST /admin/platform-costs`, typed by a person off an invoice, and
 * a manual row is FIRST-CLASS rather than a fallback — `source` is part of the primary key, so
 * an API row and a hand-entered row for one window coexist and the reader picks the manual one.
 */

/** The five providers `platform_costs.provider` admits. A sixth is an adapter and a review. */
export type CostProvider = "vercel" | "supabase" | "anthropic" | "railway" | "resend";

/** Which providers have an adapter at all. The other two are manual by design — see the header. */
export const API_COST_PROVIDERS: readonly CostProvider[] = ["vercel", "supabase", "anthropic"];

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

/** The env this port reads. Injected rather than read from `process.env` so a test can be honest. */
export interface PlatformCostEnv {
  VERCEL_TOKEN?: string | undefined;
  VERCEL_TEAM_ID?: string | undefined;
  SUPABASE_ACCESS_TOKEN?: string | undefined;
  SUPABASE_PROJECT_REF?: string | undefined;
  ANTHROPIC_ADMIN_API_KEY?: string | undefined;
}

const trimmed = (v: string | undefined): string => (v ?? "").trim();

/** USD → cents, rounded. A float of dollars is never stored; the column is an integer. */
const dollarsToCents = (usd: number): number => Math.round(usd * 100);

/** A shape guard that answers `null` rather than throwing — every parser below is built on it. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** `YYYY-MM-DD`, the form all three vendors' range parameters take. */
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Build the live port.
 *
 * `fetchImpl` is injectable and every test passes one, so the default suite makes no network
 * call — the same rule `makeAnthropicClient` follows, and for the same reason: a cost adapter
 * that dialled a vendor from a test would be a zero-external-requests violation and a flake.
 */
export function makePlatformCostPort(
  env: PlatformCostEnv,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): PlatformCostPort {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;

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
          const url = `https://api.vercel.com/v1/usage?teamId=${encodeURIComponent(team)}`
            + `&from=${window.start.getTime()}&to=${window.end.getTime()}`;
          const res = await get(url, { authorization: `Bearer ${token}` });
          if (!res.ok) return { failed: res.code };
          return parseVercel(res.body, window);
        }
        case "supabase": {
          const token = trimmed(env.SUPABASE_ACCESS_TOKEN);
          const ref = trimmed(env.SUPABASE_PROJECT_REF);
          if (!token || !ref) return { unconfigured: true };
          const url = `https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}/billing/usage`;
          const res = await get(url, { authorization: `Bearer ${token}` });
          if (!res.ok) return { failed: res.code };
          return parseSupabase(res.body, window);
        }
        case "anthropic": {
          const key = trimmed(env.ANTHROPIC_ADMIN_API_KEY);
          if (!key) return { unconfigured: true };
          const url = "https://api.anthropic.com/v1/organizations/cost_report"
            + `?starting_at=${isoDay(window.start)}&ending_at=${isoDay(window.end)}`;
          const res = await get(url, { "x-api-key": key, "anthropic-version": "2023-06-01" });
          if (!res.ok) return { failed: res.code };
          return parseAnthropic(res.body, window);
        }
        case "railway":
        case "resend":
          // MANUAL ONLY, and `unconfigured` is the honest word for it: there is no key to add and
          // no endpoint to call, so the board should say "not configured" until somebody types
          // the figure off an invoice. A `failed` here would page about a decision.
          return { unconfigured: true };
      }
    },
  };
}

/**
 * Vercel's usage response → rows.
 *
 * Written against the documented `/v1/usage` shape and NEVER exercised against a live token, for
 * the reason the header gives. So it validates rather than trusts: anything it does not
 * recognise is `unrecognised_shape`, which the pass records as a failure and the board renders
 * as "not measured". A wrong guess here costs a missing number and can never produce a wrong one.
 */
function parseVercel(body: unknown, window: { start: Date; end: Date }): PlatformCostFetch {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return { failed: "unrecognised_shape" };
  const rows: PlatformCostRow[] = [];
  for (const [metric, raw] of Object.entries(b)) {
    const cell = raw as Record<string, unknown> | null;
    if (!cell || typeof cell !== "object") continue;
    const price = num(cell.price);
    const quantity = num(cell.quantity ?? cell.total);
    if (price === null) continue;
    rows.push({
      provider: "vercel", metric,
      periodStart: window.start, periodEnd: window.end,
      value: quantity, unit: typeof cell.unit === "string" ? cell.unit : null,
      costCents: dollarsToCents(price), currency: "usd",
    });
  }
  // AN EMPTY PARSE IS A FAILURE, not a zero bill. The one thing this module may never do is
  // decide that a response it could not read means nothing was spent.
  return rows.length === 0 ? { failed: "unrecognised_shape" } : { rows };
}

/** Supabase's billing usage → rows. The same validate-or-refuse rule; see {@link parseVercel}. */
function parseSupabase(body: unknown, window: { start: Date; end: Date }): PlatformCostFetch {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return { failed: "unrecognised_shape" };
  const list = Array.isArray(b.usage) ? b.usage : Array.isArray(b) ? b : null;
  if (!list) return { failed: "unrecognised_shape" };
  const rows: PlatformCostRow[] = [];
  for (const entry of list as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== "object") continue;
    const metric = typeof entry.metric === "string" ? entry.metric
      : typeof entry.name === "string" ? entry.name : null;
    const cents = num(entry.cost_cents) ?? (num(entry.cost) !== null ? dollarsToCents(num(entry.cost)!) : null);
    if (metric === null || cents === null) continue;
    rows.push({
      provider: "supabase", metric,
      periodStart: window.start, periodEnd: window.end,
      value: num(entry.usage) ?? num(entry.quantity),
      unit: typeof entry.unit === "string" ? entry.unit : null,
      costCents: cents, currency: "usd",
    });
  }
  return rows.length === 0 ? { failed: "unrecognised_shape" } : { rows };
}

/**
 * Anthropic's organization cost report → rows.
 *
 * The one adapter whose response shape is documented in a form this code can state: `data` is a
 * list of time buckets, each with `results` carrying an `amount` and a `currency`. Summed into a
 * single `tokens` row per window, because the board's question is "what did the model cost this
 * month" and the per-bucket detail is the Console's job.
 *
 * `amount` is a STRING of dollars in that report, so it is parsed rather than read — and a value
 * that does not parse is skipped rather than treated as zero.
 */
function parseAnthropic(body: unknown, window: { start: Date; end: Date }): PlatformCostFetch {
  const b = body as { data?: unknown } | null;
  if (!b || !Array.isArray(b.data)) return { failed: "unrecognised_shape" };
  let cents = 0;
  let seen = 0;
  let currency = "usd";
  for (const bucket of b.data as Array<Record<string, unknown>>) {
    const results = Array.isArray(bucket?.results) ? bucket.results : [];
    for (const r of results as Array<Record<string, unknown>>) {
      const amount = typeof r?.amount === "string" ? Number(r.amount) : num(r?.amount);
      if (amount === null || !Number.isFinite(amount)) continue;
      cents += dollarsToCents(amount);
      seen += 1;
      if (typeof r?.currency === "string" && r.currency) currency = r.currency.toLowerCase();
    }
  }
  // A report with buckets but NO readable result is a shape this parser does not understand.
  // A report with buckets that genuinely total zero has `seen > 0` and lands as a real zero row,
  // which is the distinction the whole module is built on.
  if (seen === 0) return { failed: "unrecognised_shape" };
  return {
    rows: [{
      provider: "anthropic", metric: "tokens",
      periodStart: window.start, periodEnd: window.end,
      value: null, unit: null, costCents: cents, currency,
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
