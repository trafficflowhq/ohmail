import { and, sql } from "drizzle-orm";
import { platformSignals } from "@trafficflow/db/cloud";
import type { Db } from "./context.js";

/**
 * THE 5xx POLLER — what the hosting platform served, read into this database for the rule. An
 * invocation that 502s and dies writes nothing here; the platform's request log is the surface
 * that knows (`scripts/vercel-errors.mjs` reads the same endpoint). THREE outcomes — `rows |
 * unconfigured | failed`: two arms would collapse "never measured" into "measured zero".
 * Unconfigured WRITES NO ROW; rule and panel both read `platformSignalWindow`, so "not measured"
 * and a real zero cannot blur. ONE unfiltered walk classifies rows by `statusCode`, so numerator
 * and denominator cover the same population; the walk is bounded and marked `truncated`, both
 * counts LOWER BOUNDS — safe for `errors_5xx ≥ 10` and the ≥ 2% ratio.
 */

/** The platforms `platform_signals.provider` admits. A second is an adapter and a review. */
export type SignalProvider = "vercel";

/** One window's traffic for one project, as counted. */
/**
 * WHY a bucket is a sample. Seven values, closed; the panel's sentence table is keyed on this
 * exact set, so a cause with no sentence fails a test rather than rendering an empty line.
 * `truncated` began meaning only `page_budget` and grew the others, so every other sample read as
 * page-budget exhaustion. THE SET IS ALSO CLOSED IN THE DATABASE — cloud 0030 CHECK-constrains
 * `sample_cause` to exactly these words, and a test reads that migration and compares it to this
 * array. Add a cause here without there and the poll throws at the write, losing the window.
 */
export const SAMPLE_CAUSES = [
  /** The walk stopped after its maximum number of pages. */
  "page_budget",
  /** Read before the platform had finished indexing the closed bucket. */
  "settle_margin",
  /** A row arrived with no environment or target, so the population is not knowably production. */
  "missing_provenance",
  /** A row's request id could not be read, so it cannot be de-duplicated and was skipped. */
  "unreadable_request_id",
  /** The pass's wall-clock deadline expired mid-walk. */
  "deadline",
  /** The cursor stopped advancing — the endpoint said more rows exist and returned none. */
  "stalled_cursor",
  /** More rows exist but they share the window's first instant, so there is nowhere to page to. */
  "boundary_unread",
] as const;

export type SampleCause = (typeof SAMPLE_CAUSES)[number];

export interface PlatformSignalRow {
  provider: SignalProvider;
  /** The platform's own project name (`ohmail-api`) — an identifier this repository chooses. */
  project: string;
  windowStart: Date;
  requests: number;
  errors5xx: number;
  /** A sample: both counts are lower bounds over the newest slice of the window. */
  truncated: boolean;
  /** WHICH of the six causes made it one, or null when it is not a sample. */
  sampleCause: SampleCause | null;
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
 * Where a project NAME is exchanged for the id the log endpoint wants. `projectId` on the
 * request-log endpoint is the platform's internal id, not the name — passing the configured name
 * (`ohmail-api`) matched nothing, the table stayed empty, and the board's "5xx: not measured" is
 * indistinguishable from a deployment with no token, which is why nothing noticed.
 * `scripts/vercel-errors.mjs` resolves the name to `proj.id`; this is that call, in the port that
 * needed it. TWO HOSTS: the versioned REST API is `api.vercel.com`; the request-log endpoint is
 * the DASHBOARD origin (`vercel.com/api/logs/...`). Resolving against the wrong one fails before
 * any log is read — same empty table, same "not measured".
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
 * THE WALL-CLOCK BUDGET FOR ONE POLL — separate from the page budget, which bounds laps but not
 * their DURATION: each lap has its own 15 s timeout, so twenty laps against a slow endpoint is
 * 300 s for one project, inside a cron target that declares 60 s and a platform that kills the
 * invocation. Dying mid-walk writes NO row, and the board's "not measured" is indistinguishable
 * from having no token — a slow endpoint would take the rule dark and look like configuration. 40
 * s leaves room inside the 60 for the prune and upsert that follow. Crossing it stops the walk
 * and marks the row `truncated` — a partial count over the newest slice, honest about being
 * partial.
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

/**
 * How long after a bucket CLOSES before a read may be called complete. A closed window is not an
 * INDEXED window: a pass firing seconds after the boundary gets a well-formed, non-truncated page
 * missing the requests still entering the log store — and the late arrivals are the slow and
 * failing ones. The consequence was permanent: a non-truncated row is HELD, held buckets are
 * never re-polled, so the late 5xx never entered that bucket's numerator and the rate ran
 * systematically low. A read inside this margin is recorded as a SAMPLE — excluded from the
 * arithmetic AND from `held`, so the next pass re-polls and overwrites it with a settled read.
 * Costs one pass of latency; buys a finished population.
 */
export const SIGNAL_SETTLE_MS = 90 * 1000;

/** When the bucket that starts at `windowStart` closed. */
function row0End(windowStart: Date, windowMs: number): number {
  return windowStart.getTime() + windowMs;
}

/** How long `platform_signals` rows are kept. The rule reads 15 minutes; the board reads a day. */
export const SIGNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const trimmed = (v: string | undefined): string => (v ?? "").trim();

/**
 * One log row's timestamp in epoch milliseconds, or null when unreadable. THE CURSOR IS BUILT
 * FROM THIS, which is why it is a shared helper with a refusal, not an inline `Number()`. The
 * endpoint returns ISO-8601 STRINGS; `Number("2026-09-04T…")` is NaN, `NaN < oldest` is false, so
 * `oldest` never moves — every window needing more than one page stopped after the first and
 * reported page one's counts as a truncated whole window. `vercel-errors.mjs` refuses an
 * unparseable stamp for the same reason ("the time cursor cannot advance"). A number is still
 * accepted: epoch millis are what tests and a future endpoint shape would plausibly send, one
 * branch.
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
        // Set when any page hands back a row whose request id cannot be read: the counts below
        // become a floor rather than a population, and the row says so. See the mixed-page note.
        let sampled: SampleCause | null = null;
        /**
         * THE ONE WAY A SHORTENED WALK LEAVES THIS FUNCTION. Two paths end one early — the
         * budget/deadline check at the top of the loop and the fetch timeout below it — and they
         * used to answer differently, one persisting what it had counted and the other throwing
         * it away. A shared constructor is what stops that happening a third time.
         */
        const partial = (cause: SampleCause) => ({
          row: {
            provider: "vercel" as const, project, windowStart: window.start,
            requests, errors5xx, truncated: true, sampleCause: cause,
          },
        });
        let cursor = window.end.getTime();
        let pages = 0;
        /** Pages whose rows were actually read and counted — see the note at the increment. */
        let completed = 0;
        // ── WHY THE CURSOR STAYS INCLUSIVE AND THE DE-DUPLICATION IS THE ANSWER ──────────
        //
        // Each lap asks for everything up to and including the previous lap's OLDEST timestamp,
        // because several requests can share a millisecond: excluding that instant would drop
        // every row that shares it with the one we happened to see last. So the boundary row is
        // deliberately re-read, and `requestId` is what stops it being counted twice.
        //
        // This is also why the window's half-open correction belongs to `window.end` alone and
        // not to every lap — subtracting a millisecond per lap turns the deliberate overlap into
        // a gap, and the row was still stored as a complete population.
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
            // WHAT WAS COUNTED IS EVIDENCE, and it used to be thrown away on this path when the
            // deadline (rather than the page budget) ended the walk: the catch below returned a
            // failure and the pages already read went with it, so a slow endpoint left the
            // bucket MISSING and the rule dark despite real, if partial, measurement. The
            // declared end of a walk is not what happened during it.
            return partial(pages >= budget ? "page_budget" : "deadline");
          }
          pages++;
          const q = new URLSearchParams({
            // THE ID, not the name — see `VERCEL_PROJECT_URL`. The row below keeps the NAME,
            // because that is what an operator recognises on the board and what the config sets.
            projectId: ids.get(project) ?? project,
            ownerId: team,
            // PRODUCTION ONLY. The query was project-wide, and a project's log store holds
            // PREVIEW traffic too: a preview deployment poked by CI contributed its 5xx to the
            // paged population, and its successes diluted a real outage in the same denominator.
            // The alert names the API customers are using. Sent as a server-side filter AND
            // enforced locally on every row below — this endpoint has not been exercised against
            // the live service (see the standing gap), and a parameter the API quietly ignores
            // would leave the defect in place while reading as fixed.
            environment: "production",
            startDate: String(window.start.getTime()),
            // THIS API'S `endDate` IS INCLUSIVE AND OUR BUCKETS ARE HALF-OPEN: a request stamped
            // exactly on a five-minute boundary satisfies both adjacent buckets, and the dedupe
            // set is per bucket, so it counted twice in one fifteen-minute window — nine errors
            // read as ten. Made half-open HERE, the one place the foreign convention is visible:
            // one millisecond off the WINDOW'S end, so the boundary instant belongs to the newer
            // bucket. Never applied to `cursor` per lap — the cursor is inclusive precisely so
            // boundary rows are re-read and de-duplicated; a per-lap `- 1` skipped them while
            // still storing `truncated: false`.
            endDate: String(pages === 1 ? window.end.getTime() - 1 : cursor),
          });
          let res: Response;
          try {
            res = await doFetch(`${VERCEL_REQUEST_LOGS_URL}?${q}`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(budgetFor()),
            });
          } catch (err) {
            // A TIMEOUT AFTER A COMPLETED PAGE IS A PARTIAL WALK, NOT A FAILED ONE. Two paths end
            // a walk early and they had different answers: the budget check persisted its counts;
            // this catch — the NEXT fetch timing out — discarded them, so an endpoint that
            // answers one page then stalls wrote no row and the rule went dark on a window it had
            // partly measured. ONE EXIT for both: `partial()` is the only way a shortened walk
            // leaves, and the only decision here is which cause to name. A timeout with NOTHING
            // counted is still a failure — an unread window must never be written as a zero.
            const name = String((err as Error)?.name ?? "unknown");
            if (completed > 0 && (name === "TimeoutError" || name === "AbortError")) {
              return partial("deadline");
            }
            // The NAME only, never the message: a fetch error's message carries the URL, and this
            // string reaches a log line and an operator's screen.
            return { failed: `transport:${name}` };
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
          // `requestId` IS the dedupe key: a page where every row lacks one walks to 0 requests,
          // 0 errors, and — with `hasMoreRows: false` — a COMPLETE bucket of measured health
          // built from unreadable rows. Skipping individual blank ids stays right (an approximate
          // count is a usable rate); a page NONE of whose rows are usable is not evidence of a
          // quiet deployment. TRIMMED, because `" " !== ""`: a whitespace-only id passes an empty
          // check, de-duplicates nothing, and counts as a distinct request on every boundary
          // re-read.
          const usable = batch.filter(
            (r) => typeof r.requestId === "string" && r.requestId.trim() !== "");
          if (batch.length > 0 && usable.length === 0) {
            return { failed: "page_without_request_ids" };
          }
          // A PAGE THAT IS PART UNREADABLE MAKES THE BUCKET A SAMPLE. The all-blank case is
          // refused above; the MIXED case used to pass silently — readable rows counted, blanks
          // dropped, bucket stored complete. The missing rows may have been the successes, so the
          // surviving quotient can cross a threshold the true population never approaches, on a
          // bucket the rule believes it measured in full. The counts stay (a lower bound is worth
          // recording); the CLAIM changes: `truncated` already means "these numbers are a floor,
          // do not divide them", and the window read already excludes such buckets.
          if (usable.length < batch.length) sampled = "unreadable_request_id";
          let oldest = cursor;
          for (const r of batch) {
            // PROVENANCE: PRODUCTION, OR NOT COUNTED AT ALL. "No field means production" waves
            // every preview row through on any shape where the API ignores the
            // `environment=production` parameter — a backstop justifying the risk it fails to
            // cover. Three cases: NAMED PRODUCTION — counted. NAMED SOMETHING ELSE — refuse the
            // whole window: one preview row proves the filter is not applied, and a filtered
            // population read as complete is the defect. NAMED NOTHING — not counted, and the
            // bucket becomes a SAMPLE: excluded from the rate and re-polled. On logs that
            // genuinely carry no such field the rule stays dark and says so.
            const env = typeof (r as { environment?: unknown }).environment === "string"
              ? (r as { environment: string }).environment
              : typeof (r as { target?: unknown }).target === "string"
                ? (r as { target: string }).target
                : null;
            if (env !== null && env !== "production") return { failed: "production_filter_ignored" };
            if (env === null) {
              // ── THE CURSOR MOVES ON A ROW WE DO NOT COUNT ─────────────────────────────
              //
              // `continue` skipped this row entirely, including the line further down that
              // lowers `oldest`. On a page whose rows ALL lack provenance the cursor therefore
              // did not move at all, the walk hit its no-progress guard, and the bucket was
              // reported as `stalled_cursor` — a cause naming the endpoint for something this
              // loop did. The row is excluded from the COUNTS, which is the decision; it is
              // still evidence of where in time the page reached.
              sampled = "missing_provenance";
              const skipTs = parseStamp(r.timestamp);
              if (skipTs !== null && skipTs < oldest) oldest = skipTs;
              continue;
            }
            const id = typeof r.requestId === "string" ? r.requestId.trim() : "";
            // A blank id cannot be de-duplicated, so counting it would inflate the boundary. It is
            // skipped rather than refused: unlike the census script, an approximate count over a
            // five-minute window is still a usable rate, and refusing the whole poll over one
            // malformed row would take the rule dark for a schema wobble.
            if (id.length === 0 || seen.has(id)) continue;
            seen.add(id);
            requests++;
            // AN UNREADABLE STATUS FAILS THE WALK — this is the field the rule is about: counting
            // a row whose status cannot be read as a non-error records a schema change as
            // measured health and silently disables the detector. One malformed row taking one
            // window to "not measured" is the safe direction; the next window recovers. STRICT
            // BEFORE COERCING: `Number(null)`, `Number("")`, `Number(false)` are all 0 — finite,
            // past an `isFinite` check, recorded as successful non-5xx requests. A BLANK STRING
            // IS NOT A STATUS: `Number(" ")` is 0 too, and a schema wobble emptying this field
            // would dilute the error rate with fabricated successes or suppress the alert
            // outright.
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

          // A PAGE IS COUNTED, NOT MERELY ATTEMPTED. `pages` is incremented before the request
          // — it bounds the number of laps — so it is 1 while the FIRST fetch is still in
          // flight, and using it to decide "have we measured anything" turned a timeout on the
          // very first request into a partial sample over zero rows. That is the unread window
          // written as a zero, which is the thing this file exists to make unrepresentable.
          completed++;

          // ── UNREAD ROWS AT THE WINDOW'S START ARE NOT A COMPLETE BUCKET ─────────────
          //
          // The loop's condition is `cursor > window.start`, so when a page's oldest row is
          // stamped exactly at the start — which happens when more than one page of requests
          // shares the boundary millisecond — the next lap is not taken. That is correct as far
          // as it goes: there is nowhere left to page to. What was wrong is that the endpoint had
          // just said `hasMoreRows: true`, and the bucket was persisted as COMPLETE anyway. The
          // rows it admits to withholding are as likely to be successes as errors, so the
          // surviving quotient can cross the rate floor and manufacture a critical page.
          if (data.hasMoreRows !== false && oldest <= window.start.getTime()) {
            return partial("boundary_unread");
          }

          if (data.hasMoreRows === false) break;
          // A lap that advanced the cursor by NOTHING is a hard stop, not an infinite loop —
          // fifty requests inside one millisecond would spin until the invocation is killed.
          // Marked truncated, because it is: the rest of the window is genuinely unread. AN EMPTY
          // BATCH WITH `hasMoreRows: true` LANDS HERE TOO, and `truncated` is right for it — the
          // endpoint said more rows exist and handed back none, so the cursor cannot advance and
          // everything older stays unread; a complete count here would put a confident total on a
          // board for a window the poll never finished.
          if (oldest >= cursor) {
            return partial("stalled_cursor");
          }
          cursor = oldest;
        }

        return {
          row: {
            provider: "vercel", project, windowStart: window.start, requests, errors5xx,
            // Not `false` — a page with unreadable rows in it made this window a sample, and the
            // walk finishing does not make the population whole again.
            truncated: sampled !== null,
            sampleCause: sampled,
          },
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
 * One poll: read the window that just closed, upsert it, prune past retention. The window is the
 * one that JUST CLOSED, not the one in progress: an in-progress window is short (two minutes of
 * traffic stored as five inflates the summed rate), and the log store lags — the late rows are
 * exactly the slow and failing ones, undercounting 5xx where undercounting loses a page. ALIGNED
 * TO THE CLOCK, not the poll time, so drifting cadences never write overlapping windows: the key
 * is `(provider, project, window_start)` and a re-poll is an UPSERT of the same row. NEVER THROWS
 * for a fetch failure — the pass reports it; a database failure propagates, because a pass that
 * cannot write has measured nothing and must not report success.
 */
export async function runPlatformSignalPass(
  db: Db, opts: PlatformSignalPassOptions,
): Promise<PlatformSignalPassReport> {
  const now = (opts.now ?? (() => new Date()))();
  const windowMs = opts.windowMs ?? SIGNAL_WINDOW_MS;
  const retentionMs = opts.retentionMs ?? SIGNAL_RETENTION_MS;

  // ONE BUCKET PER PASS: THE NEWEST THAT IS NOT COMPLETE. Polling only `floor(now)` drifts —
  // cadence + jitter + walk duration crosses a boundary, 12:04:59 becomes 12:10:20, and the
  // skipped bucket is skipped for ever, so the rule divides a two-bucket numerator by a window it
  // advertises as three. ONE FETCH, NOT A LOOP: filling every missing bucket in one pass gave
  // each fetch its OWN wall-clock budget (three slow buckets, three budgets, inside a 60 s
  // invocation), no writes until every fetch returned, and only the first answer inspected.
  // Newest incomplete first, so the rule gets the freshest data; an older gap fills on following
  // passes — a three-bucket hole closes in fifteen minutes.
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

  // EVERY MISSING BUCKET, NEWEST FIRST, UNDER THE PORT'S ONE SHARED DEADLINE. One fetch per pass
  // could not CATCH UP: the cron rearms after completion, every invocation finds a newly closed
  // bucket, and an older gap aged out of the fifteen-minute window without repair — the rule
  // undercounted for ever, quietly. Looping is safe NOW: the deadline is established once per
  // pass and every request is capped by what remains, so a long walk returns fewer buckets rather
  // than overrunning the host. Newest first, so the freshest data lands even when the budget
  // stops the loop; the rest is the next pass's work. ONE deadline, created here, because the
  // pass is what the invocation kills.
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

  // WHAT SUCCEEDED IS PERSISTED FIRST; ONLY THEN IS THE FAILURE REPORTED. Returning the failure
  // before the upserts threw away every measurement the pass HAD made: with the newest bucket
  // succeeding and an older gap failing persistently, each run discarded a fresh complete reading
  // on account of a stale one, and the detector stayed dark as long as the gap did. A measurement
  // taken is evidence; another bucket's refusal does not un-take it. The pass's OUTCOME is still
  // the failure — the cron target goes red and the log carries the code — but the rows already
  // read are kept.
  const failed = answers.find((a) => "failed" in a) as { failed: string } | undefined;
  const unconfigured = answers.some((a) => "unconfigured" in a);
  const written: PlatformSignalRow[] = [];
  for (const a of answers) if (!("failed" in a) && !("unconfigured" in a)) written.push(...a.rows);
  for (const raw of written) {
    // ── A REPAIR FOR ONE PROJECT DOES NOT REWRITE ANOTHER'S FINISHED ROW ──────────────
    //
    // A bucket becomes eligible for repair when ANY expected project is missing or sampled in
    // it, and the port then re-polls EVERY project for that window — it has one endpoint and one
    // walk. So a pass sent to finish project B came back with a fresh answer for project A too,
    // and if that later walk hit its page budget on A, a COMPLETE A row was replaced by a sample.
    // With two projects whose walks fail alternately, no pass ever leaves both complete, and the
    // rule stays dark for ever while each project has in fact been measured.
    //
    // `held` is the set already complete for this window, and rows in it are not ours to touch.
    if (held.has(`${raw.project}@${raw.windowStart.getTime()}`)) continue;
    // THE SETTLE MARGIN, applied here because this is where the pass's clock is. See
    // `SIGNAL_SETTLE_MS`: a read taken before the log store has finished indexing a closed
    // bucket is a sample of it, and saying so is what gets the bucket re-polled instead of
    // frozen at its first, thinnest reading.
    const settledAt = row0End(raw.windowStart, windowMs) + SIGNAL_SETTLE_MS;
    // The settle margin names ITSELF as the cause; a row that was already a sample for another
    // reason keeps the reason it arrived with, because that one happened first.
    const row = now.getTime() >= settledAt
      ? raw
      : { ...raw, truncated: true, sampleCause: raw.sampleCause ?? "settle_margin" as const };
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
        sampleCause: row.sampleCause,
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
          sampleCause: row.sampleCause,
          fetchedAt: sql`${now.toISOString()}::timestamptz`,
        },
        // A COMPLETE ROW NEVER REGRESSES TO A SAMPLE — the skip above states the invariant where
        // the pass decides; this states it where the row is written. The two are REDUNDANT (the
        // cross-project test goes red only when BOTH are removed — measured by mutation, which is
        // why mutations and not reasoning decide these sentences); both stay, because a caller
        // not coming through the pass has only this one. AND ONLY A NEWER READ OVERWRITES: two
        // passes can overlap, and the slower can answer last with an EARLIER view — unfenced, it
        // rewound counts and `fetched_at`, and a stale non-truncated answer held the bucket
        // complete on the poorer read. The row's own stamp is the fence, the same shape the alert
        // row and the pass row use.
        setWhere: sql`${platformSignals.fetchedAt} <= ${now.toISOString()}::timestamptz
          and (${row.truncated ? sql`${platformSignals.truncated}` : sql`true`})`,
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
