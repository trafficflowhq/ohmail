import { sql } from "drizzle-orm";
import { platformSignals } from "@trafficflow/db/cloud";
import type { Db } from "./context.js";

/**
 * THE 5xx POLLER — what the hosting platform served, brought into this database so a rule can
 * read it.
 *
 * ## The blind spot this exists for, stated exactly
 *
 * The API host's error rate is invisible from inside the API host. A serverless invocation that
 * returns a 502 and dies writes nothing here: no row, no log line the database can query, no
 * counter that survives the invocation. The one surface that knows is the platform's own request
 * log, and it is reachable only over the network with a token.
 *
 * That was measured rather than assumed. On the 2026-08-31 incident the function's own captured
 * output was EMPTY on every failing row — the route returned a 502 `Response` instead of throwing,
 * so nothing on that path logged — and the whole diagnosis came from the platform's log store.
 * `scripts/vercel-errors.mjs` was written for that incident; this module is the same endpoint,
 * polled on a clock instead of by a person after the fact.
 *
 * ## THREE OUTCOMES, AND THE MIDDLE ONE IS THE POINT
 *
 * {@link PlatformSignalFetch} is `rows | unconfigured | failed`, which is `PlatformCostPort`'s
 * union next door and is here for the identical reason. A two-armed version — rows, or nothing —
 * collapses "we have no token, so nobody has ever measured this" into the same answer as "we
 * measured, and nothing failed". The first must render as **"5xx: not measured"** and must not
 * arm the rule; the second is a real zero.
 *
 * The failure that shape prevents is specific and is the ruling's second ranked risk: a board
 * showing `0` for a deployment that has never once asked. Nobody reads a zero as a question.
 *
 * The mechanism is that an unconfigured pass WRITES NO ROW. `platformSignalWindow` in `alerts.ts`
 * then returns an empty array for that project, and both the rule and the panel go through that
 * one function — so the pager and the screen cannot disagree about whether a figure exists.
 *
 * ## ONE WALK, CLASSIFIED LOCALLY — the numerator and the denominator from one pass
 *
 * The rule needs both `errors_5xx` and `requests`. Two filtered queries would give two counts over
 * two independently-truncated populations, and dividing one by the other would be arithmetic over
 * mismatched samples. So this makes ONE unfiltered walk and classifies each row by its own
 * `statusCode`: whatever the walk covers, it covers for both numbers.
 *
 * ## THE BUDGET, AND WHY TRUNCATION IS SAFE IN BOTH TERMS
 *
 * The endpoint pages at fifty rows and its `page` parameter is INERT (measured — see
 * `vercel-errors.mjs`), so a walk moves a cursor backwards through time. The length of that walk
 * is a property of TRAFFIC, not of the window: a busy five minutes is many laps. An unbounded loop
 * does not fail, it simply never finishes — which in a cron invocation means it is killed and
 * reports nothing at all.
 *
 * So the walk is bounded and a row that hit the bound is marked {@link PlatformSignalRow.truncated}.
 * Both counts are then LOWER BOUNDS over the window's most recent, contiguous slice — and that is
 * the safe direction in both terms of the rule:
 *
 *  · `errors_5xx ≥ 10` — an undercounted numerator can only fail to reach the floor.
 *  · `≥ 2%` — the ratio is measured over a real sub-window rather than extrapolated.
 *
 * A truncated window therefore cannot manufacture a page. It can miss one, which is the direction
 * to be wrong in, and the board says "sampled" rather than implying a count it does not have.
 */

/** The platforms `platform_signals.provider` admits. A second is an adapter and a review. */
export type SignalProvider = "vercel";

/** One window's traffic for one project, as counted. */
export interface PlatformSignalRow {
  provider: SignalProvider;
  /** The platform's own project name (`ohmail-api`) — an identifier this repository chooses. */
  project: string;
  windowStart: Date;
  requests: number;
  errors5xx: number;
  /** The walk hit its budget: both counts are lower bounds over the newest slice of the window. */
  truncated: boolean;
}

/** The port's three outcomes. The union IS the design — see the module header. */
export type PlatformSignalFetch =
  | { rows: PlatformSignalRow[] }
  | { unconfigured: true }
  | { failed: string };

export interface PlatformSignalPort {
  fetch(window: { start: Date; end: Date }): Promise<PlatformSignalFetch>;
}

/** The env this port reads. Injected rather than read from `process.env` so a test can be honest. */
export interface PlatformSignalEnv {
  VERCEL_TOKEN?: string | undefined;
  VERCEL_TEAM_ID?: string | undefined;
  /**
   * Comma-separated project names to poll. Absent ⇒ `ohmail-api` alone, which is the deployment
   * whose 5xx rate is the alert's subject; the landing site failing is a marketing problem and
   * not one that pages.
   */
  VERCEL_SIGNAL_PROJECTS?: string | undefined;
}

/**
 * The endpoint `scripts/vercel-errors.mjs` calls — `vercel logs`' own, not the public REST API.
 *
 * The public API does not serve request logs at all; this is the dashboard's endpoint, and the
 * CLI reaches it the same way. Shared as a constant so a census can assert the script and this
 * module have not drifted apart onto two different surfaces.
 */
export const VERCEL_REQUEST_LOGS_URL = "https://vercel.com/api/logs/request-logs";

/** The default project. See {@link PlatformSignalEnv.VERCEL_SIGNAL_PROJECTS}. */
export const DEFAULT_SIGNAL_PROJECTS: readonly string[] = ["ohmail-api"];

/**
 * How many pages one project's window may cost before the walk stops and marks itself truncated.
 *
 * Twenty pages at the endpoint's fifty-row page size is a thousand requests in a five-minute
 * window — comfortably above this deployment's traffic and far below anything that could exhaust a
 * cron invocation's budget. The number is a BOUND rather than a fit: if traffic ever grows past
 * it, the rows say `truncated` and the rule keeps working on a sample, which is why the bound is
 * allowed to be wrong without becoming a defect.
 */
export const SIGNAL_PAGE_BUDGET = 20;

/**
 * THE WALL-CLOCK BUDGET FOR ONE POLL, and it is a SEPARATE guard from the page budget.
 *
 * The page budget bounds how many laps the walk may take; it does not bound how LONG they take,
 * and those are different questions once each lap has its own 15 s timeout. Twenty laps against a
 * slow log endpoint is 300 s for ONE project, and `VERCEL_SIGNAL_PROJECTS` may name several — all
 * of it inside a cron target that declares 60 s and a platform that kills the invocation anyway.
 *
 * The failure that produces is the quiet one. The invocation dies mid-walk, `runPlatformSignalPass`
 * never reaches its upsert, NO row is written for that window, and the board reports "not
 * measured" — which is indistinguishable from having no token at all. So a slow endpoint would
 * take the rule dark and look like a configuration state.
 *
 * 40 s leaves room inside the declared 60 s for the prune and the upsert that follow the walk.
 * Crossing it stops the walk and marks the row `truncated`, which is the outcome the design
 * already treats as safe: a partial count over the newest slice, honest about being partial, and
 * a lower bound in the only direction a rate rule can be wrong in.
 */
export const SIGNAL_WALL_CLOCK_MS = 40_000;

/** The window one poll covers. Matches the cron's cadence — three of these make the rule's 15 min. */
export const SIGNAL_WINDOW_MS = 5 * 60 * 1000;

/** How long `platform_signals` rows are kept. The rule reads 15 minutes; the board reads a day. */
export const SIGNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const trimmed = (v: string | undefined): string => (v ?? "").trim();

/**
 * Build the live port.
 *
 * `fetchImpl` is injectable and every test passes one, so the suite makes no network call — the
 * rule `makePlatformCostPort` follows next door, and for the same reason.
 */
export function makePlatformSignalPort(
  env: PlatformSignalEnv,
  opts: {
    fetchImpl?: typeof fetch; timeoutMs?: number; pageBudget?: number;
    wallClockMs?: number; nowMs?: () => number;
  } = {},
): PlatformSignalPort {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const budget = opts.pageBudget ?? SIGNAL_PAGE_BUDGET;
  const wallClockMs = opts.wallClockMs ?? SIGNAL_WALL_CLOCK_MS;
  // Injectable so the deadline is TESTABLE without a slow endpoint or a real clock. A guard whose
  // only trigger is "wait forty seconds" is a guard nobody watches fail.
  const nowMs = opts.nowMs ?? (() => Date.now());

  return {
    async fetch(window) {
      const token = trimmed(env.VERCEL_TOKEN);
      const team = trimmed(env.VERCEL_TEAM_ID);
      // BOTH are required, and the team id is not optional here even though a personal account
      // would not need one: this endpoint scopes by `ownerId`, and a request without it answers
      // for the wrong scope rather than refusing. A half-configured deployment is UNCONFIGURED,
      // not broken — it has not been set up, and saying "failed" would put a red state on a board
      // for a deployment that simply has not been asked to measure anything.
      if (token.length === 0 || team.length === 0) return { unconfigured: true };

      const projects = trimmed(env.VERCEL_SIGNAL_PROJECTS).length > 0
        ? trimmed(env.VERCEL_SIGNAL_PROJECTS).split(",").map((p) => p.trim()).filter(Boolean)
        : [...DEFAULT_SIGNAL_PROJECTS];

      // ONE DEADLINE FOR THE WHOLE POLL, not one per project: what has to fit inside the
      // invocation is every project's walk plus the write, so a per-project budget would
      // multiply by the project count — which is the shape of the problem, not a bound on it.
      const deadline = nowMs() + wallClockMs;
      const rows: PlatformSignalRow[] = [];
      for (const project of projects) {
        const walked = await walk(project);
        // ONE PROJECT'S FAILURE IS THE WHOLE POLL'S FAILURE, deliberately — the opposite of the
        // cost pass's per-provider isolation, and the difference is what the two measure. A cost
        // pass reads independent vendors, so one refusing says nothing about the others. Here
        // every project is read from ONE endpoint with ONE token, so a failure is almost always
        // that endpoint or that token, and writing a partial poll would leave the projects that
        // did answer looking freshly measured while the rest silently stopped.
        if ("failed" in walked) return walked;
        rows.push(walked.row);
      }
      return { rows };

      async function walk(
        project: string,
      ): Promise<{ row: PlatformSignalRow } | { failed: string }> {
        let requests = 0;
        let errors5xx = 0;
        let cursor = window.end.getTime();
        let pages = 0;
        // `requestId` dedupes the boundary: the cursor is inclusive and two requests can share a
        // millisecond, so without it a row at the edge is counted twice on consecutive laps.
        const seen = new Set<string>();

        while (cursor > window.start.getTime()) {
          // BOTH ceilings return the same shape — a partial count that says it is partial. The
          // page budget bounds the number of laps; this bounds their total cost, and only the
          // second one can be crossed by an endpoint that answers slowly rather than deeply.
          if (pages >= budget || nowMs() >= deadline) {
            return { row: { provider: "vercel", project, windowStart: window.start, requests, errors5xx, truncated: true } };
          }
          pages++;
          const q = new URLSearchParams({
            projectId: project,
            ownerId: team,
            startDate: String(window.start.getTime()),
            endDate: String(cursor),
          });
          let res: Response;
          try {
            res = await doFetch(`${VERCEL_REQUEST_LOGS_URL}?${q}`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(timeoutMs),
            });
          } catch (err) {
            // The NAME only, never the message: a fetch error's message carries the URL, and this
            // string reaches a log line and an operator's screen.
            return { failed: `transport:${String((err as Error)?.name ?? "unknown")}` };
          }
          if (!res.ok) return { failed: `http_${res.status}` };
          let body: unknown;
          try { body = await res.json(); } catch { return { failed: "unparseable" }; }

          const data = body as { rows?: unknown; hasMoreRows?: unknown };
          // A MISSING `rows` IS NOT AN EMPTY `rows`, and this is the trap `vercel-errors.mjs`
          // records from measurement: defaulting to `[]` lets a schema change or a partial
          // response read as "this slice held nothing", which with `hasMoreRows: false` becomes a
          // confident, wrong zero — and a confident wrong zero on THIS table is the exact state
          // the three-armed union above exists to make unrepresentable.
          if (!Array.isArray(data.rows)) return { failed: "no_rows_array" };
          // Same rule for the continuation flag. Reading an ABSENT flag as "no more" would skip
          // every older row in the window and still report a complete count.
          if (typeof data.hasMoreRows !== "boolean") return { failed: "no_has_more_flag" };

          const batch = data.rows as Array<Record<string, unknown>>;
          let oldest = cursor;
          for (const r of batch) {
            const id = typeof r.requestId === "string" ? r.requestId : "";
            // A blank id cannot be de-duplicated, so counting it would inflate the boundary. It is
            // skipped rather than refused: unlike the census script, an approximate count over a
            // five-minute window is still a usable rate, and refusing the whole poll over one
            // malformed row would take the rule dark for a schema wobble.
            if (id.length === 0 || seen.has(id)) continue;
            seen.add(id);
            requests++;
            const status = Number(r.statusCode);
            if (Number.isFinite(status) && status >= 500 && status <= 599) errors5xx++;
            const ts = Number(r.timestamp);
            if (Number.isFinite(ts) && ts < oldest) oldest = ts;
          }

          if (data.hasMoreRows === false) break;
          // A lap that advanced the cursor by NOTHING is a hard stop rather than an infinite
          // loop — fifty requests inside one millisecond would otherwise spin until the
          // invocation is killed. Marked truncated, because it is: the rest of the window is
          // genuinely unread.
          //
          // AN EMPTY BATCH WITH `hasMoreRows: true` LANDS HERE, AND `truncated` IS THE RIGHT
          // ANSWER FOR IT — stated because it reads at first like a false positive and is not.
          // The endpoint has said more rows exist and then handed back none, so the cursor cannot
          // advance and everything older in the window stays unread. Reporting that as a complete
          // count would be the actual defect: it would put a confident total on a board for a
          // window the poll never finished reading.
          if (oldest >= cursor) {
            return { row: { provider: "vercel", project, windowStart: window.start, requests, errors5xx, truncated: true } };
          }
          cursor = oldest;
        }

        return {
          row: { provider: "vercel", project, windowStart: window.start, requests, errors5xx, truncated: false },
        };
      }
    },
  };
}

/** What one pass did, per project — the shape the route logs and answers with. */
export interface PlatformSignalPassReport {
  outcome: "written" | "unconfigured" | "failed";
  /** The failure code, when `outcome` is `failed`. Never a vendor message. */
  code?: string;
  rows: number;
  /** Rows the retention sweep removed on this pass. */
  pruned: number;
}

export interface PlatformSignalPassOptions {
  port: PlatformSignalPort;
  now?: () => Date;
  windowMs?: number;
  retentionMs?: number;
}

/**
 * One poll: read the window that just closed, upsert it, prune what is past retention.
 *
 * ── THE WINDOW IS THE ONE THAT JUST CLOSED, NOT THE ONE IN PROGRESS ────────────────────────
 *
 * Rounded DOWN to the window size and then stepped back one. Two reasons, and both are about the
 * rate being a fact rather than an artefact:
 *
 *  · A window still in progress is short. Polling `[now - 5min, now]` at a moment two minutes
 *    into a window counts two minutes of traffic and stores it as five minutes' worth, so a
 *    quiet slice inflates the error RATE for everything summed with it.
 *  · The platform's log store is not instantaneous. A request served a second ago may not be
 *    queryable yet, and the rows that arrive late are exactly the slow and failing ones — which
 *    would systematically undercount 5xx in the newest window, on the one rule where undercounting
 *    is the thing that loses a page.
 *
 * ALIGNED TO THE CLOCK rather than to the poll time, so two poll cadences that drift never write
 * two overlapping windows: the primary key is `(provider, project, window_start)` and an aligned
 * start makes a re-poll an UPSERT of the same row rather than a second row for the same traffic.
 *
 * NEVER THROWS FOR A FETCH FAILURE — the pass reports it. A database failure does propagate,
 * because a pass that cannot write has not measured anything and must not report success.
 */
export async function runPlatformSignalPass(
  db: Db, opts: PlatformSignalPassOptions,
): Promise<PlatformSignalPassReport> {
  const now = (opts.now ?? (() => new Date()))();
  const windowMs = opts.windowMs ?? SIGNAL_WINDOW_MS;
  const retentionMs = opts.retentionMs ?? SIGNAL_RETENTION_MS;

  const alignedEnd = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const start = new Date(alignedEnd.getTime() - windowMs);

  const answer = await opts.port.fetch({ start, end: alignedEnd });

  // PRUNE ON EVERY PASS, including an unconfigured one, and that is deliberate: a deployment that
  // had a token and lost it must not keep a week of rows for ever, and the sweep is one indexed
  // range delete over a table with a few thousand rows.
  const pruned = await prune(db, new Date(now.getTime() - retentionMs));

  if ("unconfigured" in answer) return { outcome: "unconfigured", rows: 0, pruned };
  if ("failed" in answer) return { outcome: "failed", code: answer.failed, rows: 0, pruned };

  for (const row of answer.rows) {
    await db
      .insert(platformSignals)
      .values({
        provider: row.provider,
        project: row.project,
        // ISO STRINGS WITH AN EXPLICIT CAST, never a `Date`. `postgres.js` caches a prepared
        // statement's parameter type from its FIRST call, and a later call with a different JS
        // type in the same position throws `ERR_INVALID_ARG_TYPE` — green on PGlite, a 500 in
        // production. This was paid for once against real Postgres; the fix travels with the
        // pattern, not with the table.
        windowStart: sql`${row.windowStart.toISOString()}::timestamptz`,
        requests: row.requests,
        errors5xx: row.errors5xx,
        truncated: row.truncated,
        fetchedAt: sql`${now.toISOString()}::timestamptz`,
      })
      .onConflictDoUpdate({
        target: [platformSignals.provider, platformSignals.project, platformSignals.windowStart],
        // A RE-POLL OVERWRITES. The window is closed, so a second read of it is a better read of
        // the same traffic — later rows have landed in the log store — and never a different
        // window's. This is what makes a leader takeover's duplicate poke harmless.
        set: {
          requests: row.requests,
          errors5xx: row.errors5xx,
          truncated: row.truncated,
          fetchedAt: sql`${now.toISOString()}::timestamptz`,
        },
      });
  }

  return { outcome: "written", rows: answer.rows.length, pruned };
}

/** Delete rows older than the cut. Returns how many went. */
async function prune(db: Db, cut: Date): Promise<number> {
  const gone = await db
    .delete(platformSignals)
    .where(sql`${platformSignals.windowStart} < ${cut.toISOString()}::timestamptz`)
    .returning();
  return gone.length;
}
