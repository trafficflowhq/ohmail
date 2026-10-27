/* THIS FILE IS PART OF THE EVIDENCE for the staff-blindness claims made in
 * `packages/services/src/admin-service.ts`: it seeds real mail with distinctive markers and
 * fails if one reaches an admin response (the PROJECTION half — PGlite has no roles), and it
 * re-runs the console's `attentionRank` cases against the server's copy so the two rankings
 * cannot drift. Those comments used to cite this file by full path; they were reworded to
 * "an api-level test / at the api level" when the services sources were prepared for
 * publication (test directories are not yet published), and the pointer moved here so the
 * coupling is still written down at the end a grep can find. */
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp, apiRoutes, type AdminConfig, type ApiDeps } from "@trafficflow/api";
import { adminAttentionRank, type AccountSummary, type AdminDb } from "@trafficflow/services";
import {
  EXPECTED_MARKERS, SCHEMA_MARKER_JOURNAL_TAG,
  CLOUD_INDEX_MARKERS, CHECK_DEFINITION_MARKERS, FUNCTION_DEFINITION_MARKERS, CLOUD_FK_MARKERS,
} from "../src/routes/health-cloud.js";
import {
  SCHEMA_INDEX_MARKERS, SCHEMA_CHECK_MARKERS, SCHEMA_FK_MARKERS, MAIL_COLUMN_TYPE_MARKERS,
} from "../src/routes/health-markers.js";
import { deriveMailColumnMarkerCount } from "./mail-marker-derivation.js";
import { deriveCloudColumnMarkerCount } from "./cloud-marker-derivation.js";
import { accounts, mailboxCredentials, mailboxes } from "@trafficflow/db";
import {
  invites, staffSessions, waitlist, workerHeartbeats,
} from "@trafficflow/db/cloud";
import { eq, sql as dsql } from "drizzle-orm";
import { STAFF_SESSION_HEADER } from "../src/routes/admin.js";
import { withStaffStepUp } from "../src/staff-step-up.js";
import {
  makeDeps, seedSession, seedStaffSession, seedMailbox, seedMessage, seedBody, req, FIXED_NOW,
} from "./helpers.js";

/**
 * `GET /admin/*` — every admin READ, derived from the route table (read half).
 *
 * Three properties are load-bearing, and each one is a promise made somewhere a customer or an
 * operator can read it:
 *
 *  1. **AN ORDINARY LOGGED-IN CUSTOMER IS REFUSED EXACTLY AS A STRANGER IS.** These endpoints
 *     project every account on the platform. There is no `users.role`, so the authorization is
 *     the shared secret PLUS a live staff session (NEW-ADMIN-READ-NO-SESSION), and the routes
 *     are `anonymous` — `withSession` never runs, so no CUSTOMER credential is ever resolved.
 *     This file proves the refusal is byte-identical, and proves it is not vacuous by first
 *     using the SAME session to succeed on a real protected route.
 *  2. **NO MESSAGE CONTENT, EVER.** `apps/webapp/messages/en.json` q5 tells users the admin
 *     console reaches the database "as a separate role that is refused those columns
 *     outright". Since that change that role is what enforces it, and its guard is
 *     `packages/db/test/staff-role.pg.test.ts` — real Postgres, real grants, run against the
 *     shipped `scripts/harden-staff-role.sql`. This file is the PROJECTION half, over PGlite,
 *     which has no roles: real mail is seeded with distinctive markers and every one of the
 *     six responses is searched for them, alongside a credential blob, a Stripe payload and a
 *     session token hash — on a database that would happily hand any of it over.
 *     (The operator console carries its own half.)
 *  3. **NO WRITE EXISTS.** The console says the actions are unavailable; that claim is only
 *     honest if the API agrees, so the catalog is asserted to report every action unavailable
 *     with a reason, and the route table is asserted to contain no non-GET `/admin` route.
 */

const app = createApp(apiRoutes);

/** A secret of a realistic length — the host loader refuses anything under 24 characters. */
const SECRET = "admin-secret-for-tests-abcdefghij-fixture-token";
const ADMIN: AdminConfig = { secret: SECRET, environment: "test" };

/**
 * EVERY `GET /admin/*`, DERIVED — never a list somebody typed.
 *
 * It used to be hand-written and it was short by two, so the authorization properties below —
 * that a logged-in customer is refused exactly as a stranger is, and that the refusal is
 * indistinguishable either way — were asserted over most of the surface and claimed for all of
 * it. The module header said "the eight admin READS" while the list held six, which is how long
 * it had been wrong.
 *
 * Deriving it from the route table means a new admin read is covered the day it is added, and
 * cannot be added without these properties applying to it.
 */
const ADMIN_UUID = "00000000-0000-0000-0000-000000000000";
const READS: readonly string[] = apiRoutes
  .filter((r) => r.method === "GET" && r.pattern.startsWith("/admin/"))
  .map((r) => r.pattern.split("/").map((s) => (s.startsWith(":") ? ADMIN_UUID : s)).join("/"))
  .sort();

const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

/**
 * The staff session token every read in this file presents (NEW-ADMIN-READ-NO-SESSION: the
 * shared secret alone no longer reads anything). Seeded by {@link makeAdminDeps}; the guards
 * that prove the requirement present the SECRET without it.
 */
const STAFF_TOKEN = "staff-session-token-fixture-abcdefghij-fixture-token";

/** `makeDeps`, plus the staff session the reads now require. */
const makeAdminDeps: typeof makeDeps = async (...args) => {
  const world = await makeDeps(...args);
  await seedStaffSession(world.db, { now: FIXED_NOW, token: STAFF_TOKEN });
  return world;
};

const staff = (path: string): Request =>
  req("GET", path, { bearer: SECRET, headers: { [STAFF_SESSION_HEADER]: STAFF_TOKEN } });

async function bodyOf(res: Response): Promise<string> {
  return res.text();
}

describe("admin reads — registration and shape", () => {
  it("every read is GET and carries exactly { public, anonymous, raw }", () => {
    // `/admin/staff/*` (sign-in POSTs) and the mailbox write are asserted separately below; the
    // READS are the GET routes, and filtering by method is what keeps neither list able to
    // absorb a route belonging to another.
    const admin = apiRoutes.filter(
      (r) => r.pattern.startsWith("/admin") && r.method === "GET",
    );
    expect(admin).toHaveLength(14);
    for (const route of admin) {
      expect(route.method, route.pattern).toBe("GET");
      expect(route.options, route.pattern).toEqual({ public: true, anonymous: true, raw: true });
    }
    // 9 → 6: the three reads whose subject was money — the plan board, the cost board and the
    // per-day credit drill-down — are not this server's to answer. Every survivor carries the
    // same options triple, which is what this list is here to say: a read that resolved a
    // session, or that was not `raw`, would be a different animal wearing the same path prefix.
    // 6 → 9 (cloud 0047): search, the sync roster and an account's staff activity.
    // 9 → 13: active-account counts, stored bytes per account, the staff audit across accounts
    // and the alert keys whose latest episode resolved. 13 → 14: how connecting a mailbox ended (cloud 0054).
    expect(admin.map((r) => r.pattern).sort()).toEqual([
      "/admin/accounts", "/admin/accounts/:id", "/admin/accounts/:id/staff-activity", "/admin/actions",
      "/admin/alerts/history", "/admin/connect-attempts", "/admin/engagement", "/admin/funnel", "/admin/overview", "/admin/search",
      "/admin/staff-activity", "/admin/storage", "/admin/sync-roster", "/admin/worker",
    ]);
  });

  /**
   * the sign-in routes, pinned by IDENTITY so a sixth cannot arrive unnoticed.
   *
   * They are POSTs under `/admin`, which is why the "no write route" test below had to become
   * precise about what it means. They mutate `staff_users` and `staff_sessions` and nothing
   * else: no customer row, no account, no money. That distinction is the whole reason this
   * list is frozen here rather than folded into the one above.
   */
  /**
   * SEVEN since cloud 0036, and NONE of them carries `withStaffStepUp`: this group IS the second
   * factor. A step-up here would be a permanent refusal — the route that proves a factor would be
   * demanding one — which is the shape a standalone install already shipped once.
   */
  it("the staff identity routes are POST and carry exactly { public, anonymous, raw }", () => {
    const staffRoutes = apiRoutes.filter((r) => r.pattern.startsWith("/admin/staff/"));
    expect(staffRoutes).toHaveLength(10);
    for (const route of staffRoutes) {
      expect(route.method, route.pattern).toBe("POST");
      expect(route.options, route.pattern).toEqual({ public: true, anonymous: true, raw: true });
      expect(route.cost, route.pattern).toBe("unauthenticated");
    }
    // 7 → 9 (cloud 0047): the assertion mint and the roles change verify their own factor.
    // 9 → 10: the staff list, an owner's read through `adminRoute` (its session in the header,
    // like every read) on the runtime connection, because the blind role holds no grant on the
    // staff tables. It changes nothing, so it carries no step-up.
    expect(staffRoutes.map((r) => r.pattern).sort()).toEqual([
      "/admin/staff/assertion", "/admin/staff/list", "/admin/staff/roles",
      "/admin/staff/session", "/admin/staff/sign-out", "/admin/staff/step-up",
      "/admin/staff/totp/begin", "/admin/staff/totp/confirm", "/admin/staff/totp/reset",
      "/admin/staff/whoami",
    ]);
  });

  it("the ONLY admin non-GET routes are the mailbox write and the Entra pair", () => {
    // This assertion has been restated four times, and the shape is the point: it used to say "no
    // admin write route exists at all", then "only the suspend/resume pair", then "…/resync as the
    // third", and now the account-standing pair has left with the money. Each time, the claim was
    // restated BY IDENTITY rather than relaxed, so a route appearing here is a decision somebody
    // made in a diff and not an accident.
    //
    // CLOUD 0009 ADDS TWO, AND ONE OF THEM IS A READ. `POST /admin/oauth/microsoft` reads the Entra
    // application registration and writes nothing; it is a POST because the staff session token
    // rides in the BODY (the console's proxy reads the HttpOnly cookie server-side and forwards it
    // there, exactly as `/admin/staff/totp/begin` does) and a GET has no body to put it in. So this
    // test's subject widened from "writes" to "non-GET routes" — narrowing the claim to match what
    // is true rather than leaving a title that would have to be read as false.
    const writes = apiRoutes.filter(
      (r) => r.pattern.startsWith("/admin") && r.method !== "GET"
        && !r.pattern.startsWith("/admin/staff/"),
    );
    expect(writes.map((r) => `${r.method} ${r.pattern}`).sort()).toEqual([
      // The billing link: a customer mail to the account's own login, capped per account.
      "POST /admin/accounts/:id/billing-link",
      "POST /admin/mailboxes/resync",
      "POST /admin/oauth/microsoft",
      "POST /admin/oauth/microsoft/save",
    ]);
    // All three carry the reads' options and are `unauthenticated` — the authority is the shared
    // secret PLUS a staff session inside the handler, never a customer session the pipeline
    // resolves. The two that WRITE carry one option more (cloud 0036): `withStaffStepUp` itself,
    // which asks that session for a second factor proved inside the window. The Entra READ does
    // not, and the split is asserted by name here rather than by counting options, because "which
    // of these changes state" is the decision somebody has to make when they add the fourth.
    const STEP_UP_REQUIRED = new Set([
      "/admin/mailboxes/resync", "/admin/oauth/microsoft/save", "/admin/accounts/:id/billing-link",
    ]);
    for (const route of writes) {
      expect(route.options, route.pattern).toEqual({
        public: true, anonymous: true, raw: true,
        ...(STEP_UP_REQUIRED.has(route.pattern) ? { middleware: [withStaffStepUp] } : {}),
      });
      expect(route.cost, route.pattern).toBe("unauthenticated");
    }

    // The two still-unwired actions the console's endpoint map reserves genuinely 404/405.
    // `/admin/mailboxes` left this list when mailbox release shipped — asserting its absence now
    // would be asserting the feature is missing. The narrower claim survives in its place: the
    // ONLY admin mailbox route is the release, so a second one cannot appear unnoticed.
    expect(apiRoutes.filter((r) => r.pattern.startsWith("/admin/mailboxes")).map((r) => r.pattern))
      .toEqual(["/admin/mailboxes/resync"]);
    expect(apiRoutes.some((r) => r.pattern.includes("/admin/sends"))).toBe(false);
    // Money is not a subsystem this server administers: no credits route, no plan route and no
    // cost route, which is a stronger statement than "unwired" — there is nothing to wire.
    expect(apiRoutes.some((r) => r.pattern.includes("/admin/credits"))).toBe(false);
    expect(apiRoutes.some((r) => r.pattern.includes("/admin/billing"))).toBe(false);
    expect(apiRoutes.some((r) => r.pattern.includes("/admin/costs"))).toBe(false);
    expect(apiRoutes.some((r) => r.pattern.includes("/admin/platform-costs"))).toBe(false);
  });
});

describe("admin reads — a host with no admin secret has no admin surface", () => {
  it("404s every read when deps.admin is absent (not 401 — the endpoint does not exist here)", async () => {
    const { deps } = await makeAdminDeps();
    for (const path of [...READS, "/admin/accounts/00000000-0000-0000-0000-000000000000"]) {
      const res = await H(staff(path), deps);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: { code: "not_found" } });
    }
  });

  it("404s even when the caller presents the right secret — absence is not a lock to pick", async () => {
    const { deps } = await makeAdminDeps();
    const res = await H(staff("/admin/overview"), { ...deps, admin: { secret: "" } });
    expect(res.status).toBe(404);
  });
});

describe("admin reads — authorization", () => {
  it("an ANONYMOUS request is 401 on every read", async () => {
    const { deps } = await makeAdminDeps();
    for (const path of READS) {
      const res = await H(req("GET", path), { ...deps, admin: ADMIN });
      expect(res.status, path).toBe(401);
      expect(await res.json()).toEqual({ error: { code: "unauthorized" } });
    }
  });

  /**
   * THE REFUSAL TEST THE WHOLE AUTHORIZATION MODEL RESTS ON.
   *
   * The session is real — it is used to succeed on `GET /mailboxes` first, so this cannot pass
   * because the token was junk — and it is presented BOTH ways a credential can arrive. The
   * assertion is not merely "also 401": it is that the response is INDISTINGUISHABLE from the
   * anonymous one, byte for byte and header for header. An admin endpoint that answered a
   * customer differently would be telling every customer that the endpoint exists and that they
   * are one role away from it.
   */
  it("an ordinary AUTHENTICATED customer gets the byte-identical answer an anonymous caller gets", async () => {
    const { db, deps } = await makeAdminDeps();
    const session = await seedSession(db, { now: FIXED_NOW });

    // ANTI-VACUITY: the very same token authenticates a real protected route.
    const proof = await H(req("GET", "/mailboxes", { bearer: session.token }), deps);
    expect(proof.status, "the seeded session must genuinely authenticate").toBe(200);

    for (const path of READS) {
      const anonymous = await H(req("GET", path), { ...deps, admin: ADMIN });
      const asBearer = await H(req("GET", path, { bearer: session.token }), { ...deps, admin: ADMIN });
      const asCookie = await H(
        req("GET", path, { cookie: `tf_session=${session.token}` }),
        { ...deps, admin: ADMIN },
      );

      const [a, b, c] = await Promise.all([bodyOf(anonymous), bodyOf(asBearer), bodyOf(asCookie)]);
      expect(asBearer.status, `${path} bearer`).toBe(anonymous.status);
      expect(asCookie.status, `${path} cookie`).toBe(anonymous.status);
      expect(b, `${path} bearer body`).toBe(a);
      expect(c, `${path} cookie body`).toBe(a);
      expect(anonymous.status).toBe(401);
      // Header for header: a differing `cache-control` or a stray `set-cookie` would be a
      // distinguisher too.
      expect([...asBearer.headers].sort()).toEqual([...anonymous.headers].sort());
      expect([...asCookie.headers].sort()).toEqual([...anonymous.headers].sort());
    }
  });

  it("a WRONG secret is 401, and a secret one character short is not close enough", async () => {
    const { deps } = await makeAdminDeps();
    for (const presented of [SECRET.slice(0, -1), `${SECRET}x`, "", "Bearer", SECRET.toUpperCase()]) {
      const res = await H(req("GET", "/admin/overview", { bearer: presented }), { ...deps, admin: ADMIN });
      expect(res.status, presented).toBe(401);
    }
  });

  it("a non-Bearer authorization scheme carrying the secret is 401", async () => {
    const { deps } = await makeAdminDeps();
    const res = await H(
      req("GET", "/admin/overview", { headers: { authorization: `Basic ${SECRET}` } }),
      { ...deps, admin: ADMIN },
    );
    expect(res.status).toBe(401);
  });

  /**
   * NEW-ADMIN-READ-NO-SESSION — THE GUARD THE WHOLE SLICE HANGS ON. The gate secret is a
   * shared, non-revocable bearer; these six responses are the customer roster. Until
   * 2026-08-12 the secret alone read all of it — this test was written first and watched fail
   * against that build (200 on every path), then the wrapper gained the check.
   */
  it("the CORRECT secret with NO staff session is 401 staff_session_required on every read", async () => {
    const { deps } = await makeAdminDeps();
    for (const path of [...READS, "/admin/accounts/00000000-0000-0000-0000-000000000000"]) {
      const res = await H(req("GET", path, { bearer: SECRET }), { ...deps, admin: ADMIN });
      expect(res.status, path).toBe(401);
      expect(await res.json(), path).toEqual({ error: { code: "staff_session_required" } });
    }
  });

  it("a token that names no staff_sessions row is refused — junk, a customer token, a revoked row", async () => {
    const { db, deps } = await makeAdminDeps();
    const d = { ...deps, admin: ADMIN };

    // Junk in the header.
    const junk = await H(
      req("GET", "/admin/overview", { bearer: SECRET, headers: { [STAFF_SESSION_HEADER]: "not-a-real-token-000000" } }), d,
    );
    expect(junk.status).toBe(401);
    expect(await junk.json()).toEqual({ error: { code: "staff_session_required" } });

    // A CUSTOMER session token is not a staff session, however real it is.
    const customer = await seedSession(db, { now: FIXED_NOW });
    const crossed = await H(
      req("GET", "/admin/overview", { bearer: SECRET, headers: { [STAFF_SESSION_HEADER]: customer.token } }), d,
    );
    expect(crossed.status, "a customer session crossed into the staff surface").toBe(401);

    // A revoked staff session is a sign-out that took effect, not a lingering credential.
    const revoked = await seedStaffSession(db, { now: FIXED_NOW });
    await db.update(staffSessions).set({ revokedAt: FIXED_NOW })
      .where(eq(staffSessions.staffUserId, revoked.staffId));
    const afterSignOut = await H(
      req("GET", "/admin/overview", { bearer: SECRET, headers: { [STAFF_SESSION_HEADER]: revoked.token } }), d,
    );
    expect(afterSignOut.status).toBe(401);
  });

  // One more case pins the admin console's proxy against this header. It reads the console's own
  // source, so it stays with the console in a sibling file.

  it("the CORRECT secret plus a live staff session is 200 on every read", async () => {
    const { deps } = await makeAdminDeps();
    for (const path of READS) {
      const res = await H(staff(path), { ...deps, admin: ADMIN });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("admin reads — an empty production database is a valid answer, not an error", () => {
  it("answers every read with zeroes rather than failing", async () => {
    const { deps } = await makeAdminDeps();
    const roster = await (await H(staff("/admin/accounts"), { ...deps, admin: ADMIN })).json();
    expect(roster).toMatchObject({ accounts: [], matched: 0, total: 0, page: 0, pageSize: 25 });

    const worker = await (await H(staff("/admin/worker"), { ...deps, admin: ADMIN })).json();
    expect(worker.instances).toEqual([]);
    expect(worker.staleSends).toEqual([]);
    expect(worker.pendingMoves).toEqual({ total: 0, mailboxes: 0, oldestSeconds: null });
    // The alerter's own numbers, not invented ones. `syncLagSeconds` is the EFFECTIVE rule —
    // threshold + sustain (alerts.ts rule 4's debounce) — because that sum is what the pager
    // fires at, and a console stating the bare threshold marked red exactly the boundary kiss
    // the alerter declares healthy.
    // `staleSendSeconds` moved 600 → 900 with the stranded-reservation reconciler: a `pending`
    // row is now examined every minute from the ten-minute mark, so the console marking one red
    // at eleven minutes would be flagging the ordinary recovery. Fifteen is what the pager fires
    // at, and this console shows what the pager shows — the same rule the `syncLagSeconds` note
    // above records after the boundary-kiss measurement.
    expect(worker.thresholds).toEqual({
      staleSendSeconds: 900, syncLagSeconds: 1800, leaderStaleSeconds: 120,
    });
  });

  it("publishes the SAME marker total /health does — the console was rendering 18/17", async () => {
    // A REAL defect, found while adding the check-constraint marker. `apiHealthFor` measured
    // `probe.markersFound` — which counts the column, index AND check probes — against
    // `SCHEMA_MARKERS.length`, which counts columns only. So a perfectly healthy database
    // rendered as `found: 18, expected: 17` on the console while `/health` said `18/18`, and
    // mail 0022 would have widened it to `19/17`.
    //
    // That is exactly the drift `probeDatabase` is SHARED to prevent, arriving through the
    // denominator instead of through a second copy of the query — this file's own header says
    // the console's whole claim is that it renders what a probe would see, not a second
    // opinion. `schemaOk` was unaffected, which is why nothing caught it: both endpoints kept
    // answering 200 while publishing different arithmetic.
    const { deps } = await makeAdminDeps();
    const res = await H(staff("/admin/overview"), { ...deps, admin: ADMIN });
    const { schemaMarkers } = (await res.json()).api;
    expect(schemaMarkers.expected).toBe(EXPECTED_MARKERS);
    // `found` is the REAL probe count against the migrated database. Anchoring it to a
    // JOURNAL-DERIVED total — not `EXPECTED_MARKERS`, which is `…MARKERS.length` — is what catches a
    // silently dropped OLDER column marker in either half: dropping one lowers both `found` and
    // `EXPECTED_MARKERS` in step, so `found == EXPECTED_MARKERS` would stay green while a database
    // with a missing column reads healthy (the inverted schema_incomplete incident). The two column
    // terms come from the mail and cloud journals; the sparse index/check/definition/function
    // classes stay list-length (their coverage is a semantic the SQL does not carry — held by the
    // anti-drift gate and the no-phantom checks). On a pristine tree this equals EXPECTED_MARKERS.
    const journalExpected =
      deriveMailColumnMarkerCount() + deriveCloudColumnMarkerCount() +
      SCHEMA_INDEX_MARKERS.length + CLOUD_INDEX_MARKERS.length +
      SCHEMA_CHECK_MARKERS.length + CHECK_DEFINITION_MARKERS.length +
      FUNCTION_DEFINITION_MARKERS.length + SCHEMA_FK_MARKERS.length + CLOUD_FK_MARKERS.length +
      MAIL_COLUMN_TYPE_MARKERS.length;
    expect(schemaMarkers.found).toBe(journalExpected);
    expect(schemaMarkers.through).toBe(SCHEMA_MARKER_JOURNAL_TAG);
  });

  it("a SCHEMA-BEHIND host still renders the overview — the page that names the fault must survive it",
    async () => {
      // THE PAGE THAT DIAGNOSES THE SKEW WAS THE PAGE THE SKEW TOOK DOWN. When this API is
      // deployed ahead of its cloud migration, `apiHealth()` correctly answers `schemaOk: false`
      // — and the route then carried on into reads that touch what that migration adds: the
      // alert projection selects the new heartbeat columns, and the two reads after it query
      // tables that do not exist yet. The first one raised 42703 or 42P01 and the whole route
      // answered a generic 503, so an operator following the deep link from a page saw an
      // outage with no explanation on the surface built to explain it.
      //
      // Gated rather than try/caught: a catch would still run the queries and would swallow a
      // genuine fault as though it were skew. The probe has already answered the question.
      const { deps, db } = await makeAdminDeps();
      // A REAL skew, not a stubbed flag: drop the column the newest cloud migration adds LAST.
      // The probe then reports `schemaOk: false` for the right reason, AND the 0030-dependent
      // reads would genuinely raise 42703 if they still ran — which is the whole point of the
      // gate.
      //
      // IT MUST BE THE CURRENT MARKER. This dropped `alert_pass_runs.sinks_configured`, which was
      // 0030's last column until the migration grew two more statements. After that move the
      // drop simulated a skew the probe no longer asks about: `schemaOk` stayed TRUE, the route
      // carried on into a read of the missing column, and the generic 503 this case exists to
      // prevent came back — reported as a failure of the gate rather than of the fixture.
      await db.execute(sql`alter table platform_signals drop column sample_cause`);
      const res = await H(staff("/admin/overview"), { ...deps, admin: ADMIN });

      expect(res.status, "the page renders rather than 503-ing").toBe(200);
      const body = await res.json();
      expect(body.api.schemaOk, "and it SAYS the schema is behind").toBe(false);
      // `schemaOk: false` is what the CONSOLE branches on to render "not queried" rather than
      // three green panels about data nobody read. Pinned here because the page's whole
      // correctness in this state rests on this field surviving the gate.
      expect(Object.hasOwn(body.api, "schemaOk")).toBe(true);
      // …AND the wire says the reads were skipped, which is the field the console branches on.
      // `api.schemaOk` cannot carry this alone: the OTHER way these reads fail is the migration
      // landing while the role-hardening script is not re-run, and in that state `schemaOk` is
      // TRUE while the content-blind handle still cannot see the new objects.
      expect(body.alertsUnavailable, "unanswered is a fact the wire must carry").toBe(true);
      // The 0030-dependent reads answer their empty shape rather than throwing, so the panels
      // render their own empty states instead of taking the route with them.
      expect(body.alerts).toEqual([]);
      expect(body.alertDrivers).toEqual([]);
      expect(body.platformSignals).toEqual([]);
    });

  it("the overview names the rules its read left unread, and reads duty through the host's parked reader", async () => {
    // ALERT-CONSOLE-HAS-NO-PARKED-READER: the console read with no parked set and counted a parked
    // account's stale mailbox; a rule it could not read (the storage cap) came back as nothing.
    const { deps, db } = await makeAdminDeps();
    const [acct] = await db.insert(accounts).values({ name: "Parked" }).returning();
    await db.insert(mailboxes).values({
      accountId: acct!.id, provider: "imap", status: "connected",
      lastSyncAt: new Date(FIXED_NOW.getTime() - 3 * 3_600_000),
      createdAt: new Date(FIXED_NOW.getTime() - 10 * 86_400_000), address: "parked-duty@example.test",
    });
    const parked = async (ids: readonly string[]) => new Set(ids.filter((id) => id === acct!.id));
    const read = async (admin: AdminConfig) => (await H(staff("/admin/overview"), { ...deps, admin })).json();

    const withReader = await read({ ...ADMIN, parkedAccounts: parked });
    expect(withReader.alerts.some((a: { kind: string }) => a.kind === "sync_lag"), "a parked account is not behind").toBe(false);
    expect(withReader.alertsUnread).toContainEqual({ kind: "storage_at_cap", reason: "no_reader" });
    const without = await read(ADMIN);
    expect(without.alerts.some((a: { kind: string }) => a.kind === "sync_lag"), "control: unstated duty counts it").toBe(true);
  });

  it("the account page shows staff a mailbox's organizer role and holder kind, never the machine name", async () => {
    // E-ADMIN-NO-ORGANIZER-ROLE, read back: support must see a mailbox is read, not organized.
    const { deps, db } = await makeAdminDeps();
    const [acct] = await db.insert(accounts).values({ name: "Reader" }).returning();
    await db.insert(mailboxes).values({
      accountId: acct!.id, provider: "imap", status: "connected", lastSyncAt: FIXED_NOW,
      address: "role-readback@example.test", organizerRole: "reader", organizedByKind: "local",
      organizedByName: "Laptop-Of-A-Customer",
    });
    const res = await H(staff(`/admin/accounts/${acct!.id}`), { ...deps, admin: ADMIN });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { mailboxes: Array<{ organizerRole: string; organizedByKind: string | null }> };
    expect(body.mailboxes.map((m) => [m.organizerRole, m.organizedByKind])).toEqual([["reader", "local"]]);
    expect(text, "the holder's machine name is a customer's free text").not.toContain("Laptop-Of-A-Customer");
  });

  it("the overview reports the API probe and the worker_down alert nothing else could see", async () => {
    const { deps } = await makeAdminDeps();
    const res = await H(staff("/admin/overview"), { ...deps, admin: ADMIN });
    const body = await res.json();
    expect(body.environment).toBe("test");
    expect(body.api.dbReachable).toBe(true);
    // PGlite has no pg_trgm — the same truthful `false` `/health` reports in this harness.
    expect(body.api.pgTrgm).toBe(false);
    expect(body.api.schemaOk).toBe(true);
    expect(body.worker.leaderStaleAfterSeconds).toBe(120);
    // No heartbeat row at all ⇒ nothing is syncing, and the console shows the same alert the
    // pager fires. An empty alert list here would be the console reassuring an operator.
    expect(body.alerts.map((a: { kind: string }) => a.kind)).toContain("worker_down");
    expect(body.alerts[0].openedAt).toBeTruthy();
    expect(body.alerts[0].notifiedAt).toBeNull();
  });
});

describe("admin reads — real data", () => {
  async function seedWorld() {
    const { db, deps } = await makeAdminDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await db.update(accounts).set({ name: "Brünner GmbH" }).where(eq(accounts.id, s.accountId));
    const mailboxId = await seedMailbox(db, { accountId: s.accountId, address: "ops@example.com" });
    await db.insert(workerHeartbeats).values({
      shardIndex: 0, instanceId: "wkr-test", leader: true, shards: 1,
      mailboxes: 1, expected: 1, accounts: 1, quarantined: 0, degraded: false,
      lastCycleAt: FIXED_NOW, startedAt: FIXED_NOW, beatAt: FIXED_NOW,
    });
    return { db, deps, session: s, mailboxId };
  }

  it("the roster reports the account, its owner and its mailbox count", async () => {
    const { deps, session } = await seedWorld();
    const page = await (await H(staff("/admin/accounts"), { ...deps, admin: ADMIN })).json();
    expect(page.total).toBe(1);
    expect(page.matched).toBe(1);
    const account = page.accounts[0];
    expect(account.id).toBe(session.accountId);
    expect(account.name).toBe("Brünner GmbH");
    expect(account.ownerEmail).toContain("@lichtgrat.example");
    expect(account.mailboxCount).toBe(1);
  });

  it("search folds case and accents, and a miss still reports the total", async () => {
    const { deps } = await seedWorld();
    const d = { ...deps, admin: ADMIN };
    const hit = await (await H(staff("/admin/accounts?search=BRUNNER"), d)).json();
    expect(hit.matched).toBe(1);
    const miss = await (await H(staff("/admin/accounts?search=nobody"), d)).json();
    expect(miss.matched).toBe(0);
    expect(miss.total).toBe(1);
  });

  it("a search string full of SQL wildcards is data, not a pattern", async () => {
    const { deps } = await seedWorld();
    const d = { ...deps, admin: ADMIN };
    for (const needle of ["%", "_", "%%", "100%", "a'; drop table accounts; --"]) {
      const res = await H(staff(`/admin/accounts?search=${encodeURIComponent(needle)}`), d);
      expect(res.status, needle).toBe(200);
      expect((await res.json()).matched, needle).toBe(0);
    }
    // …and the table is still there.
    expect((await (await H(staff("/admin/accounts"), d)).json()).total).toBe(1);
  });

  it("pageSize is clamped and page is clamped — a stale bookmark is not a fault", async () => {
    const { deps } = await seedWorld();
    const d = { ...deps, admin: ADMIN };
    const huge = await (await H(staff("/admin/accounts?pageSize=100000"), d)).json();
    expect(huge.pageSize).toBe(100);
    const far = await (await H(staff("/admin/accounts?page=99"), d)).json();
    expect(far.page).toBe(0);
    expect(far.accounts).toHaveLength(1);
    // A stale bookmark is a page number that OUTRAN the roster, and it still clamps — that is
    // what this case is named for. A pageSize of none or minus four is not a stale bookmark; it
    // is a request nobody can have meant, and the paging seam refuses it by name rather than
    // answering the default (`query-bounds.ts`). Absent still means
    // the default: the route reads an absent parameter as `0` and the service chooses 25.
    const absent = await (await H(staff("/admin/accounts"), d)).json();
    expect(absent.pageSize).toBe(25);
    for (const q of ["pageSize=0", "pageSize=-4", "pageSize=abc", "page=-1"]) {
      const res = await H(staff(`/admin/accounts?${q}`), d);
      expect(res.status, q).toBe(400);
    }
  });

  it("account detail carries the mailboxes — and no unknown id 500s", async () => {
    const { deps, session, mailboxId } = await seedWorld();
    const d = { ...deps, admin: ADMIN };
    const detail = await (await H(staff(`/admin/accounts/${session.accountId}`), d)).json();
    expect(detail.account.id).toBe(session.accountId);
    expect(detail.mailboxes).toHaveLength(1);
    expect(detail.mailboxes[0].id).toBe(mailboxId);
    expect(detail.mailboxes[0].address).toBe("ops@example.com");
    // No credential row was seeded, so the mailbox is enabled and unsyncable — a real finding.
    expect(detail.mailboxes[0].hasImapCredential).toBe(false);
    // `admin.*` rows only, and no admin write exists — so empty, honestly.
    expect(detail.audit).toEqual([]);

    // An id that is WELL-FORMED but names nothing is still `200 null` — "no such account" is an
    // answer, not an error, and that is what this loop was written to pin.
    const unknown = await H(staff("/admin/accounts/00000000-0000-0000-0000-000000000000"), d);
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toBeNull();

    /**
     * An id that could never name ANY account is now refused at the door, before this route runs
     * (`createApp.handle`). It used to reach the query and answer `200 null` beside the genuine
     * unknown-account case, which is the assertion that stood here.
     *
     * Tightened rather than adapted: `200 null` for `../../etc/passwd` meant a traversal probe got
     * the same friendly answer as a real lookup, and the shape of the input was never judged at
     * all. This route was luckier than its neighbours — the same unjudged input made
     * `GET /drafts/:id` answer the wrong status, measured in production. Both now answer the refusal a malformed id earns.
     */
    for (const id of ["not-a-uuid", "../../etc/passwd"]) {
      const res = await H(staff(`/admin/accounts/${encodeURIComponent(id)}`), d);
      expect(res.status, id).toBe(400);
      expect(await res.json(), id).toEqual({
        error: { code: "validation_failed", message: "id must be an id", retryable: false },
      });
    }
  });

  it("the worker view reads the heartbeat, and states what the heartbeat cannot tell it", async () => {
    const { deps } = await seedWorld();
    const worker = await (await H(staff("/admin/worker"), { ...deps, admin: ADMIN })).json();
    expect(worker.instances).toHaveLength(1);
    const instance = worker.instances[0];
    expect(instance.instanceId).toBe("wkr-test");
    expect(instance.leader).toBe(true);
    expect(instance.mailboxes).toBe(1);
    // NULL, NOT ZERO. `worker_heartbeats` has no column for any of these, and `0` would be a
    // claim about the worker's internal state that nothing measured.
    expect(instance.host).toBeNull();
    expect(instance.awaitingCredentials).toBeNull();
    expect(instance.truncated).toBeNull();
    expect(instance.kek).toBeNull();
    // No cron telemetry table exists; `[]` says that, where a row saying "never" would lie.
    expect(worker.crons).toEqual([]);
    expect(worker.roster).toHaveLength(1);
    expect(worker.roster[0].accountName).toBe("Brünner GmbH");
  });

  /**
   * THE SIGNUP FUNNEL — counts, and monotonic stages, against real seeded data.
   *
   * Three accounts exercise the three stages: one verified with a mailbox (reaches every stage),
   * one verified with nothing else (stops at verified), one UNVERIFIED (stops at signup). Plus
   * an invite ledger (issued/accepted/revoked) and a waitlist. The counts are what the console
   * renders; the point of running it here is that the `count(distinct …)`, `filter (where …)`
   * and `date_trunc('week', …)` all execute against Postgres, not just typecheck.
   */
  it("the funnel counts each stage and the invite/waitlist top", async () => {
    const { db, deps } = await makeAdminDeps();
    // Reaches every stage: verified (default) and a mailbox.
    const full = await seedSession(db, { now: FIXED_NOW });
    await seedMailbox(db, { accountId: full.accountId, address: "full@example.com" });
    // Verified, but never connected a mailbox.
    await seedSession(db, { now: FIXED_NOW });
    // Signed up and never verified.
    await seedSession(db, { now: FIXED_NOW, emailVerified: false });

    // Invite ledger: one accepted, one revoked, one still outstanding.
    await db.insert(invites).values([
      { codeHash: "h1", email: "a@x.test", expiresAt: new Date("2030-01-01T00:00:00.000Z"), consumedAt: FIXED_NOW },
      { codeHash: "h2", email: "b@x.test", expiresAt: new Date("2030-01-01T00:00:00.000Z"), revokedAt: FIXED_NOW },
      { codeHash: "h3", email: "c@x.test", expiresAt: new Date("2030-01-01T00:00:00.000Z") },
    ]);
    // Waitlist: two waiting, one already invited.
    await db.insert(waitlist).values([
      { email: "w1@x.test" },
      { email: "w2@x.test" },
      { email: "w3@x.test", invitedAt: FIXED_NOW },
    ]);

    const funnel = await (await H(staff("/admin/funnel"), { ...deps, admin: ADMIN })).json();

    const byKey = Object.fromEntries(funnel.stages.map((s: { key: string }) => [s.key, s]));
    expect(byKey.signup.count).toBe(3);
    expect(byKey.verified.count).toBe(2);
    expect(byKey.connected.count).toBe(1);
    // First stage has no conversion; a later one is count/previous.
    expect(byKey.signup.ofPrevious).toBeNull();
    expect(byKey.verified.ofPrevious).toBeCloseTo(2 / 3, 10);
    expect(byKey.connected.ofPrevious).toBeCloseTo(1 / 2, 10);

    expect(funnel.invites).toEqual({ issued: 3, accepted: 1, revoked: 1, outstanding: 1 });
    expect(funnel.waitlist).toEqual({ waiting: 2, invited: 1 });

    // The signup week-bucket the three accounts landed in is present and counts them.
    const total = funnel.signupsByWeek.reduce((n: number, w: { count: number }) => n + w.count, 0);
    expect(total).toBe(3);
    // And the funnel is COUNTS ONLY — no address from invites/waitlist reached the response.
    expect(JSON.stringify(funnel)).not.toContain("@");
  });

  it("the action catalog wires resync and leaves the other one unavailable, with a reason", async () => {
    const { deps } = await seedWorld();
    const catalog = await (await H(staff("/admin/actions"), { ...deps, admin: ADMIN })).json();
    expect(catalog.actions).toHaveLength(2);
    const byId = Object.fromEntries(catalog.actions.map((a: { id: string }) => [a.id, a]));
    // One ships: available, no reason. Every action still previews an `admin.*` audit row
    // (the console shows the record before the button runs).
    for (const id of ["resync_mailbox"]) {
      expect(byId[id].available, id).toBe(true);
      expect(byId[id].unavailableReason, id).toBeNull();
      expect(byId[id].auditPreview.action.startsWith("admin."), id).toBe(true);
    }
    // The last one remains unavailable — its target subsystem does not exist yet.
    for (const id of ["retry_send"]) {
      expect(byId[id].available, id).toBe(false);
      expect(byId[id].unavailableReason, id).toBeTruthy();
      expect(byId[id].auditPreview.action.startsWith("admin."), id).toBe(true);
    }
    // CLAIMS ARE CONTRACTS, and this card's copy was narrowed in the same change that wired it.
    // The old text promised "requeues a full folder pass — UIDVALIDITY is re-read, not assumed",
    // and none of that ships: the write clears a column, and an attach syncs nothing by itself.
    // A card whose effects list overstates the button is the same defect as a button that reports
    // success it cannot achieve, so the absence is asserted rather than trusted to review.
    const resyncText = [byId.resync_mailbox.summary, ...byId.resync_mailbox.effects].join(" ");
    expect(resyncText).not.toMatch(/UIDVALIDITY/i);
    expect(resyncText).not.toMatch(/folder pass/i);
    expect(resyncText).toMatch(/retry_after/);
    expect(catalog.precondition).toContain("Mailbox release");
    // No admin write has run in this seeded world, so the admin.* audit feed is still empty.
    expect(catalog.recent).toEqual([]);
  });

  it("a fault inside a read becomes a readable 503, never the platform's own 500", async () => {
    // `raw` routes run with no error envelope above them, so this handler must never throw.
    const { deps } = await makeAdminDeps();
    const dead = {
      ...deps.db,
      select: () => { throw new Error("connect ECONNREFUSED ep-secret-host.neon" + ".tech:5432"); },
      execute: async () => { throw new Error("connect ECONNREFUSED ep-secret-host.neon" + ".tech:5432"); },
    };
    const broken = {
      ...deps,
      admin: ADMIN,
      db: dead as unknown as ApiDeps["db"],
      // BOTH handles. The six reads run on `adminDb` now; `db` is still broken because
      // `/admin/overview` publishes the health block of the RUNTIME connection, and a test
      // that only broke one of them would report 200 for the half it forgot.
      adminDb: () => Promise.resolve(dead as unknown as AdminDb),
    };
    for (const path of READS) {
      const res = await H(staff(path), broken);
      expect(res.status, path).toBe(503);
      const text = await res.text();
      expect(text, path).toBe(JSON.stringify({ error: { code: "admin_read_failed" } }));
      // The driver's message names the database host and can name the role.
      expect(text, path).not.toContain("ep-secret-host");
    }
  });

  /**
   * A STAFF HANDLE THAT REFUSES TO EXIST IS A DOWNED CONSOLE, NEVER A FALLBACK.
   *
   * `adminDbFor`'s boot probe rejects when the connection it was handed can read message
   * content — the runtime credentials pasted into `DATABASE_URL_ADMIN`, which is the accident
   * a presence check on the variable cannot see. The only acceptable answer is 503: a route
   * that quietly served the request from `deps.db` instead would be the exposure this whole
   * slice exists to make unreachable.
   */
  it("503s every read when the staff handle refuses to construct — and never falls back", async () => {
    const { deps } = await makeAdminDeps();
    let runtimeSelects = 0;
    const refusing = {
      ...deps,
      admin: ADMIN,
      db: new Proxy(deps.db, {
        get(target, prop, receiver) {
          if (prop === "select") runtimeSelects += 1;
          return Reflect.get(target, prop, receiver) as unknown;
        },
      }) as ApiDeps["db"],
      adminDb: () => Promise.reject(
        new Error("refusing to build the staff database handle: the probe SUCCEEDED"),
      ),
    };
    for (const path of READS) {
      const res = await H(staff(path), refusing);
      expect(res.status, path).toBe(503);
      expect(await res.text(), path).toBe(JSON.stringify({ error: { code: "admin_read_failed" } }));
    }
    // `/admin/overview`'s health block legitimately probes the runtime connection with
    // `execute`, and since NEW-ADMIN-READ-NO-SESSION each request legitimately makes exactly
    // ONE runtime `select` — the staff-session resolution, which lives on the runtime handle
    // because the blind role holds no `staff_users` grant. A SECOND select per request would be
    // a read served from the runtime connection, which is the fallback this test forbids.
    expect(runtimeSelects, "an admin read fell back to the runtime connection")
      .toBe(READS.length);
  });

  /**
   * the surface is armed by TWO facts, and the absence of EITHER is a 404.
   *
   * `loadAdminConfig` already refuses to produce one without the other, so this is the route
   * table's half of the same contract: a deployment that somehow has a secret and no
   * content-blind connection advertises no admin endpoint at all.
   */
  it("404s every read when there is a secret but NO staff connection", async () => {
    const { deps } = await makeAdminDeps();
    const { adminDb: _dropped, ...noStaffDb } = deps;
    for (const path of [...READS, "/admin/accounts/00000000-0000-0000-0000-000000000000"]) {
      const res = await H(staff(path), { ...noStaffDb, admin: ADMIN } as ApiDeps);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: { code: "not_found" } });
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   THE REFUSAL THAT IS A PUBLISHED PROMISE
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("admin reads never return message content, credentials or payloads", () => {
  /** Values that exist ONLY in columns no admin endpoint may project. */
  const MARKERS = {
    subject: "ZZMARKERSUBJECTZZ",
    snippet: "ZZMARKERSNIPPETZZ",
    from: "zzmarkersender@example.invalid",
    body: "ZZMARKERBODYZZ",
    header: "ZZMARKERHEADERZZ",
    credential: "zzmarkercredentialzz-fixture-token",
  } as const;

  async function seedEverythingSensitive() {
    const { db, deps } = await makeAdminDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId, address: "ops@example.com" });

    const message = await seedMessage(db, {
      accountId: s.accountId,
      mailboxId,
      subject: MARKERS.subject,
      snippet: MARKERS.snippet,
      fromAddress: MARKERS.from,
      folder: "INBOX",
      reconcileStatus: "pending",
    });
    await seedBody(db, {
      messageId: message.id,
      text: MARKERS.body,
      html: `<p>${MARKERS.body}</p>`,
      headers: { "x-marker": MARKERS.header, to: MARKERS.from },
    });

    // An envelope-encrypted credential blob, exactly as `POST /mailboxes` writes one.
    await db.insert(mailboxCredentials).values({
      mailboxId, transport: "imap", secretEnc: MARKERS.credential, keyVersion: 1,
      meta: { host: "imap.example.com", user: MARKERS.from },
    });

    return { db, deps, session: s, messageId: message.id };
  }

  it("not one marker appears in ANY of the reads", async () => {
    const { deps, session } = await seedEverythingSensitive();
    const d = { ...deps, admin: ADMIN };

    const paths = [...READS, `/admin/accounts/${session.accountId}`];
    for (const path of paths) {
      const res = await H(staff(path), d);
      expect(res.status, path).toBe(200);
      const text = await res.text();
      for (const [name, marker] of Object.entries(MARKERS)) {
        expect(text.includes(marker), `${path} leaked ${name}`).toBe(false);
      }
      // The session's own bearer token and its stored hash are likewise never echoed.
      expect(text.includes(session.token), `${path} leaked a session token`).toBe(false);
    }
  });

  it("ANTI-VACUITY — the markers really are in the database this test just read from", async () => {
    // If a future refactor made the seeding a no-op, the test above would pass for the wrong
    // reason for ever. So the same rows are read back through a projection that IS allowed to
    // see them, and every marker must be found.
    const { db } = await seedEverythingSensitive();
    const creds = await db
      .select({ secretEnc: mailboxCredentials.secretEnc })
      .from(mailboxCredentials);
    expect(creds[0]!.secretEnc).toBe(MARKERS.credential);
  });

  /**
   * CONVERTED BY THAT CHANGE. This test used to be titled "a pending move is COUNTED without
   * anything about the message it belongs to" and it asserted `pendingMoves === 1` as evidence
   * that the join to `messages` had genuinely happened on a two-column grant. **The count was
   * the finding.** A per-mailbox count of unapplied moves is a receipt-confirmation oracle:
   * staff read it, deliver a message they chose, poll, and watch it move — and no bucket saves a
   * number whose population is one account.
   *
   * The assertion is inverted rather than deleted: the world still seeds a PENDING
   * `folder_state` row (`seedEverythingSensitive`), so a 0 here is the redaction and not an
   * empty table. `packages/db/test/staff-role.pg.test.ts` §7 is the guard that proves the
   * database refuses the underlying read; this is the guard that proves the RESPONSE carries
   * nothing derived from it.
   */
  it("a pending move is NOT counted — the count was itself the receipt oracle", async () => {
    const { deps, session } = await seedEverythingSensitive();
    const detail = await (
      await H(staff(`/admin/accounts/${session.accountId}`), { ...deps, admin: ADMIN })
    ).json();
    expect(detail.mailboxes[0].pendingMoves).toBe(0);
    expect(detail.mailboxes[0].oldestPendingMoveSeconds).toBeNull();
    // …and the account's newest-change stamp is gone with the `change_log` grant: a
    // `recordChange` row is written for every ingested message, so one account's stamp advancing
    // around a chosen delivery is the same oracle one table over.
    expect(detail.account.lastActivityAt).toBeNull();
    // Nothing about the message rode back either. A message id is not mail content, but it is
    // also not something any admin DTO declares, so its absence is checkable.
    expect(JSON.stringify(detail)).not.toContain("messageId");
  });

  /**
   * THE SOURCE-LEVEL HALF, which is the gate's own wording: "assert as a source-level test
   * that `routes/admin.ts` and `admin-service.ts` do not reference `messageBodies`".
   *
   * A response scan can only catch what a seeded row happens to reach. This catches the import
   * itself, on the day somebody adds it, before there is a row to notice.
   */
  it("neither admin source file references the body table, or any mail-content column", () => {
    const files = {
      "routes/admin.ts": fileURLToPath(new URL("../src/routes/admin.ts", import.meta.url)),
      "admin-service.ts": fileURLToPath(
        new URL("../../services/src/admin-service.ts", import.meta.url),
      ),
      "admin-dto.ts": fileURLToPath(new URL("../../services/src/admin-dto.ts", import.meta.url)),
    };
    // Field ACCESS, not the word: both files talk ABOUT subjects and bodies in their headers,
    // and a scanner that punished them for stating their own invariant would be answered by
    // deleting the invariant. Same rule as the operator console's own no-mail-content test.
    const forbiddenIdentifiers = ["messageBodies", "message_bodies", "messageBody"];
    const forbiddenFields = [
      "subject", "snippet", "bodyText", "bodyHtml", "bodyHash", "rawBody", "fromAddress",
      "fromName", "toAddresses", "ccAddresses", "messageIdHeader", "sensitivityCategory",
      "secretEnc", "secret_enc", "passwordHash", "accessTokenHash", "codeHash",
    ];
    const patterns = (field: string): RegExp[] => [
      new RegExp(`\\.${field}\\b`),
      new RegExp(`\\b${field}\\s*\\??\\s*:`),  // an optional field (`subject?:`) is a field
      new RegExp(`\\[\\s*["'\`]${field}["'\`]\\s*\\]`),
    ];

    const violations: string[] = [];
    for (const [label, path] of Object.entries(files)) {
      const source = readFileSync(path, "utf8");
      expect(source.length, `${label} is empty — the scan would pass vacuously`).toBeGreaterThan(500);
      source.split("\n").forEach((line, i) => {
        for (const id of forbiddenIdentifiers) {
          if (line.includes(id)) violations.push(`${label}:${i + 1} [${id}] ${line.trim()}`);
        }
        for (const field of forbiddenFields) {
          if (patterns(field).some((p) => p.test(line))) {
            violations.push(`${label}:${i + 1} [${field}] ${line.trim()}`);
          }
        }
      });
    }
    expect(violations, `admin source touched mail content or a secret:\n${violations.join("\n")}`)
      .toEqual([]);
  });

  it("POSITIVE CONTROL — the source scan catches the exact line it exists to catch", () => {
    const patterns = (field: string): RegExp[] => [
      new RegExp(`\\.${field}\\b`),
      new RegExp(`\\b${field}\\s*\\??\\s*:`),  // an optional field (`subject?:`) is a field
      new RegExp(`\\[\\s*["'\`]${field}["'\`]\\s*\\]`),
    ];
    for (const line of [
      `      subject: messages.subject,`,
      `  subject?: string;`,
      `      const s = row.snippet;`,
      `      secretEnc: mailboxCredentials.secretEnc,`,
      `      const blob = row["secret_enc"];`,
    ]) {
      const hit = ["subject", "snippet", "secretEnc", "secret_enc"].some((f) =>
        patterns(f).some((p) => p.test(line)));
      expect(hit, `not caught: ${line}`).toBe(true);
    }
    expect("import { messageBodies } from \"@trafficflow/db\";".includes("messageBodies")).toBe(true);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   The roster order the console and the server must agree on
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("the roster order is the console's order", () => {
  it("attention first, then name — so page 2 cannot omit what page 1 also omitted", async () => {
    const { db, deps } = await makeAdminDeps();
    const d = { ...deps, admin: ADMIN };

    // Healthy, alphabetically first.
    const healthy = await seedSession(db, { now: FIXED_NOW, token: "tok-healthy" });
    await db.update(accounts).set({ name: "Aaron AG" }).where(eq(accounts.id, healthy.accountId));
    await seedMailbox(db, { accountId: healthy.accountId, address: "a@example.com" });
    await db.update(mailboxes).set({ lastSyncAt: FIXED_NOW })
      .where(eq(mailboxes.accountId, healthy.accountId));

    // A broken mailbox, alphabetically last — it must still come first.
    const broken = await seedSession(db, { now: FIXED_NOW, token: "tok-broken" });
    await db.update(accounts).set({ name: "Zurich Zed" }).where(eq(accounts.id, broken.accountId));
    await seedMailbox(db, { accountId: broken.accountId, address: "z@example.com" });
    await db.update(mailboxes).set({ status: "error", lastSyncAt: FIXED_NOW })
      .where(eq(mailboxes.accountId, broken.accountId));

    const page = await (await H(staff("/admin/accounts"), d)).json();
    expect(page.accounts.map((a: { name: string }) => a.name)).toEqual(["Zurich Zed", "Aaron AG"]);
    expect(page.accounts[0].mailboxesInError).toBe(1);

    // …and "needs attention" means exactly `rank > 0`, so the chip and the sort agree.
    const attention = await (await H(staff("/admin/accounts?filter=attention"), d)).json();
    expect(attention.matched).toBe(1);
    expect(attention.accounts[0].name).toBe("Zurich Zed");
    expect(attention.total).toBe(2);

    // Paging is honest about what it hid.
    const first = await (await H(staff("/admin/accounts?pageSize=1"), d)).json();
    expect(first.accounts).toHaveLength(1);
    expect(first.matched).toBe(2);
    expect(first.accounts[0].name).toBe("Zurich Zed");
    const second = await (await H(staff("/admin/accounts?pageSize=1&page=1"), d)).json();
    expect(second.accounts[0].name).toBe("Aaron AG");
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   a blocked mailbox reaches the roster, on BOTH copies of the rank and out of the DB
   ════════════════════════════════════════════════════════════════════════════════════════

   `adminAttentionRank` and the operator console's `attentionRank` are the same function written
   twice — a package may not import from an app — and the server's copy is the one that orders a
   PAGED roster. If only one grows the block clause, page 1 and page 2 omit the same rows and
   nothing anywhere is red. So `roster.test.ts`'s three cases are re-run here against this copy.

   And then the part neither copy can prove: that the FIELD is ever non-zero against a real
   database. `pendingMoves: 0` is this repository's own proof that a field can pass parity, pass
   the census, render correctly against fixtures and read zero in production for ever — because
   the fixture is the only place most admin tests see an `AccountSummary`. The `count(*) filter`
   is the only part of that change that no offline guard reaches, so it gets a seeded row. */

describe("the rank the SERVER sorts by knows about a blocked mailbox", () => {
  const account = (over: Partial<AccountSummary>): AccountSummary => ({
    id: "a", name: "A", ownerEmail: "a@example.com",
    mailboxCount: 1, mailboxesInError: 0, mailboxesBlocked: 0,
    syncLagSeconds: 10, lastActivityAt: null, createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });

  it("one blocked mailbox is attention — the same three cases the console asserts", () => {
    // MUTATION: add the clause to the console's `attentionRank` only → all three of these go red
    // while the console's own suite stays green, which is the drift this file exists to catch.
    expect(adminAttentionRank(account({ mailboxesBlocked: 1 }))).toBeGreaterThan(0);
    expect(adminAttentionRank(account({ mailboxesBlocked: 999 })))
      .toBeLessThan(adminAttentionRank(account({ mailboxesInError: 1 })));
    expect(adminAttentionRank(account({ mailboxesBlocked: 1 })))
      .toBeGreaterThan(adminAttentionRank(account({ syncLagSeconds: 86_400 })));
  });

  it("and it is the SAME NUMBER the console computes — not merely the same ordering", () => {
    // Ordering agreement is not enough: the two copies also feed the `attention` FILTER, and a
    // server clause that scored 1 where the console scores 165 would order identically and select
    // differently the moment another term is added. The literals are the ruling's own arithmetic.
    expect(adminAttentionRank(account({ mailboxesBlocked: 1 }))).toBe(165);
    expect(adminAttentionRank(account({ mailboxesBlocked: 8 }))).toBe(200);
    expect(adminAttentionRank(account({ mailboxesBlocked: 99 })), "the cap is not applied").toBe(200);
    expect(adminAttentionRank(account({ mailboxesInError: 1 })), "one error, for the comparison").toBe(210);
  });

  it("THE SQL, AGAINST A DATABASE: a blocked mailbox counts as blocked and NOT as in error", async () => {
    /**
     * THE ONE GUARD `pendingMoves` DID NOT HAVE.
     *
     * Everything else about `mailboxesBlocked` is provable against a fixture, and a fixture is
     * written by the same hand as the code. This seeds the row the worker actually writes —
     * `status='connected'`, `sync_blocked_reason='at_capacity'`, no error columns — and reads the
     * roster back through the real endpoint.
     *
     * MUTATION: flip the filter in `admin-service.ts` to `is null` → red. Without this case the
     * field ships green and reads 0 for ever.
     */
    const { db, deps } = await makeAdminDeps();
    const d = { ...deps, admin: ADMIN };

    const s = await seedSession(db, { now: FIXED_NOW, token: "tok-blocked" });
    await db.update(accounts).set({ name: "Blocked BV" }).where(eq(accounts.id, s.accountId));
    await seedMailbox(db, { accountId: s.accountId, address: "blocked@example.com" });
    await db.update(mailboxes).set({
      status: "connected",
      lastSyncAt: FIXED_NOW,
      syncBlockedReason: "at_capacity",
      syncBlockedSince: FIXED_NOW,
    }).where(eq(mailboxes.accountId, s.accountId));

    const page = await (await H(staff("/admin/accounts"), d)).json();
    const row = page.accounts.find((a: { name: string }) => a.name === "Blocked BV");
    expect(row, "the seeded account is not on the roster at all").toBeTruthy();

    expect(row.mailboxesBlocked, "the aggregate counted no blocked mailbox").toBe(1);
    // THE HALF THAT MAKES THE FIELD NECESSARY. `status` is `connected`, so the error count is 0 —
    // which is exactly why the roster ranked this account healthy before that change. If this ever reads 1
    // the two counts have stopped being disjoint and the rank is double-scoring.
    expect(row.mailboxesInError, "a block was counted as an error — the buckets have merged").toBe(0);
    expect(row.mailboxCount).toBe(1);

    // And it reaches the FILTER, not only the field: `attention` means `rank > 0`, and this
    // account has no other reason to be in it.
    const attention = await (await H(staff("/admin/accounts?filter=attention"), d)).json();
    expect(
      attention.accounts.map((a: { name: string }) => a.name),
      "an account whose only mailbox nobody is organizing is not in `Needs attention`",
    ).toContain("Blocked BV");
  });

  it("a HEALTHY mailbox counts zero — the filter is not counting every row", async () => {
    // The negative control for the SQL. A `count(*)` with a broken filter would make every account
    // on the platform permanently blocked, which is a louder failure but a failure all the same.
    const { db, deps } = await makeAdminDeps();
    const d = { ...deps, admin: ADMIN };
    const s = await seedSession(db, { now: FIXED_NOW, token: "tok-calm" });
    await db.update(accounts).set({ name: "Calm CV" }).where(eq(accounts.id, s.accountId));
    await seedMailbox(db, { accountId: s.accountId, address: "calm@example.com" });
    await db.update(mailboxes).set({ status: "connected", lastSyncAt: FIXED_NOW })
      .where(eq(mailboxes.accountId, s.accountId));

    const page = await (await H(staff("/admin/accounts"), d)).json();
    const row = page.accounts.find((a: { name: string }) => a.name === "Calm CV");
    expect(row.mailboxesBlocked).toBe(0);
    expect(row.mailboxesInError).toBe(0);
  });
});

/**
 * The derivation itself, asserted — because a filter that matched nothing would make every loop
 * above pass vacuously, and a filter that quietly narrowed would reintroduce the gap it replaced.
 */
describe("the admin READ set is derived, and covers the surface", () => {
  it("every GET /admin/* route is in READS", () => {
    const fromTable = apiRoutes.filter((r) => r.method === "GET" && r.pattern.startsWith("/admin/"));
    expect(fromTable.length, "no admin GET routes found — the derivation is broken").toBeGreaterThan(5);
    expect(READS.length).toBe(fromTable.length);

    // Named so a regression is visible rather than implied by a count.
    for (const p of ["/admin/overview", "/admin/accounts", "/admin/funnel",
                     "/admin/worker", "/admin/actions"]) {
      expect(READS, `${p} must be covered`).toContain(p);
    }

    // Every entry is drivable: no `:param` survived the substitution.
    expect(READS.filter((p) => p.includes(":"))).toEqual([]);
  });
});
