/**
 * EVERY PATH PARAMETER IS REFUSED BY SHAPE, AT THE DOOR, BEFORE ANY PIPELINE RUNS.
 *
 * ── THE DEFECT THIS FILE IS THE GUARD FOR ────────────────────────────────────────────────────
 *
 * `GET /drafts/:id` passed `params.id!` — a non-null assertion, which asserts PRESENCE and says
 * nothing about SHAPE — into an account-scoped select on a `uuid` column. Postgres answered
 * `22P02 invalid input syntax for type uuid`; that is a `PostgresError`, so it is not a
 * `ServiceError` and not `isDbBusy`, and `withErrorEnvelope` classified it as an unhandled fault
 * and returned `500 internal error`. Measured live on the hosted service on 2026-09-04: eight of nine
 * reachable GET-by-id routes did this, and `/drafts/43bc3fd2-…-3092991614ff` did it 168 times in
 * thirteen minutes. Full evidence in the project's design notes.
 *
 * ── WHY THE SHAPES ARE THE ONES THEY ARE ─────────────────────────────────────────────────────
 *
 * `%0A`, `%20` and `%09` are in this list because they are the reason the defect survived being
 * looked at. `tryMatch` percent-decodes each segment, so a trailing newline, space or tab reaches
 * the column as a real byte — while a log line renders it IDENTICALLY to a clean id. An operator
 * reading `GET /drafts/43bc3fd2-df61-4041-8e1c-3092991614ff → 500` cannot tell that request from
 * one whose id was well-formed, which is why the row looked healthy and the route looked haunted.
 * `ONE_SHORT` is the same trap by a different route: 32 hex digits hide a missing one well.
 *
 * ── WHY IT IS DRIVEN, AND DERIVED ────────────────────────────────────────────────────────────
 *
 * The matrix comes from `apiRoutes` itself, never from a hand-written list of routes. A list is
 * what the input-bounds census had, and the census was green for this defect's entire life because
 * a route on a frozen list is a route nobody re-examines. Deriving means the route somebody adds
 * next Tuesday is covered by code already written, and `derives every param-bearing route` below
 * refuses to let the derivation quietly become empty.
 *
 * And it DRIVES `createApp`, rather than reading source for a call to `requireUuid`. A source scan
 * proves a string appears in a file; this proves an answer comes back. The distinction is the
 * whole reason the check moved into `createApp.handle` — see `firstMisshapenParam` for why a
 * middleware would have been green here and absent in production for `raw` and `anonymous` routes.
 */
import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type AdminConfig, type ApiDeps, type Route } from "@trafficflow/api";
import { STAFF_SESSION_HEADER } from "../src/routes/admin.js";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const ADMIN_SECRET = "admin-console-internal-secret-fixture-token";
const ADMIN: AdminConfig = { secret: ADMIN_SECRET, environment: "test" };
const STAFF_TOKEN = "staff-session-cookie-fixture-token";

const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null, admin: ADMIN });

/** A syntactically perfect uuid, so the only thing under test is the ONE param being spoiled. */
const GOOD = "43bc3fd2-df61-4041-8e1c-3092991614ff";

/**
 * The ten shapes, each with the name it is known by in the incident write-up.
 *
 * `" "` is a single space rather than the empty string on purpose: an empty segment does not
 * survive `segsOf`, so `/drafts//` is a 404 (no route of that arity) and never reaches this check.
 * That is correct behaviour and a different assertion.
 */
const SHAPES: ReadonlyArray<readonly [label: string, value: string]> = [
  ["not-a-uuid", "not-a-uuid"],
  ["numeric", "1"],
  ["literal undefined", "undefined"],
  ["literal null", "null"],
  ["a single space", " "],
  ["uuid + newline", `${GOOD}\n`],
  ["uuid + tab", `${GOOD}\t`],
  ["uuid + space", `${GOOD} `],
  ["space + uuid", ` ${GOOD}`],
  ["one character short", GOOD.slice(0, -1)],
];

/** `[":id", ":messageId"]` → the parameter names of one pattern, in path order. */
function paramsOf(pattern: string): string[] {
  return pattern.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1));
}

/** Every (route, param) pair in the shipped table, minus any the route declares opaque. */
function checkedParams(): Array<{ route: Route; param: string }> {
  const out: Array<{ route: Route; param: string }> = [];
  for (const route of apiRoutes) {
    for (const param of paramsOf(route.pattern)) {
      if (route.options?.opaqueParams?.includes(param)) continue;
      out.push({ route, param });
    }
  }
  return out;
}

/** The pattern with every param a good uuid except `spoil`, which gets `value`. */
function pathFor(pattern: string, spoil: string, value: string): string {
  return pattern
    .split("/")
    .map((s) => {
      if (!s.startsWith(":")) return s;
      return encodeURIComponent(s.slice(1) === spoil ? value : GOOD);
    })
    .join("/");
}

/** Admin routes are `anonymous` + secret-bearing; everything else takes the session bearer. */
function request(route: Route, path: string, bearer: string | undefined): Request {
  const isAdmin = route.pattern.startsWith("/admin/");
  const init: { bearer?: string; headers?: Record<string, string>; body?: string } = {};
  if (isAdmin) {
    init.bearer = ADMIN_SECRET;
    init.headers = { [STAFF_SESSION_HEADER]: STAFF_TOKEN };
  } else if (bearer) {
    init.bearer = bearer;
  }
  // A body on the unsafe methods so `withRequestGuard` is never the thing that answers — though
  // if the check is placed correctly it never runs at all, which is the point of the no-session
  // case below.
  if (route.method !== "GET" && route.method !== "DELETE") init.body = "{}";
  return req(route.method, path, init);
}

describe("path parameter shape (DRAFTS-500)", () => {
  it("derives every param-bearing route from the shipped table, and the derivation is not empty", () => {
    const pairs = checkedParams();
    // The census guards its own derivation the same way at `readingHelpers` — an empty derivation
    // makes every assertion below vacuously true, which is the failure mode that looks like a pass.
    expect(pairs.length).toBeGreaterThanOrEqual(70);
    // The route that started it, by name, so a refactor that drops `/drafts/:id` from the table
    // cannot quietly shrink this file's coverage to "everything else".
    expect(pairs.some((p) => p.route.method === "GET" && p.route.pattern === "/drafts/:id")).toBe(true);
    // The three the ruling names as the placement proof: one `raw`, one `raw`, one `anonymous`.
    for (const pattern of ["/attachments/:id", "/messages/:id/attachments/download-all", "/admin/accounts/:id"]) {
      expect(pairs.some((p) => p.route.pattern === pattern)).toBe(true);
    }
    // Ships empty (router.ts documents why). A future entry is a deliberate edit here.
    expect(apiRoutes.filter((r) => r.options?.opaqueParams !== undefined)).toEqual([]);
  });

  it("refuses all ten shapes on every parameter of every route, with a session, and never 500s", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const pairs = checkedParams();

    const wrong: string[] = [];
    for (const { route, param } of pairs) {
      for (const [label, value] of SHAPES) {
        const path = pathFor(route.pattern, param, value);
        const res = await H(request(route, path, s.token), deps);
        if (res.status !== 400) {
          wrong.push(`${route.method} ${route.pattern} [${param}] ${label} → ${res.status}`);
          continue;
        }
        const body = (await res.json()) as { error?: { code?: string; message?: string; retryable?: boolean } };
        if (body.error?.code !== "validation_failed" || body.error?.message !== `${param} must be an id`) {
          wrong.push(`${route.method} ${route.pattern} [${param}] ${label} → ${JSON.stringify(body.error)}`);
        }
      }
    }
    // The whole matrix in one message: a per-request assertion stops at the first failure and hides
    // how wide the defect is, which is exactly what made this look like one route's problem.
    expect(wrong).toEqual([]);
  });

  it("carries `retryable: false`, so no client's default branch decides a malformed id is worth repeating", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    const res = await H(req("GET", "/drafts/not-a-uuid", { bearer: s.token }), deps);
    expect(res.status).toBe(400);
    // `http-adapter.ts` reads `retryable ?? (status >= 500 || status === 429)`. A 400 is already
    // non-retryable by that default, so this is belt: the field is stated, never inferred, because
    // the whole DRAFTS-500 client half is about a default that decided wrong.
    expect(await res.json()).toEqual({
      error: { code: "validation_failed", message: "id must be an id", retryable: false },
    });
  });

  it("refuses before the session is resolved — the same 400 with no credential at all", async () => {
    const { deps } = await makeDeps();

    // Proves PLACEMENT, not just presence. `withSession` would answer 401 and `withRequestGuard`
    // 403; a 400 here is only reachable from above the pipeline, which is the one position that
    // also covers the `raw` and `anonymous` chains and the sidecar's own `createApp`.
    for (const path of ["/drafts/not-a-uuid", "/messages/1/body", "/threads/undefined"]) {
      const res = await H(req("GET", path), deps);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("validation_failed");
    }
  });

  it("leaves well-formed ids alone — the shape check is not an authorization decision", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    // A canonical uuid naming no row of this account still reaches the handler and gets its
    // ordinary 404. If this ever answers 400 the check has stopped being about shape.
    const res = await H(req("GET", `/drafts/${GOOD}`, { bearer: s.token }), deps);
    expect(res.status).toBe(404);

    // Uppercase is canonical too (`isUuid` is case-insensitive), and a real client's id can arrive
    // that way from a hand-typed URL.
    const upper = await H(req("GET", `/drafts/${GOOD.toUpperCase()}`, { bearer: s.token }), deps);
    expect(upper.status).toBe(404);
  });
});
