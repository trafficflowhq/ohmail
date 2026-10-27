import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiFaults, evaluateAlerts, makeOwnedDb, pruneApiFaults, recordApiFault,
  DEFAULT_ALERT_THRESHOLDS, POOLER_REFUSAL_ERROR_CLASS, POOLER_REFUSAL_ERROR_CLASSES, API_FAULT_RETENTION_MS,
  DbAcquireTimeoutError, DbConnectionCapError, type OwnedDb,
} from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import { makeTestAuthDeps, type Db } from "@trafficflow/services";
import { ServiceError } from "@trafficflow/services";
import { and, eq, sql } from "drizzle-orm";

/**
 * CLOUD 0032 END TO END, ON REAL POSTGRES — the wiring, not the code.
 *
 * Every failure mode of a fault recorder renders as its own healthy state: an empty table beside a
 * board reading "no faults" is what a working deployment looks like, and equally what a missing
 * port, a host ahead of the migration, or a rule that cannot fire looks like. So the assertions
 * here are on EFFECTS reached through the real route table and the real middleware chain.
 *
 * It is a `.pg.test.ts` for the reason `alerts.pg.test.ts` is one: the window reads bind an
 * instant inside a raw `sql` fragment, and PGlite accepts a bare `Date` where postgres-js refuses
 * it. A green PGlite run would say nothing about whether either rule can execute at all.
 *
 * The database is this worktree's own — `PG_TEST_URL` resolves through `.lane-db.env`, so nothing
 * here writes to the shared box.
 */

const PG_UP = await realPgAvailable();
const NOW = new Date("2026-09-10T12:00:00.000Z");
const SECRET = "probe-secret-at-least-ce-characters-long-fixture-token";
const T = DEFAULT_ALERT_THRESHOLDS;

const app = createApp(apiRoutes);

describe.skipIf(!PG_UP)("api_faults on real Postgres", () => {
  let owned: OwnedDb;
  let db: Db;
  /** Faults recorded through the port, so the route drive and the rules read one seam. */
  let recorded: Array<{ route: string; status: number; errorClass: string }>;

  /**
   * The deps a hosted host builds, reduced to what this file drives. `faultLog` is the port under
   * test and it is wired the way `apps/api-vercel/src/deps.ts` wires it — over a real handle,
   * `arm: "api"`, swallowing nothing here so a broken write is a red test rather than a silence.
   */
  function depsOn(withPort: boolean, withSecret: boolean): ApiDeps {
    const authDeps = makeTestAuthDeps({});
    return {
      db,
      now: () => NOW,
      requestId: `probe-${randomUUID()}`,
      session: null,
      authConfig: authDeps.config,
      keyProvider: authDeps.keyProvider,
      services: {} as ApiDeps["services"],
      ...(withSecret
        ? { alerts: { secret: SECRET, sinks: [], environment: "test" } as ApiDeps["alerts"] }
        : {}),
      ...(withPort
        ? {
          faultLog: {
            record: async (f) => {
              recorded.push({ route: f.route, status: f.status, errorClass: f.errorClass });
              await recordApiFault(db as never, { ...f, arm: "api" });
            },
          },
        }
        : {}),
    } as ApiDeps;
  }

  const post = (deps: ApiDeps, headers: Record<string, string> = {}): Promise<Response> =>
    app.handle(
      new Request("http://localhost/internal/fault", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
      }),
      { ...deps, session: null, idempotency: null },
    );

  /** Every fault row this file's own window can see. Scoped by route prefix, never global. */
  const rows = async (): Promise<Array<{ route: string; status: number; errorClass: string }>> => {
    const out = await db.select({
      route: apiFaults.route, status: apiFaults.status, errorClass: apiFaults.errorClass,
    }).from(apiFaults).where(eq(apiFaults.arm, "api"));
    return out as Array<{ route: string; status: number; errorClass: string }>;
  };

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
    db = owned.db as unknown as Db;
    recorded = [];
    // This file's own residue only. Its writes are all `arm = 'api'` with a `probe`/`/internal`
    // route, and it never stamps the future, so a previous run leaves nothing another file reads.
    await db.delete(apiFaults);
  }, 180_000);

  afterAll(async () => {
    await db.delete(apiFaults).catch(() => {});
    await owned?.close();
  });

  // ── THE ROUTE, THROUGH THE REAL PIPELINE ─────────────────────────────────────────────────

  it("the probe route throws BENEATH the envelope and one row lands", async () => {
    recorded = [];
    const res = await post(depsOn(true, true), { authorization: `Bearer ${SECRET}` });

    // 500 from `withErrorEnvelope`'s unhandled arm — NOT the host's generic 500, which is what
    // a `raw` or `anonymous` route would have produced with nothing recorded.
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "internal" } });

    // The EFFECT: the port was reached, and the row carries the class and not the message.
    expect(recorded).toEqual([
      { route: "/internal/fault", status: 500, errorClass: "FaultProbeError" },
    ]);
    const landed = await rows();
    expect(landed).toHaveLength(1);
    expect(landed[0]).toMatchObject({
      route: "/internal/fault", status: 500, errorClass: "FaultProbeError",
    });
  });

  it("carries the request id and no message anywhere in the row", async () => {
    await db.delete(apiFaults);
    await post(depsOn(true, true), { authorization: `Bearer ${SECRET}` });
    const [row] = await db.select().from(apiFaults);
    expect(row?.requestId).toMatch(/^probe-/);
    // The probe's message is "deliberate fault from POST /internal/fault". No column holds it.
    const asText = JSON.stringify(row);
    expect(asText).not.toContain("deliberate fault");
  });

  // ── THE CONTROLS: WHO MAY REACH IT ───────────────────────────────────────────────────────

  it("is NOT reachable anonymously — no credential is 401 and nothing is recorded", async () => {
    await db.delete(apiFaults);
    recorded = [];
    const res = await post(depsOn(true, true));
    expect(res.status).toBe(401);
    expect(recorded).toEqual([]);
    expect(await rows()).toHaveLength(0);
  });

  it("a WRONG credential is 401 and nothing is recorded", async () => {
    await db.delete(apiFaults);
    recorded = [];
    const res = await post(depsOn(true, true), { authorization: "Bearer not-the-secret-but-long" });
    expect(res.status).toBe(401);
    expect(await rows()).toHaveLength(0);
  });

  it("a host with NO fault log answers 404 even to the right credential", async () => {
    await db.delete(apiFaults);
    const res = await post(depsOn(false, true), { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(404);
    expect(await rows()).toHaveLength(0);
  });

  it("a host with no alert secret answers 404 — the second arming condition", async () => {
    await db.delete(apiFaults);
    const res = await post(depsOn(true, false), { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(404);
    expect(await rows()).toHaveLength(0);
  });

  // ── THE ENVELOPE'S OTHER TWO 5xx ARMS ────────────────────────────────────────────────────
  //
  // The probe route reaches `request_unhandled` only. The `db_busy` and `ServiceError` arms are
  // each their own `countFault` call, and a call nothing drives is a line nobody can watch fail —
  // which the next reader takes for a guarantee. Driven through a route table of their own, so
  // the whole middleware chain is still what produces the answer.

  /** A throwaway table whose handlers throw the two remaining shapes. */
  function armApp(): ReturnType<typeof createApp> {
    return createApp([
      {
        method: "GET", pattern: "/arm/busy", cost: "unauthenticated", options: { public: true },
        handler: async () => { throw new DbAcquireTimeoutError(15_000); },
      },
      {
        method: "GET", pattern: "/arm/service", cost: "unauthenticated", options: { public: true },
        handler: async () => { throw new ServiceError("upstream_unavailable", 503, "no"); },
      },
      {
        method: "GET", pattern: "/arm/client", cost: "unauthenticated", options: { public: true },
        handler: async () => { throw new ServiceError("validation_failed", 400, "no"); },
      },
    ] as never);
  }

  const getArm = (path: string): Promise<Response> =>
    armApp().handle(
      new Request(`http://localhost${path}`),
      { ...depsOn(true, true), session: null, idempotency: null },
    );

  it("a POOLED-ACQUIRE refusal is answered 503 and recorded with the real class", async () => {
    await db.delete(apiFaults);
    const res = await getArm("/arm/busy");
    expect(res.status).toBe(503);
    const [row] = await db.select().from(apiFaults);
    expect(row).toMatchObject({
      route: "/arm/busy", status: 503, errorClass: POOLER_REFUSAL_ERROR_CLASS,
    });
  });

  it("a 5xx ServiceError is recorded at ITS OWN status", async () => {
    await db.delete(apiFaults);
    const res = await getArm("/arm/service");
    expect(res.status).toBe(503);
    const [row] = await db.select().from(apiFaults);
    expect(row).toMatchObject({ route: "/arm/service", status: 503, errorClass: "ServiceError" });
  });

  it("a 4xx ServiceError is NOT recorded — the PORT is never even asked", async () => {
    await db.delete(apiFaults);
    recorded = [];
    const res = await getArm("/arm/client");
    expect(res.status).toBe(400);

    // ASSERTED AT THE PORT, and that is the discriminator rather than fussiness. An empty TABLE
    // is satisfied by two different programs: the middleware declining to record a 4xx, and the
    // middleware recording it while cloud 0033's `status` CHECK refuses the insert and the
    // envelope swallows the failure. Widening the gate to `>= 400` left the table empty and this
    // file green until the assertion moved to the call itself.
    expect(recorded).toEqual([]);
    expect(await rows()).toHaveLength(0);
  });

  // ── THE RECORD MAY NOT DELAY THE ANSWER IT DESCRIBES ─────────────────────────────────────

  it("a port that HANGS costs the answer the budget and no more", async () => {
    // The defect this closes: the hosted arm records through the same pool the request uses, and
    // the branch answering `503 db_busy` is the one whose pool just refused an acquire. Recording
    // there inherits `POOLED_ACQUIRE_TIMEOUT_MS` (15 s) exactly when it bites — so the refusal
    // documented "503, FAST" becomes a slow one, and the whole value of the ceiling is that it
    // answers quickly with a cause.
    const hang: ApiDeps["faultLog"] = { record: () => new Promise<void>(() => {}) };
    const deps = { ...depsOn(false, true), faultLog: hang } as ApiDeps;
    const started = Date.now();
    const res = await post(deps, { authorization: `Bearer ${SECRET}` });
    const elapsed = Date.now() - started;

    // The ANSWER still happens, and it is the envelope's, not the host's.
    expect(res.status).toBe(500);
    // Generous headroom over the 1 s budget for a loaded machine, and still two orders of
    // magnitude under the acquire ceiling this exists to escape. Without the race the assertion
    // cannot even be written: the request never returns.
    expect(elapsed).toBeLessThan(6_000);
  });

  it("a port that REJECTS is swallowed, and the answer is unchanged", async () => {
    const refuse: ApiDeps["faultLog"] = {
      record: () => Promise.reject(new Error('relation "api_faults" does not exist')),
    };
    const deps = { ...depsOn(false, true), faultLog: refuse } as ApiDeps;
    const res = await post(deps, { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "internal" } });
  });

  // ── THE RULES: BOTH ARMS ─────────────────────────────────────────────────────────────────

  /** N faults on one route, inside the window. */
  async function seedRoute(route: string, n: number, errorClass = "ServiceError"): Promise<void> {
    for (let i = 0; i < n; i++) {
      await recordApiFault(db as never, {
        route, method: "GET", status: 500, errorClass,
        requestId: randomUUID(), arm: "api",
        at: new Date(NOW.getTime() - (i + 1) * 1000),
      });
    }
  }

  it("api_fault_rate does NOT fire one below the floor", async () => {
    await db.delete(apiFaults);
    await seedRoute("/probe/below", T.apiFaultMinPerRoute - 1);
    const alerts = await evaluateAlerts(db as never, { now: NOW });
    expect(alerts.filter((a) => a.kind === "api_fault_rate")).toEqual([]);
  });

  it("api_fault_rate fires AT the floor, keyed per route and arm", async () => {
    await db.delete(apiFaults);
    await seedRoute("/probe/at", T.apiFaultMinPerRoute);
    const alerts = await evaluateAlerts(db as never, { now: NOW });
    const firing = alerts.filter((a) => a.kind === "api_fault_rate");
    expect(firing).toHaveLength(1);
    expect(firing[0]!.key).toBe("api_fault_rate:api:/probe/at");
    expect(firing[0]!.count).toBe(T.apiFaultMinPerRoute);
    expect(firing[0]!.detail).toContain("/probe/at");
  });

  it("counts PER ROUTE — the same total spread over two routes fires for neither", async () => {
    await db.delete(apiFaults);
    // Twice the floor in total, one short of it on each route: the discriminator between a
    // per-route rule and a deployment-wide one, which the same rows would satisfy.
    await seedRoute("/probe/a", T.apiFaultMinPerRoute - 1);
    await seedRoute("/probe/b", T.apiFaultMinPerRoute - 1);
    const alerts = await evaluateAlerts(db as never, { now: NOW });
    expect(alerts.filter((a) => a.kind === "api_fault_rate")).toEqual([]);
  });

  it("ignores faults OUTSIDE the window", async () => {
    await db.delete(apiFaults);
    for (let i = 0; i < T.apiFaultMinPerRoute; i++) {
      await recordApiFault(db as never, {
        route: "/probe/old", method: "GET", status: 500, errorClass: "ServiceError",
        requestId: randomUUID(), arm: "api",
        at: new Date(NOW.getTime() - T.apiFaultWindowMs - 60_000),
      });
    }
    const alerts = await evaluateAlerts(db as never, { now: NOW });
    expect(alerts.filter((a) => a.kind === "api_fault_rate")).toEqual([]);
  });

  it("pooler_refusals does NOT fire one below the floor", async () => {
    await db.delete(apiFaults);
    await seedRoute("/probe/pool", T.poolerRefusalThreshold - 1, POOLER_REFUSAL_ERROR_CLASS);
    const alerts = await evaluateAlerts(db as never, { now: NOW });
    expect(alerts.filter((a) => a.kind === "pooler_refusals")).toEqual([]);
  });

  it("pooler_refusals fires AT the floor, deployment-wide across routes", async () => {
    await db.delete(apiFaults);
    // SPREAD over two routes on purpose: this rule is not per route, so a fixture that put them
    // all on one would pass for the per-route rule's reason and prove nothing about this one.
    const half = Math.floor(T.poolerRefusalThreshold / 2);
    await seedRoute("/probe/p1", half, POOLER_REFUSAL_ERROR_CLASS);
    await seedRoute("/probe/p2", T.poolerRefusalThreshold - half, POOLER_REFUSAL_ERROR_CLASS);
    const alerts = await evaluateAlerts(db as never, { now: NOW });
    const firing = alerts.filter((a) => a.kind === "pooler_refusals");
    expect(firing).toHaveLength(1);
    expect(firing[0]!.count).toBe(T.poolerRefusalThreshold);
    expect(firing[0]!.detail).toContain("2 route(s)");
  });

  /** `n` pooled-acquire refusals at one instant, `ageMs` before NOW. */
  async function seedRefusalsAt(route: string, n: number, ageMs: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await recordApiFault(db as never, {
        route, method: "GET", status: 503, errorClass: POOLER_REFUSAL_ERROR_CLASS,
        requestId: randomUUID(), arm: "api", at: new Date(NOW.getTime() - ageMs),
      });
    }
  }

  it("pooler_refusals counts its OWN window: a burst just outside is silent, just inside fires", async () => {
    // The rule's window is what makes one refusal "the ceiling working" and a burst an incident;
    // a window read wider than the threshold's would page on refusals long since over.
    await db.delete(apiFaults);
    await seedRefusalsAt("/probe/old-burst", T.poolerRefusalThreshold, T.apiFaultWindowMs + 60_000);
    let alerts = await evaluateAlerts(db as never, { now: NOW });
    expect(alerts.filter((a) => a.kind === "pooler_refusals")).toEqual([]);

    await db.delete(apiFaults);
    await seedRefusalsAt("/probe/new-burst", T.poolerRefusalThreshold, T.apiFaultWindowMs - 60_000);
    alerts = await evaluateAlerts(db as never, { now: NOW });
    expect(alerts.filter((a) => a.kind === "pooler_refusals")).toHaveLength(1);
  });

  it("an ordinary 500 is NOT a pooler refusal — the class is the discriminator", async () => {
    await db.delete(apiFaults);
    await seedRoute("/probe/plain", T.poolerRefusalThreshold, "ServiceError");
    const alerts = await evaluateAlerts(db as never, { now: NOW });
    expect(alerts.filter((a) => a.kind === "pooler_refusals")).toEqual([]);
    // …and the per-route rule DOES see them, which is what makes the line above a discriminator
    // rather than an empty window.
    expect(alerts.filter((a) => a.kind === "api_fault_rate")).toHaveLength(1);
  });

  it("the recorded class still NAMES the real refusal — a rename breaks this, not production", () => {
    expect(POOLER_REFUSAL_ERROR_CLASS).toBe(new DbAcquireTimeoutError(1).name);
    expect(POOLER_REFUSAL_ERROR_CLASSES).toEqual([new DbAcquireTimeoutError(1).name, new DbConnectionCapError("pooler").name]);
  });

  it("pooler_refusals counts a pooler at its client cap: silent one below the floor, fires at it", async () => {
    await db.delete(apiFaults);
    await seedRoute("/probe/cap-a", T.poolerRefusalThreshold - 1, "DbConnectionCapError");
    let alerts = await evaluateAlerts(db as never, { now: NOW });
    expect(alerts.filter((a) => a.kind === "pooler_refusals")).toEqual([]);

    await seedRoute("/probe/cap-b", 1, "DbConnectionCapError");
    alerts = await evaluateAlerts(db as never, { now: NOW });
    const firing = alerts.filter((a) => a.kind === "pooler_refusals");
    expect(firing).toHaveLength(1);
    expect(firing[0]!.count).toBe(T.poolerRefusalThreshold);
    // The sentence names both causes, so the page says what to look at.
    expect(firing[0]!.detail).toMatch(/acquire ceiling/);
    expect(firing[0]!.detail).toMatch(/connection limit/);
  });

  // ── THE PRUNE ────────────────────────────────────────────────────────────────────────────

  it("prunes past the retention horizon and keeps everything inside it", async () => {
    await db.delete(apiFaults);
    await recordApiFault(db as never, {
      route: "/probe/keep", method: "GET", status: 500, errorClass: "ServiceError",
      requestId: null, arm: "api", at: new Date(NOW.getTime() - API_FAULT_RETENTION_MS + 60_000),
    });
    await recordApiFault(db as never, {
      route: "/probe/drop", method: "GET", status: 500, errorClass: "ServiceError",
      requestId: null, arm: "api", at: new Date(NOW.getTime() - API_FAULT_RETENTION_MS - 60_000),
    });

    const removed = await pruneApiFaults(db as never, NOW);
    expect(removed).toBe(1);
    const left = await rows();
    expect(left.map((r) => r.route)).toEqual(["/probe/keep"]);
  });

  it("a prune with nothing due removes nothing", async () => {
    await db.delete(apiFaults);
    await seedRoute("/probe/fresh", 3);
    expect(await pruneApiFaults(db as never, NOW)).toBe(0);
    expect(await rows()).toHaveLength(3);
  });

  // ── THE CHECK THE DATABASE ITSELF ENFORCES ───────────────────────────────────────────────

  it("refuses a 4xx at the database — a caller's own mistake is not a fault", async () => {
    await expect(db.insert(apiFaults).values({
      at: NOW, route: "/probe/4xx", method: "GET", status: 404,
      errorClass: "NotFound", requestId: null, arm: "api",
    })).rejects.toThrow(/api_faults_status_check/);
  });

  it("refuses an unknown arm at the database", async () => {
    await expect(db.insert(apiFaults).values({
      at: NOW, route: "/probe/arm", method: "GET", status: 500,
      errorClass: "X", requestId: null, arm: "admin",
    })).rejects.toThrow(/api_faults_arm_check/);
  });

  it("the recorder CLAMPS an over-long route rather than losing the row to the CHECK", async () => {
    await db.delete(apiFaults);
    await recordApiFault(db as never, {
      route: "/probe/".padEnd(400, "x"), method: "GET", status: 500,
      errorClass: "ServiceError", requestId: null, arm: "api", at: NOW,
    });
    const [row] = await db.select({ route: apiFaults.route }).from(apiFaults);
    expect(row!.route.length).toBe(200);
  });

  it("BOTH ARMS see both kinds — which is why neither is in SCOPED_ALERT_KINDS", async () => {
    // The claim this pins is in `alerts.ts` at rule 11b: both arms read `api_faults` through
    // grants that both hold, so absence from a firing set means the condition CLEARED and the row
    // may be resolved. A kind only ONE arm can evaluate, left out of SCOPED_ALERT_KINDS, flaps —
    // each pass deletes the other's row, which is what `imap_admission_refused` cost.
    //
    // `alerts-reliability.test.ts`'s scoped census is a hard-coded six-name list, so it cannot
    // detect a rule that SHOULD be scoped and is not. This is the control for that gap, and it
    // belongs here because it needs the real table on a real database.
    await db.delete(apiFaults);
    await seedRoute("/probe/arms", T.apiFaultMinPerRoute, POOLER_REFUSAL_ERROR_CLASS);

    const asWorker = await evaluateAlerts(db as never, { now: NOW, driver: "worker", shards: [] });
    const asApi = await evaluateAlerts(db as never, { now: NOW, driver: "api", shards: [] });
    const mine = (list: readonly { kind: string; key: string }[]): string[] =>
      list.filter((a) => a.kind === "api_fault_rate" || a.kind === "pooler_refusals")
        .map((a) => a.key).sort();

    // The SAME two keys from each arm. An arm blind to the table — a withheld grant, a
    // driver-gated rule — reads here as one empty list beside a populated one.
    expect(mine(asWorker)).toEqual(["api_fault_rate:api:/probe/arms", "pooler_refusals"]);
    expect(mine(asApi)).toEqual(mine(asWorker));
    // NOT VACUOUS: two empties would also be "equal".
    expect(mine(asWorker)).toHaveLength(2);
  });

  it("both new kinds are absent from a deployment with no faults at all", async () => {
    await db.delete(apiFaults);
    const alerts = await evaluateAlerts(db as never, { now: NOW });
    expect(alerts.filter((a) => a.kind === "api_fault_rate" || a.kind === "pooler_refusals"))
      .toEqual([]);
    // NOT VACUOUS: the evaluator ran and answered about the whole deployment.
    expect(Array.isArray(alerts)).toBe(true);
  });

  it("the window read executes against postgres-js without a binding error", async () => {
    // `alerts.pg.test.ts`' founding assertion, restated for the two reads this migration adds:
    // both bind an instant inside a raw fragment, which PGlite accepts as a bare Date and
    // postgres-js refuses. A rejection here is the bug.
    await db.delete(apiFaults);
    await expect(evaluateAlerts(db as never, { now: NOW })).resolves.toBeInstanceOf(Array);
    const n = await db.select({ n: sql<number>`count(*)::int` }).from(apiFaults)
      .where(and(eq(apiFaults.arm, "api"), eq(apiFaults.status, 500)));
    expect(Number(n[0]!.n)).toBe(0);
  });
});
