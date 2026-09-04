import { and, sql } from "drizzle-orm";
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
  /**
   * The projects this port polls, in the order it polls them.
   *
   * The PASS needs them, not just the port: a bucket is only complete once EVERY expected
   * project has a row in it, and the table's primary key includes the project. Keying completion
   * on the window alone meant one project's row suppressed polling for all of them, so adding a
   * project — or any partial write — left the newcomer's window permanently unrepaired while the
   * bucket looked finished.
   */
  readonly projects: readonly string[];
  /**
   * Read one window.
   *
   * `deadlineMs` is an ABSOLUTE epoch millisecond, supplied by the caller, and it exists because
   * the alternative was measured twice and was wrong twice: a deadline established inside this
   * method is recreated on every call, so a caller filling three missing buckets got three full
   * budgets and could spend triple the invocation's ceiling. The pass that owns the invocation is
   * the only thing that knows when it must be finished, so it says so. Omitted ⇒ this call makes
   * its own, which is right for a one-shot caller and is what a test uses.
   */
  fetch(
    window: { start: Date; end: Date },
    opts?: { deadlineMs?: number },
  ): Promise<PlatformSignalFetch>;
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

/**
 * Where a project NAME is exchanged for the id the log endpoint actually wants.
 *
 * THE POLL NEVER WORKED WITHOUT THIS. `projectId` on the request-log endpoint is Vercel's
 * internal project id, not the name — and this port was passing the configured name
 * (`ohmail-api`) straight into it, so every poll either failed or matched nothing. The table
 * stayed empty, the board read "5xx: not measured", and that is indistinguishable from the
 * expected state of a deployment with no token, which is why nothing noticed.
 *
 * `scripts/vercel-errors.mjs` has always done this correctly — it resolves the name and passes
 * `proj.id` — so this is that call, in the port that needed it.
 *
 * TWO DIFFERENT HOSTS, which is easy to get wrong and was: the versioned REST API lives on
 * `api.vercel.com`, while the request-log endpoint above is on the DASHBOARD origin
 * (`vercel.com/api/logs/...`). The reference script keeps them as two constants for exactly this
 * reason. Resolving against the dashboard origin fails before any log is read, which lands in
 * the same indistinguishable place as every other failure in this file — an empty table and a
 * board that says "not measured".
 */
export const VERCEL_PROJECT_URL = "https://api.vercel.com/v9/projects";

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

/**
 * How many CLOSED buckets a pass will fill in if they are missing.
 *
 * Three, which is `api5xxWindowMs / SIGNAL_WINDOW_MS` — the number of buckets the rule actually
 * sums. Healing further back would spend the walk budget on data no rule reads; healing less far
 * would leave a drift-skipped bucket inside the window the rule advertises.
 */
export const SIGNAL_BACKFILL_BUCKETS = 3;


/** The window one poll covers. Matches the cron's cadence — three of these make the rule's 15 min. */
export const SIGNAL_WINDOW_MS = 5 * 60 * 1000;

/** How long `platform_signals` rows are kept. The rule reads 15 minutes; the board reads a day. */
export const SIGNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const trimmed = (v: string | undefined): string => (v ?? "").trim();

/**
 * One log row's timestamp, in epoch milliseconds, or null when it cannot be read.
 *
 * THE CURSOR IS BUILT OUT OF THIS VALUE, which is why it is a shared helper with a refusal
 * rather than an inline `Number()`. The log endpoint returns ISO-8601 STRINGS — `vercel-errors.mjs`
 * has always read them with `Date.parse` and refuses outright when one will not parse, saying
 * "the time cursor cannot advance", which is exactly the failure. `Number("2026-09-04T…")` is
 * `NaN`, `NaN < oldest` is false, so `oldest` would never move: every window needing more than
 * one page stopped after the first and reported the first page's counts as a truncated whole
 * window. A busy deployment's 5xx rate would have been computed over fifty requests.
 *
 * A number is still accepted, because epoch millis are what the tests and any future shape of
 * this endpoint would most plausibly send, and accepting both costs one branch.
 */
function parseStamp(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    // AN EMPTY STRING IS NOT EPOCH ZERO, and the fall-through to `Number` made it one.
    // `Date.parse("")` is NaN, so the old code reached `Number("")` — which is 0, finite, and
    // accepted. A cursor set to epoch zero jumps behind the window's start and stops the walk
    // while `hasMoreRows` still says otherwise, and the bucket is stored COMPLETE over whatever
    // the first page happened to hold.
    if (v.trim().length === 0) return null;
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed)) return parsed;
    const asNumber = Number(v);
    return Number.isFinite(asNumber) ? asNumber : null;
  }
  return null;
}


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

  // ── A SEPARATOR-ONLY SETTING IS NOT A CONFIGURATION, AND `every` ON [] IS TRUE ────────
  //
  // `VERCEL_SIGNAL_PROJECTS=","` is non-blank, so it took the configured branch, and then the
  // filter removed everything and left an EMPTY list. That is quietly catastrophic downstream:
  // the pass asks whether every expected project already has a row for a bucket, and
  // `[].every(...)` is `true` — so every bucket read as complete, no request was ever made, and
  // the pass reported a successful `written` pass for ever while the detector sat dark.
  //
  // Falling back to the default keeps the parse total: whatever the value, this list is
  // non-empty, so the vacuous-truth arm downstream is unreachable rather than merely unlikely.
  const parsedProjects = trimmed(env.VERCEL_SIGNAL_PROJECTS)
    .split(",").map((p) => p.trim()).filter(Boolean);
  const resolvedProjects = parsedProjects.length > 0
    ? parsedProjects
    : [...DEFAULT_SIGNAL_PROJECTS];

  return {
    projects: resolvedProjects,
    async fetch(window, callOpts) {
      // ── THE DEADLINE IS THE CALLER'S WHEN IT HAS ONE, AND STARTS BEFORE ANY REQUEST ───
      //
      // Two defects met here. It used to start AFTER project resolution, so lookup time was
      // spent outside the budget entirely; and it was established per CALL, so a caller filling
      // three missing buckets received three full budgets and could spend triple the sixty-second
      // invocation ceiling — with no write happening until the loop finished, so the pass
      // produced nothing at all. Taking the caller's absolute deadline fixes the second for good:
      // a loop cannot reset a number it did not create.
      const deadline = callOpts?.deadlineMs ?? nowMs() + wallClockMs;
      /** What one request may take: its own ceiling, or the rest of the poll's, whichever is less. */
      const budgetFor = (): number => Math.max(0, Math.min(timeoutMs, deadline - nowMs()));
      const token = trimmed(env.VERCEL_TOKEN);
      const team = trimmed(env.VERCEL_TEAM_ID);
      // BOTH are required, and the team id is not optional here even though a personal account
      // would not need one: this endpoint scopes by `ownerId`, and a request without it answers
      // for the wrong scope rather than refusing. A half-configured deployment is UNCONFIGURED,
      // not broken — it has not been set up, and saying "failed" would put a red state on a board
      // for a deployment that simply has not been asked to measure anything.
      if (token.length === 0 || team.length === 0) return { unconfigured: true };

      const projects = resolvedProjects;

      // NAME → ID, once per pass, before any log query. A name that does not resolve fails the
      // whole poll rather than being walked as an id: querying the log endpoint with a name is
      // what produced an empty, confident-looking result for this port's entire life.
      const ids = new Map<string, string>();
      for (const name of projects) {
        let res: Response;
        try {
          res = await doFetch(
            `${VERCEL_PROJECT_URL}/${encodeURIComponent(name)}?teamId=${encodeURIComponent(team)}`,
            { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(budgetFor()) },
          );
        } catch (err) {
          return { failed: `project_transport:${String((err as Error)?.name ?? "unknown")}` };
        }
        if (!res.ok) return { failed: `project_http_${res.status}` };
        let body: unknown;
        try { body = await res.json(); } catch { return { failed: "project_unparseable" }; }
        const id = (body as { id?: unknown })?.id;
        if (typeof id !== "string" || id.length === 0) return { failed: "project_no_id" };
        ids.set(name, id);
      }

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
            // NOTHING READ IS NOT A ZERO, and this branch is where the wall-clock guard could
            // manufacture one. With several projects configured, an earlier walk can consume the
            // shared deadline and the next project enters this loop with `pages === 0` — never
            // issuing a request, and returning `requests: 0, errors5xx: 0` for a window nobody
            // looked at. The pass would persist that as a measured zero, which is precisely the
            // state this whole file is built to make unrepresentable: a zero is only ever a row
            // that says zero. An unread project is reported as a FAILURE, so the pass writes no
            // row for it and the board says "not measured".
            if (pages === 0) return { failed: "deadline_before_first_page" };
            return { row: { provider: "vercel", project, windowStart: window.start, requests, errors5xx, truncated: true } };
          }
          pages++;
          const q = new URLSearchParams({
            // THE ID, not the name — see `VERCEL_PROJECT_URL`. The row below keeps the NAME,
            // because that is what an operator recognises on the board and what the config sets.
            projectId: ids.get(project) ?? project,
            ownerId: team,
            startDate: String(window.start.getTime()),
            endDate: String(cursor),
          });
          let res: Response;
          try {
            res = await doFetch(`${VERCEL_REQUEST_LOGS_URL}?${q}`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(budgetFor()),
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
          // A NON-EMPTY PAGE THAT YIELDS NOTHING COUNTABLE IS A REFUSAL, not a quiet zero.
          //
          // `requestId` IS the dedupe key. When every row on a page lacks one, each is skipped,
          // the walk returns 0 requests and 0 errors, and — with `hasMoreRows: false` — stores
          // that as a COMPLETE bucket: measured health, manufactured out of rows nobody could
          // read. The reference script refuses exactly this case for exactly this reason
          // ("they cannot be de-duplicated"), and skipping individual blank ids remains right:
          // an approximate count over five minutes is still a usable rate. What is not right is
          // treating a page NONE of whose rows are usable as evidence of a quiet deployment.
          const usable = batch.filter((r) => typeof r.requestId === "string" && r.requestId !== "");
          if (batch.length > 0 && usable.length === 0) {
            return { failed: "page_without_request_ids" };
          }
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
            // AN UNREADABLE STATUS FAILS THE WALK, on the timestamp's exact argument one line
            // down. This is the field the entire rule is about: counting a row whose status
            // cannot be read as a REQUEST and implicitly as a non-error means a response shape
            // we do not understand is recorded as measured health. A schema change touching
            // every row would then persist a confident healthy zero and silently disable the
            // detector — the failure this file exists to make unrepresentable. One malformed
            // row taking a single window to "not measured" is the safe direction, and the next
            // window recovers on its own.
            // STRICT ABOUT THE SHAPE BEFORE COERCING IT, because `Number` is generous in
            // exactly the directions that fabricate health: `Number(null)` is 0, `Number("")` is
            // 0, `Number(false)` is 0 and `Number(true)` is 1 — all finite, all passing a
            // `Number.isFinite` check, and all recorded as a successful non-5xx request. A
            // private API that changed this field's shape would be logged as a healthy
            // deployment rather than as a failure to measure one.
            // A BLANK STRING IS NOT A STATUS, and the type check alone let one through.
            // `Number("")` and `Number("  ")` are both 0 — finite, past the guard below, and
            // counted as a served non-5xx response. A schema wobble that emptied this field
            // would therefore DILUTE the error rate with fabricated successes, or suppress the
            // alert outright once enough of them landed in the denominator. This is the same
            // omission the timestamp parser already carries a guard for; the status field needed
            // its own and did not have it.
            if (typeof r.statusCode === "string" && r.statusCode.trim().length === 0) {
              return { failed: "unreadable_status" };
            }
            if (typeof r.statusCode !== "number" && typeof r.statusCode !== "string") {
              return { failed: "unreadable_status" };
            }
            const status = Number(r.statusCode);
            if (!Number.isFinite(status)) return { failed: "unreadable_status" };
            if (status >= 500 && status <= 599) errors5xx++;
            const ts = parseStamp(r.timestamp);
            if (ts === null) return { failed: "unparseable_timestamp" };
            if (ts < oldest) oldest = ts;
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
  /**
   * The whole pass's wall-clock budget, shared across every bucket the backfill fills.
   *
   * Here rather than on the port because the PASS is what an invocation kills, and because a
   * budget the port re-creates per call is not a budget: filling three buckets once bought three
   * full ones. Injectable so a test can drive the boundary without waiting.
   */
  wallClockMs?: number;
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

  // ── ONE BUCKET PER PASS: THE NEWEST THAT IS NOT COMPLETE ─────────────────────────────
  //
  // Polling only `floor(now)` and never looking back drifts: the clock is cadence + jitter +
  // the walk's own duration, so the aligned end advances by more than one bucket whenever that
  // sum crosses a boundary — 12:04:59 becomes 12:10:20 — and the skipped bucket is skipped for
  // ever, because nothing ever looked at a closed bucket twice. The rule then divides a
  // numerator formed over two buckets by a window it advertises as three.
  //
  // ONE FETCH, NOT A LOOP, and that is the correction that matters. Filling every missing bucket
  // in one pass gave each `fetch` its OWN wall-clock budget, so three slow buckets could spend
  // three times the budget inside an invocation the platform kills at sixty seconds — and none
  // of the writes happen until every fetch returns, so the whole pass produced nothing. It also
  // hid failures: only the first answer was inspected, so an older bucket failing was silently
  // dropped while the pass reported success over an incomplete window.
  //
  // The NEWEST incomplete bucket is chosen so the rule always gets the freshest data first; an
  // older gap fills on the following passes. A three-bucket hole closes in fifteen minutes,
  // which is the width of the window it is repairing.
  const newestEnd = Math.floor(now.getTime() / windowMs) * windowMs;
  const candidates: number[] = [];
  for (let i = 0; i < SIGNAL_BACKFILL_BUCKETS; i++) candidates.push(newestEnd - i * windowMs);
  const oldestStart = candidates[candidates.length - 1]! - windowMs;
  const haveRows = await db
    // ── ONLY A FULLY COUNTED ROW COUNTS AS HELD ────────────────────────────────────────
    //
    // A walk that exhausts its budget after reading at least one page persists the bucket with
    // `truncated: true`. The rule then EXCLUDES that row from its arithmetic — a sampled count
    // cannot be divided into a rate — so a bucket that is held-but-excluded is a permanent hole:
    // never retried because it is present, never counted because it is sampled. It ages out of
    // the window without ever having contributed. The two halves were each correct and their
    // conjunction was not, which is why this filter belongs next to the exclusion it mirrors.
    .select({ project: platformSignals.project, windowStart: platformSignals.windowStart })
    .from(platformSignals)
    .where(and(
      sql`${platformSignals.windowStart} >= ${new Date(oldestStart).toISOString()}::timestamptz`,
      sql`not ${platformSignals.truncated}`,
    ));
  const held = new Set(
    haveRows.map((r) => `${r.project}@${new Date(r.windowStart as unknown as string).getTime()}`),
  );
  // COMPLETE MEANS EVERY EXPECTED PROJECT, not "somebody wrote something here". The table's key
  // includes the project, so one project's row used to mark the bucket finished for all of them.
  // BELT AND BRACES against the vacuous `every`: the port now guarantees a non-empty list, and
  // this refuses to treat an empty one as "everything is complete" if that ever stops holding.
  const expected = opts.port.projects.length > 0
    ? opts.port.projects
    : [...DEFAULT_SIGNAL_PROJECTS];
  const missing = candidates.filter(
    (end) => !expected.every((p) => held.has(`${p}@${end - windowMs}`)));

  // ── EVERY MISSING BUCKET, NEWEST FIRST, UNDER THE PORT'S ONE SHARED DEADLINE ──────────
  //
  // One fetch per pass could not CATCH UP. The cron rearms after completion, so every
  // invocation finds a newly closed bucket; a newest-first single fetch spent the pass on that
  // one and an older gap was never reached, ageing out of the fifteen-minute window without
  // ever being repaired. The rule then undercounted for ever, quietly.
  //
  // Looping is safe NOW and was not before: the earlier version gave each bucket its own
  // wall-clock budget, so three slow buckets could spend three times the invocation's. The
  // port's deadline is established once per `fetch` and every request inside it is capped by
  // what remains, so a walk that runs long simply returns fewer buckets rather than overrunning
  // the host. Newest first, so the freshest data lands even when the budget stops the loop
  // early; the remaining gaps are the next pass's work.
  // ONE deadline for the whole backfill, created here and handed to every bucket — see the
  // port's `deadlineMs`. Created by the pass because the pass is what the invocation kills.
  const passDeadline = Date.now() + (opts.wallClockMs ?? SIGNAL_WALL_CLOCK_MS);
  const answers: PlatformSignalFetch[] = [];
  for (const end of missing) {
    const a = await opts.port.fetch(
      { start: new Date(end - windowMs), end: new Date(end) },
      { deadlineMs: passDeadline },
    );
    answers.push(a);
    // A FAILURE STOPS THE LOOP rather than being collected past: one refusal is almost always
    // the token or the endpoint, and walking the remaining buckets would spend the budget
    // learning the same thing three times.
    if ("failed" in a || "unconfigured" in a) break;
  }

  // NOTHING MISSING IS NOT A FAILURE — the healthy steady state on a deployment whose clock has
  // not drifted. The prune still runs below; a pass with no gap to fill must not spend a walk
  // saying so, and must not report one.
  const answer: PlatformSignalFetch | null = answers[0] ?? null;

  // PRUNE ON EVERY PASS, including an unconfigured one, and that is deliberate: a deployment that
  // had a token and lost it must not keep a week of rows for ever, and the sweep is one indexed
  // range delete over a table with a few thousand rows.
  const pruned = await prune(db, new Date(now.getTime() - retentionMs));

  if (answer === null) return { outcome: "written", rows: 0, pruned };

  // ── WHAT SUCCEEDED IS PERSISTED FIRST, AND ONLY THEN IS THE FAILURE REPORTED ──────────
  //
  // Returning the failure before the upserts threw away every measurement the pass HAD made.
  // The shape that makes it bite: the newest bucket succeeds and an older gap keeps failing, so
  // each run discarded a fresh, complete reading on account of a stale one — and the detector
  // stayed dark for as long as the old gap persisted, which is exactly the state a persistent
  // failure produces. A measurement that was taken is evidence; another bucket's refusal does
  // not un-take it.
  //
  // The pass's OUTCOME is still the failure, so the caller's cron target goes red and the log
  // carries the code. What changes is that the rows already read are kept.
  const failed = answers.find((a) => "failed" in a) as { failed: string } | undefined;
  const unconfigured = answers.some((a) => "unconfigured" in a);
  const written: PlatformSignalRow[] = [];
  for (const a of answers) if (!("failed" in a) && !("unconfigured" in a)) written.push(...a.rows);
  for (const row of written) {
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

  // The outcome reflects the WORST thing that happened, over rows that are already persisted.
  // `unconfigured` outranks `failed` for the reason the three-way union exists: a deployment
  // that was never asked to measure anything is not failing.
  if (unconfigured) return { outcome: "unconfigured", rows: written.length, pruned };
  if (failed) return { outcome: "failed", code: failed.failed, rows: written.length, pruned };
  return { outcome: "written", rows: written.length, pruned };
}

/** Delete rows older than the cut. Returns how many went. */
async function prune(db: Db, cut: Date): Promise<number> {
  const gone = await db
    .delete(platformSignals)
    .where(sql`${platformSignals.windowStart} < ${cut.toISOString()}::timestamptz`)
    .returning();
  return gone.length;
}
