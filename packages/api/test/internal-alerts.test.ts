import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, apiAlertSinkSummary, type ApiDeps } from "@trafficflow/api";
import { alertState, type Alert, type AlertSink } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import type { AdminDb } from "@trafficflow/services";
import { createLogger } from "@trafficflow/core";
import { makeDeps, req } from "./helpers.js";

/**
 * `POST /internal/alerts`, the alert driver that is NOT the worker.
 *
 * Most alert rules can be evaluated by the worker itself. The ones that are statements ABOUT
 * AN ARM cannot be — "no leader lock held for > 2 minutes" first among them, because a dead
 * process reports nothing. So the same pass runs here, on a different host, on a different
 * platform, driven by the API host's own cron (its platform config) or an operator's
 * POST with the secret.
 *
 * What this file pins is the surface: 404 when unconfigured, 401 on a wrong secret, the pass
 * on a good one, and 200 even when alerts are firing (a firing alert is not the observer's
 * failure, and a scheduler that conflated the two would turn every incident into two).
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null });

const SECRET = "s".repeat(32);

function post(secret?: string): Request {
  return new Request("http://api.test/internal/alerts", {
    method: "POST",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

function get(secret?: string): Request {
  return new Request("http://api.test/internal/alerts", {
    method: "GET",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

function spySink(): AlertSink & { seen: Alert[][] } {
  const seen: Alert[][] = [];
  return { name: "spy", seen, async notify(alerts) { seen.push([...alerts]); return true; } };
}

/**
 * A LOST ARM IS THIS DRIVER'S PROBLEM TOO, and it is the sharper half of the problem.
 *
 * This host is the only observer of `worker_down`, so its own arms going quiet one at a time
 * is the version of the fault that coincides with the outage it exists to report. A streak is
 * one driver's experience of one sink, so the worker's `alert_sink_degraded` says nothing
 * about the arms composed HERE — the two drivers cannot see each other's.
 *
 * The driver's streak memory is a module-level singleton (see `DeliveryStreak` for why it is
 * not a table), so these tests use UNIQUE SINK NAMES: the per-arm record is keyed by name, and
 * a name no other test uses cannot be polluted by one, whatever order they run in.
 */
describe("the API driver reports an arm that has stopped delivering", () => {
  it("logs alert_sink_degraded once the arm's own streak crosses, while the page still lands", async () => {
    const { deps } = await makeDeps();
    const lines: string[] = [];
    const good: AlertSink = { name: "mail-degrade-a", notify: () => Promise.resolve(true) };
    const dead: AlertSink = {
      name: "push-degrade-a",
      notify: () => Promise.resolve({
        ok: false, outcome: "unreachable" as const, error: "TypeError: fetch failed (ETIMEDOUT)",
      }),
    };
    const withAlerts = {
      ...deps,
      logger: createLogger({ service: "api", level: "debug", sink: (l) => lines.push(l) }),
      // Zero repeat interval, so every pass re-notifies and the streak advances at the pace of
      // the passes rather than of the wall clock.
      alerts: { secret: SECRET, sinks: [good, dead], repeatMs: 0 },
    };

    for (let i = 0; i < 3; i++) {
      const res = await H(post(SECRET), withAlerts);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.delivered, "the page landed every time — nothing else would have said so")
        .toEqual(["mail-degrade-a"]);
    }

    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const lost = events.filter((e) => e.event === "alert_sink_degraded");
    expect(lost, "one report per streak, from THIS driver about ITS OWN arms").toHaveLength(1);
    expect(lost[0]!.sink).toBe("push-degrade-a");
    expect(lost[0]!.outcome, "a closed code, not the vendor's prose").toBe("unreachable");
    expect(lost[0]!.survivors).toEqual(["mail-degrade-a"]);
    expect(
      events.filter((e) => e.event === "alerts_undeliverable"),
      "nothing was undeliverable — that alarm is for a total silence and must stay quiet here",
    ).toEqual([]);
  });

  it("answers the per-arm standing health to a caller holding the credential", async () => {
    const { deps } = await makeDeps();
    const good: AlertSink = { name: "mail-degrade-b", notify: () => Promise.resolve(true) };
    const dead: AlertSink = {
      name: "push-degrade-b",
      notify: () => Promise.resolve({ ok: false, outcome: "refused" as const, error: "HTTP 401" }),
    };
    const res = await H(post(SECRET), {
      ...deps, alerts: { secret: SECRET, sinks: [good, dead] },
    });
    const body = await res.json();
    const byName = Object.fromEntries(
      (body.sinkHealth as Array<{ name: string }>).map((h) => [h.name, h]),
    );
    expect(byName["mail-degrade-b"]).toMatchObject({ outcome: "ok", attempts: 1, consecutiveFailures: 0 });
    expect(byName["push-degrade-b"]).toMatchObject({ outcome: "refused", attempts: 1, consecutiveFailures: 1 });
  });
});

describe("POST /internal/alerts — the surface", () => {
  it("404s on a host with no alerts config: no secret ⇒ no endpoint", async () => {
    const { deps } = await makeDeps();
    const res = await H(post(SECRET), deps);
    // 404, deliberately, not 401. Advertising an endpoint a deployment cannot authenticate
    // is strictly worse than not having one.
    expect(res.status).toBe(404);
  });

  it("401s with no bearer, a wrong bearer, or a wrong scheme", async () => {
    const { deps } = await makeDeps();
    const withAlerts = { ...deps, alerts: { secret: SECRET, sinks: [] } };
    expect((await H(post(), withAlerts)).status).toBe(401);
    expect((await H(post("wrong"), withAlerts)).status).toBe(401);
    expect((await H(post(`${SECRET}x`), withAlerts)).status).toBe(401);

    const basic = new Request("http://api.test/internal/alerts", {
      method: "POST", headers: { authorization: `Basic ${SECRET}` },
    });
    expect((await H(basic, withAlerts)).status).toBe(401);
  });

  it("runs the pass on a correct secret and answers 200 EVEN WHEN ALERTS ARE FIRING", async () => {
    const { deps } = await makeDeps();
    const sink = spySink();
    // Nothing has ever written a heartbeat in this database, so `worker_down:0` fires.
    const res = await H(post(SECRET), { ...deps, alerts: { secret: SECRET, sinks: [sink] } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.firing.map((a: { key: string }) => a.key)).toContain("worker_down:0");
    expect(body.notified).toContain("worker_down:0");
    expect(body.delivered).toEqual(["spy"]);
    expect(sink.seen).toHaveLength(1);
  });

  it("AN AT-CAP POPULATION reaches a human through this endpoint", async () => {
    const { db: _db, deps } = await makeDeps();
    // The route forwards its evaluation options, so the host's at-cap reader is what makes a
    // condition here — the seam that replaced a read of this database's own subscription rows.
    // FIVE accounts, because that is the cut at which the rule stops being a signal and becomes
    // an incident, and only incidents are delivered.
    const atCap = Array.from({ length: 5 }, (_, i) => ({
      accountId: `8f1f1b7e-0000-4000-8000-00000000000${i + 1}`,
      bytes: 6_000 + i, storageBytesLimit: 5_000,
    }));
    const sink = spySink();
    const res = await H(post(SECRET), {
      ...deps, alerts: {
        secret: SECRET, sinks: [sink],
        accountsAtCap: async () => ({ atCap, read: atCap.length, total: atCap.length }),
      },
    });
    expect(res.status).toBe(200);

    const delivered = sink.seen[0]!.map((a) => a.kind);
    expect(delivered, "the at-cap incident must be in what the sink was handed")
      .toContain("storage_at_cap");
  });

  it("does not re-notify on the next poll, and reports `undeliverable` with no sink", async () => {
    const { deps } = await makeDeps();
    const sink = spySink();
    const cfg = { secret: SECRET, sinks: [sink] };
    await H(post(SECRET), { ...deps, alerts: cfg });
    const second = await H(post(SECRET), { ...deps, alerts: cfg });
    expect((await second.json()).notified).toEqual([]);
    expect(sink.seen).toHaveLength(1);

    const { deps: fresh } = await makeDeps();
    const noSink = await H(post(SECRET), { ...fresh, alerts: { secret: SECRET, sinks: [] } });
    const body = await noSink.json();
    expect(body.firing.length).toBeGreaterThan(0);
    expect(body.undeliverable).toBe(true);
  });

  it("answers 503, not a platform 500, when the pass itself fails", async () => {
    const { deps } = await makeDeps();
    // `raw` routes have NO error envelope above them, so the handler's own try/catch is the
    // only thing between a broken database and an unparseable HTML error page.
    // the pass runs on the STAFF handle, so that is the one this breaks.
    const dead = { select: () => { throw new Error("db down"); } };
    const broken = {
      ...deps,
      db: dead as unknown as ApiDeps["db"],
      adminDb: () => Promise.resolve(dead as unknown as AdminDb),
      alerts: { secret: SECRET, sinks: [] },
    };
    const res = await H(post(SECRET), broken);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("alert_pass_failed");
  });

  it("accepts the scheduler's exact request shape — declared JSON with an empty body", async () => {
    // What an external scheduler's `curl -X POST` sends. `withRequestGuard` answers 415 to
    // an unsafe method carrying a body that does not declare `application/json`, and whether
    // a bodyless `curl -X POST` presents as "no body" or "an empty body" depends on the
    // host's Request construction — so the scheduler declares both, and this pins that the
    // declared form is accepted.
    const { deps } = await makeDeps();
    const scheduled = new Request("http://api.test/internal/alerts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: "{}",
    });
    const res = await H(scheduled, { ...deps, alerts: { secret: SECRET, sinks: [] } });
    expect(res.status).toBe(200);
  });

  it("never caches", async () => {
    const { deps } = await makeDeps();
    const res = await H(post(SECRET), { ...deps, alerts: { secret: SECRET, sinks: [] } });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

/**
 * `GET /internal/alerts/run` — the PLATFORM CRON's entry point.
 *
 * Added after the 2026-08-01 outage, in which the worker died for two hours with nobody
 * notified. The POST above was correct and was called by nothing: the only scheduler was a
 * GitHub workflow whose secrets were unset, and GitHub disables a schedule outright after 60
 * days of repository inactivity. This is the second clock, on Vercel, and Vercel Cron issues
 * GET and only GET.
 *
 * A separate path from `GET /internal/alerts` on purpose: that one is the runbook's SAFE read
 * and must stay incapable of paging anyone.
 */
const CRON = "/internal/alerts/run";
const CRON_SECRET = "c".repeat(32);

function run(secret?: string): Request {
  return new Request(`http://api.test${CRON}`, {
    method: "GET",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

describe("GET /internal/alerts/run — the Vercel Cron driver", () => {
  it("404s on a host with no alerts config, exactly like the POST", async () => {
    const { deps } = await makeDeps();
    expect((await H(run(SECRET), deps)).status).toBe(404);
  });

  it("401s unauthenticated — a crawler or a link preview cannot fire the pass", async () => {
    // This is the whole answer to "a GET with side effects". The objection was never the
    // verb: it was that a prefetch can issue one. A prefetch cannot present a bearer token.
    const { deps } = await makeDeps();
    const cfg = { secret: SECRET, cronSecret: CRON_SECRET, sinks: [] };
    expect((await H(run(), { ...deps, alerts: cfg })).status).toBe(401);
    expect((await H(run("wrong"), { ...deps, alerts: cfg })).status).toBe(401);
    expect((await H(run(`${CRON_SECRET}x`), { ...deps, alerts: cfg })).status).toBe(401);
  });

  it("runs the pass for EITHER credential — the scheduler's, or Vercel's own CRON_SECRET", async () => {
    const { deps } = await makeDeps();
    const viaAlert = spySink();
    const first = await H(run(SECRET), {
      ...deps, alerts: { secret: SECRET, cronSecret: CRON_SECRET, sinks: [viaAlert] },
    });
    expect(first.status).toBe(200);
    expect((await first.json()).firing.map((a: { key: string }) => a.key)).toContain("worker_down:0");

    const { deps: fresh } = await makeDeps();
    const viaCron = spySink();
    const second = await H(run(CRON_SECRET), {
      ...fresh, alerts: { secret: SECRET, cronSecret: CRON_SECRET, sinks: [viaCron] },
    });
    expect(second.status).toBe(200);
    expect(viaCron.seen).toHaveLength(1);
  });

  it("an ABSENT cronSecret does not become an empty-string second credential", async () => {
    // `Bearer ` with nothing after it already fails `bearerOf`, but the shape being pinned is
    // the config one: a host with no platform cron must accept exactly one secret.
    const { deps } = await makeDeps();
    const cfg = { secret: SECRET, sinks: [] };
    expect((await H(run(""), { ...deps, alerts: cfg })).status).toBe(401);
    expect((await H(run(" "), { ...deps, alerts: cfg })).status).toBe(401);
    expect((await H(run(SECRET), { ...deps, alerts: cfg })).status).toBe(200);
  });

  it("THE DEAD WORKER reaches a sink through the cron path", async () => {
    // No heartbeat has ever been written in this database, which is what a worker that never
    // came back looks like. This is the alert the August outage could not deliver.
    const { deps } = await makeDeps();
    const sink = spySink();
    const res = await H(run(CRON_SECRET), {
      ...deps, alerts: { secret: SECRET, cronSecret: CRON_SECRET, sinks: [sink] },
    });
    expect(res.status).toBe(200);
    expect(sink.seen[0]!.map((a) => a.kind)).toContain("worker_down");
  });

  it("answers 503, never a platform 500, when the pass itself fails", async () => {
    const { deps } = await makeDeps();
    const dead = { select: () => { throw new Error("db down"); } };
    const broken = {
      ...deps,
      db: dead as unknown as ApiDeps["db"],
      adminDb: () => Promise.resolve(dead as unknown as AdminDb),
      alerts: { secret: SECRET, cronSecret: CRON_SECRET, sinks: [] },
    };
    const res = await H(run(CRON_SECRET), broken);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("alert_pass_failed");
  });

  it("does not shadow the read-only GET — the runbook's curl still notifies nobody", async () => {
    const { db, deps } = await makeDeps();
    const cfg = { secret: SECRET, cronSecret: CRON_SECRET, sinks: [spySink()] };
    await H(run(CRON_SECRET), { ...deps, alerts: cfg });
    const before = await db.select().from(alertState);

    const read = await H(get(SECRET), { ...deps, alerts: cfg });
    expect(read.status).toBe(200);
    expect(await db.select().from(alertState)).toEqual(before);
  });

  it("never caches", async () => {
    const { deps } = await makeDeps();
    const res = await H(run(SECRET), { ...deps, alerts: { secret: SECRET, sinks: [] } });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /internal/alerts — read-only", () => {
  it("lists what is open WITHOUT evaluating or notifying anything", async () => {
    const { db, deps } = await makeDeps();
    const cfg = { secret: SECRET, sinks: [spySink()] };
    await H(post(SECRET), { ...deps, alerts: cfg });

    const before = await db.select().from(alertState);
    const res = await H(get(SECRET), { ...deps, alerts: cfg });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.open.map((o: { alertKey: string }) => o.alertKey)).toEqual(["worker_down:0"]);

    // A runbook must be able to curl this without stamping `notified_at` on anything.
    expect(await db.select().from(alertState)).toEqual(before);
  });

  it("reports both arms and their longest 30-day gap — self-host has no console to read it", async () => {
    const { deps } = await makeDeps();
    const cfg = { secret: SECRET, sinks: [spySink()] };
    await H(post(SECRET), { ...deps, alerts: cfg });
    const body = await (await H(get(SECRET), { ...deps, alerts: cfg })).json();
    const [worker, api] = body.drivers as Array<{ driver: string; ranAt: string | null; longestGap30dS: number | null }>;
    // The worker never ran here: unknown, never a zero that reads as "never dark".
    expect(worker).toEqual({ driver: "worker", ranAt: null, longestGap30dS: null });
    expect(api!.driver).toBe("api");
    expect(api!.ranAt).not.toBeNull();
    expect(typeof api!.longestGap30dS).toBe("number");
  });

  it("carries the same 404/401 gates as the POST", async () => {
    const { deps } = await makeDeps();
    expect((await H(get(SECRET), deps)).status).toBe(404);
    expect((await H(get("nope"), { ...deps, alerts: { secret: SECRET } })).status).toBe(401);
  });
});

/**
 * A PAGER THAT IS CONFIGURED AND CANNOT RUN IS BROKEN, NOT ABSENT.
 *
 * The state: `TF_ALERT_SECRET`, `CRON_SECRET` and a sink are all set, and there is no
 * content-blind connection. Until that change that state was REACHABLE from a missing, short, or
 * pager-shared `TF_ADMIN_SECRET` — the admin console's credential — because `loadAdminConfig`
 * refused on it before it ever looked at `DATABASE_URL_ADMIN`, and the handle was built from
 * `cfg.admin`. The loaders are split now, so the only way to reach it is to lose
 * `DATABASE_URL_ADMIN` itself.
 *
 * Either way the answer must not be 404. A dead-man's switch answering "there is no such
 * endpoint" is indistinguishable from a deployment that deliberately has no pager, and the
 * distinction is the entire content of the 2026-08-01 outage: nothing reported the state, and
 * nothing could have.
 */
describe("the three routes when the pager is DARK — 503 alerts_db_unarmed, never 404", () => {
  /** Armed alerting, and no blind handle. */
  const dark = (deps: ApiDeps): ApiDeps => {
    const { adminDb: _gone, ...rest } = deps;
    return { ...rest, alerts: { secret: SECRET, cronSecret: CRON_SECRET, sinks: [] } } as ApiDeps;
  };

  it("answers 503 alerts_db_unarmed on all three, with a correct credential", async () => {
    const { deps } = await makeDeps();
    for (const request of [post(SECRET), run(CRON_SECRET), get(SECRET)]) {
      const res = await H(request, dark(deps));
      expect(res.status, request.url).toBe(503);
      expect(await res.json()).toEqual({ error: { code: "alerts_db_unarmed" } });
    }
  });

  it("is a DIFFERENT code from a pass that ran and failed — the operator needs to know which", async () => {
    // `alert_pass_failed` means the observer ran and the database refused it; this means the
    // observer was never built. One is a database incident, the other is a deploy mistake.
    const { deps } = await makeDeps();
    const brokenPass = {
      ...deps,
      adminDb: () => Promise.resolve({ select: () => { throw new Error("db down"); } } as unknown as AdminDb),
      alerts: { secret: SECRET, sinks: [] },
    };
    expect((await (await H(post(SECRET), brokenPass)).json()).error.code).toBe("alert_pass_failed");
  });

  it("reports the fault BEFORE authentication, so a drifted secret cannot mask it", async () => {
    // `/health` already publishes `alertsFault` to anyone who asks, so a 401 here would hide
    // nothing from an attacker and would hide the real fault from an operator whose scheduler
    // credential has ALSO drifted — two mistakes presenting as one 401.
    const { deps } = await makeDeps();
    for (const request of [post("wrong"), post(), run("wrong"), get("wrong")]) {
      expect((await H(request, dark(deps))).status, request.url).toBe(503);
    }
  });

  it("an ABSENT pager is still 404 — the two states keep different answers", async () => {
    const { deps } = await makeDeps();
    const { adminDb: _gone, ...noStaff } = deps;
    // No `alerts` block at all: this deployment was never meant to page anyone.
    for (const request of [post(SECRET), run(SECRET), get(SECRET)]) {
      expect((await H(request, noStaff as ApiDeps)).status, request.url).toBe(404);
    }
  });

  it("never caches the dark answer either — a cached 503 outlives the fix", async () => {
    const { deps } = await makeDeps();
    const res = await H(post(SECRET), dark(deps));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

/**
 * A HOST WITH NO CONTENT-BLIND ROLE RUNS THE PASS ON ITS OWN HANDLE (`AlertsConfig.db`).
 *
 * The self-host server has one database role and it reads mail, so it can never hold the blind
 * factory, and every route above answered 503 there for good. The blind factory still wins
 * wherever it exists: a managed host that set `db` by mistake keeps running on the blind role.
 */
describe("the host's own handle arms the three routes where no blind factory exists", () => {
  /** `dark` above plus the host's own handle — the self-host composition's shape. */
  const ownHandle = (deps: ApiDeps, handle: () => Promise<Tx>): ApiDeps => {
    const { adminDb: _gone, ...rest } = deps;
    return {
      ...rest, alerts: { secret: SECRET, cronSecret: CRON_SECRET, sinks: [], db: handle },
    } as ApiDeps;
  };

  it("answers 200 on all three, where the same deps without the handle answer 503", async () => {
    // Red mutation: drop `cfg.db` from the gate (`const db = staff`) — all three answer 503.
    const { db, deps } = await makeDeps();
    for (const request of [post(SECRET), run(CRON_SECRET), get(SECRET)]) {
      const res = await H(request, ownHandle(deps, () => Promise.resolve(db as unknown as Tx)));
      expect(res.status, request.url).toBe(200);
    }
  });

  it("the pass on that handle is the api driver's, and the read lists it", async () => {
    const { db, deps } = await makeDeps();
    const own = ownHandle(deps, () => Promise.resolve(db as unknown as Tx));
    const pass = await H(run(CRON_SECRET), own);
    expect((await pass.json()).firing.map((a: { key: string }) => a.key)).toContain("worker_down:0");
    const body = await (await H(get(SECRET), own)).json();
    const api = (body.drivers as Array<{ driver: string; ranAt: string | null }>).find((d) => d.driver === "api");
    expect(api?.ranAt, "the read must show the pass that just ran on the host's handle").not.toBeNull();
  });

  it("the blind factory wins when both are present — the host's handle is never asked", async () => {
    // Red mutation: flip the precedence (`cfg.db ?? staff`) — `own` counts 3 and `blind` 0.
    const { db, deps } = await makeDeps();
    let blind = 0;
    let own = 0;
    const both = {
      ...deps,
      adminDb: () => { blind++; return Promise.resolve(db as unknown as AdminDb); },
      alerts: {
        secret: SECRET, sinks: [],
        db: () => { own++; return Promise.resolve(db as unknown as Tx); },
      },
    } as ApiDeps;
    for (const request of [post(SECRET), run(SECRET), get(SECRET)]) {
      expect((await H(request, both)).status, request.url).toBe(200);
    }
    expect(blind, "every route ran on the blind factory").toBe(3);
    expect(own, "the host's own handle was never asked for").toBe(0);
  });

  it("keeps the 401 for a wrong credential, and a handle without a secret is still 404", async () => {
    const { db, deps } = await makeDeps();
    const handle = (): Promise<Tx> => Promise.resolve(db as unknown as Tx);
    for (const request of [post("wrong"), run("wrong"), get("wrong")]) {
      expect((await H(request, ownHandle(deps, handle))).status, request.url).toBe(401);
    }
    const { adminDb: _gone, ...noStaff } = deps;
    const blankSecret = { ...noStaff, alerts: { secret: "  ", db: handle } } as ApiDeps;
    for (const request of [post(SECRET), run(SECRET), get(SECRET)]) {
      expect((await H(request, blankSecret)).status, request.url).toBe(404);
    }
  });
});

describe("the 500 log line", () => {
  it("withErrorEnvelope writes a structured line carrying the requestId — 500s stop being invisible", async () => {
    const lines: string[] = [];
    const { deps } = await makeDeps();
    // `GET /sync` needs a session; without one it 401s through the envelope, which is not a
    // 500. Force the unexpected-throw path instead, which is the one that used to vanish.
    const exploding = {
      ...deps,
      logger: createLogger({ service: "api", sink: (l) => lines.push(l) }),
      db: { execute: () => { throw new Error("boom"); } } as unknown as ApiDeps["db"],
    };
    const res = await H(req("GET", "/mailboxes"), exploding);

    expect(res.status).toBeGreaterThanOrEqual(400);
    const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const failure = logged.find((l) => l.event === "request_unhandled" || l.event === "request_failed");
    if (failure) {
      // The id the client also gets back in `x-request-id`: one value selects every line.
      expect(typeof failure.requestId).toBe("string");
      expect(failure.method).toBe("GET");
      expect(failure.route).toBe("/mailboxes");
      // Class + code only. Never the driver's message.
      expect(failure).toHaveProperty("errorClass");
      expect(JSON.stringify(failure)).not.toContain("boom");
    }
  });
});

/**
 * `apiAlertSinkSummary` — the ONE reader of this driver's delivery streak that is not the pass.
 *
 * It exists so `GET /health` can answer the question the worker answers in its startup line and
 * this host could not answer at all: which pager arms does this deployment have, and are they
 * actually delivering. What these pin is the part a unit test of the projection cannot fake —
 * that the numbers come from the streak the PASS mutated, not from a second bookkeeping — plus
 * the two properties the endpoint depends on: no vendor prose, and a pass count that only counts
 * passes that completed.
 *
 * UNIQUE SINK NAMES for the reason the degradation suite above gives: the streak is a module
 * singleton keyed by name. The pass COUNT is that singleton's neighbour and is shared by every
 * test in the run, so it is asserted as a DELTA and never as an absolute.
 */
describe("the arm summary /health publishes", () => {
  it("reports an arm's standing verdict from the streak the pass just mutated", async () => {
    const { deps } = await makeDeps();
    const good: AlertSink = { name: "mail-summary-a", notify: () => Promise.resolve(true) };
    const dead: AlertSink = {
      name: "push-summary-a",
      notify: () => Promise.resolve({
        ok: false, outcome: "refused" as const, error: "HTTP 401 Unauthorized: bot token revoked",
      }),
    };
    const cfg = { secret: SECRET, sinks: [good, dead], repeatMs: 0 };

    // Before the pass: both arms are CONFIGURED and neither has been exercised. That is the
    // distinction the summary exists to make — "in the list, never attempted" and "not in the
    // list" read identically to a human and mean opposite things.
    const cold = apiAlertSinkSummary([good, dead]);
    expect(cold.arms.map((a) => a.name)).toEqual(["mail-summary-a", "push-summary-a"]);
    expect(cold.arms.every((a) => a.attempts === 0 && a.outcome === null)).toBe(true);

    expect((await H(post(SECRET), { ...deps, alerts: cfg })).status).toBe(200);

    const warm = apiAlertSinkSummary([good, dead]);
    const byName = Object.fromEntries(warm.arms.map((a) => [a.name, a]));
    expect(byName["mail-summary-a"]).toMatchObject({ outcome: "ok", attempts: 1, consecutiveFailures: 0 });
    expect(byName["push-summary-a"]).toMatchObject({ outcome: "refused", attempts: 1, consecutiveFailures: 1 });
    expect(typeof byName["mail-summary-a"]!.lastOkAt).toBe("string");
    expect(byName["push-summary-a"]!.lastOkAt).toBeNull();
  });

  it("NEVER carries the vendor's sentence — closed codes, counts and timestamps only", async () => {
    // `/internal/alerts` may publish `sinkErrors`: its credential gates the response. `/health`
    // is reachable by anyone, so the refusal's own text may not travel with the summary — and the
    // projection is written out field by field precisely so a later addition cannot smuggle it.
    const { deps } = await makeDeps();
    const prose = "HTTP 401 Unauthorized: bot token revoked for chat -100987654321";
    const dead: AlertSink = {
      name: "push-summary-b",
      notify: () => Promise.resolve({ ok: false, outcome: "refused" as const, error: prose }),
    };
    await H(post(SECRET), { ...deps, alerts: { secret: SECRET, sinks: [dead], repeatMs: 0 } });

    const summary = apiAlertSinkSummary([dead]);
    expect(summary.arms[0]).toMatchObject({ name: "push-summary-b", outcome: "refused" });
    expect(JSON.stringify(summary)).not.toContain("Unauthorized");
    expect(JSON.stringify(summary)).not.toContain("-100987654321");
    expect(Object.keys(summary.arms[0]!).sort()).toEqual(
      ["attempts", "consecutiveFailures", "lastOkAt", "name", "outcome"],
    );
  });

  it("counts a pass that RAN, and not an invocation that never got a handle", async () => {
    // The count is the qualifier that stops the per-arm zeros from reading as a dead pager, so
    // the line it draws is "could this invocation have touched the streak?" — not "did it
    // finish?". An invocation that never obtained the content-blind handle could not have.
    const { deps } = await makeDeps();
    const sink: AlertSink = { name: "mail-summary-c", notify: () => Promise.resolve(true) };
    const cfg = { secret: SECRET, sinks: [sink], repeatMs: 0 };

    const before = apiAlertSinkSummary([]).passes;
    expect((await H(post(SECRET), { ...deps, alerts: cfg })).status).toBe(200);
    expect(apiAlertSinkSummary([]).passes).toBe(before + 1);

    // No handle: 503, and the count does not move — the streak cannot have changed either.
    const noHandle = {
      ...deps,
      alerts: cfg,
      adminDb: () => Promise.reject(new Error("connect ECONNREFUSED")),
    } as unknown as ApiDeps;
    expect((await H(post(SECRET), noHandle)).status).toBe(503);
    expect(apiAlertSinkSummary([]).passes).toBe(before + 1);
  });

  it("COUNTS A PASS THAT DIED AFTER DELIVERY — warm counters are never labelled cold", async () => {
    // THE STATE THIS EXISTS FOR, and it is a supported one rather than a hypothetical: the streak
    // is mutated by the delivery step and the notification claims are settled AFTER it, so a
    // settle UPDATE that fails throws with the per-arm counters already advanced. Counting
    // completions would then publish fresh `attempts`/`outcome` beside `passes: 0` — the
    // qualifier declaring its own neighbours cold, and permanently so on an instance where that
    // keeps happening.
    //
    // The failure is injected at the handle, and it has to be injected AFTER delivery rather
    // than on the first `update`: the notification CLAIM is an update too, and breaking that one
    // would stop the pass before the arm was ever attempted — which is the state this test would
    // then silently be measuring instead. The sink's own `notify` is the marker that delivery has
    // happened, so the handle refuses only the updates that come after it: the settle.
    const { deps } = await makeDeps();
    let delivered = false;
    const sink: AlertSink = {
      name: "mail-summary-d",
      notify: () => { delivered = true; return Promise.resolve(true); },
    };
    const staff = await (deps.adminDb!)();
    const settleFails = {
      ...deps,
      alerts: { secret: SECRET, sinks: [sink], repeatMs: 0 },
      adminDb: () => Promise.resolve(new Proxy(staff as object, {
        get(target, prop, recv) {
          if (prop === "update" && delivered) throw new Error("settle failed: connection reset");
          return Reflect.get(target, prop, recv);
        },
      })),
    } as unknown as ApiDeps;

    const before = apiAlertSinkSummary([sink]);
    expect((await H(post(SECRET), settleFails)).status).toBe(503);
    expect(delivered, "the arm must actually have been attempted, or this proves nothing").toBe(true);
    const after = apiAlertSinkSummary([sink]);

    // The arm was exercised — that is what makes the count matter here…
    expect(after.arms[0]!.attempts).toBeGreaterThan(before.arms[0]!.attempts);
    // …and the count moved with it, so no reader sees a warm arm beside a zero.
    expect(after.passes).toBe(before.passes + 1);
  });
});
