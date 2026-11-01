import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { createApp, apiRoutes, resetApiLastResortForTests, type ApiDeps } from "@trafficflow/api";
import {
  adminDbFor, assertContentBlind, resetAdminDbs, makePooledDb, alertHeartbeatFor, NotContentBlindError,
  ALERT_DB_EVALUATE_MS, ALERT_DB_FIRST_READ_MS, ALERT_DB_HANDLE_MS, schema,
  type Alert, type AlertSink, type HeartbeatGet, type ResolutionNotice,
} from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import type { AdminDb } from "@trafficflow/services";
import {
  MailService, SpyMailer, dbFreeMailAlertSink, dbRecipientLimiter, mailAlertSink, makeTestAuthDeps, throttleKeysFor,
} from "@trafficflow/services";
import { createLogger } from "@trafficflow/core";
import { makeDeps } from "./helpers.js";

/**
 * THE API DRIVER WHEN THE DATABASE IS GONE. Its pass runs on the staff connection, so a database
 * outage fails the pass at the handle; before this, only `alert_pass_failed` remained. Now the
 * failure path pages once through the host's last-resort arms, with no database read or write,
 * and the first completed pass after it sends one resolved notice to the push arm. The same for a
 * database that answers and refuses the pass's writes (read-only), and for one too slow for the
 * pass's reads to finish inside the evaluation's deadline, counted from the request's start.
 */

const app = createApp(apiRoutes);
const SECRET = "s".repeat(32);
const run = (d: ApiDeps): Promise<Response> => app.handle(new Request("http://api.test/internal/alerts", {
  method: "POST", headers: { authorization: `Bearer ${SECRET}` },
}), { ...d, session: null });

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
afterEach(async () => {
  for (const k of sockets) k.destroy();
  sockets.clear();
  for (const s of servers.splice(0)) await new Promise<void>((r) => { s.close(() => r()); });
  resetAdminDbs();
});
beforeEach(() => { resetApiLastResortForTests(); });

async function refusedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** A listener that counts the connections it accepted and says nothing to them. */
async function listener(): Promise<{ port: number; connections: () => number }> {
  let n = 0;
  const s = net.createServer((sock) => { n++; sockets.add(sock); sock.on("error", () => undefined); });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  servers.push(s);
  return { port: (s.address() as net.AddressInfo).port, connections: () => n };
}

const urlOf = (port: number): string => `postgres://u:p@127.0.0.1:${port}/x`;

function pushArm(): AlertSink & { pages: Alert[][]; resolved: ResolutionNotice[][] } {
  const pages: Alert[][] = [];
  const resolved: ResolutionNotice[][] = [];
  return {
    name: "telegram", pages, resolved,
    notify: async (alerts) => { pages.push([...alerts]); return true; },
    notifyResolved: async (notices) => { resolved.push([...notices]); return true; },
  };
}

function mailService(mailer: SpyMailer): MailService {
  return new MailService({
    mailer,
    config: {
      appUrl: "https://app.ohmail.app", siteUrl: "https://ohmail.app", adminUrl: "https://admin.ohmail.app",
      supportEmail: "support@ohmail.app", operatorEmail: "ops@ohmail.example",
    },
    throttleKeys: throttleKeysFor(makeTestAuthDeps().keyProvider),
  });
}

async function world() {
  const { deps } = await makeDeps();
  const lines: string[] = [];
  const push = pushArm();
  const mailer = new SpyMailer();
  const mail = dbFreeMailAlertSink(mailService(mailer));
  const logger = createLogger({ service: "api", level: "debug", sink: (l) => lines.push(l) });
  const working = deps.adminDb!;
  const withAlerts = (adminDb: () => Promise<AdminDb>, over: Record<string, unknown> = {}): ApiDeps => ({
    ...deps, logger, adminDb,
    alerts: { secret: SECRET, sinks: [], lastResortSinks: [push, mail], environment: "test", ...over },
  });
  return { deps, lines, push, mailer, mail, working, withAlerts };
}

describe("a refused staff connection", () => {
  it("answers 503, pages each arm exactly once, and the next call sends nothing", async () => {
    const w = await world();
    const down = adminDbFor(urlOf(await refusedPort()));
    const res = await run(w.withAlerts(down));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("alert_pass_failed");
    expect(w.push.pages.map((p) => p.map((a) => a.key))).toEqual([["alert_db_unreadable:api"]]);
    expect(w.mailer.sent.map((m) => m.template)).toEqual(["operator_alert"]);
    expect((await run(w.withAlerts(down))).status).toBe(503);
    expect(w.push.pages).toHaveLength(1);
    expect(w.mailer.sent).toHaveLength(1);
    const events = w.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.filter((e) => e.event === "alert_pass_failed")).toHaveLength(2);
    expect(events.filter((e) => e.event === "alert_last_resort").map((e) => e.state)).toEqual(["paged"]);
  });

  it("then a working connection answers 200 and tells the push arm once, never the mail", async () => {
    const w = await world();
    await run(w.withAlerts(adminDbFor(urlOf(await refusedPort()))));
    const res = await run(w.withAlerts(w.working));
    expect(res.status).toBe(200);
    expect(w.push.resolved.map((n) => n.map((x) => x.key))).toEqual([["alert_db_unreadable:api"]]);
    expect(w.mailer.sent, "no mail when an alert clears").toHaveLength(1);
    expect((await run(w.withAlerts(w.working))).status).toBe(200);
    expect(w.push.resolved).toHaveLength(1);
  });

  it("a healthy pass sends nothing at all", async () => {
    const w = await world();
    expect((await run(w.withAlerts(w.working))).status).toBe(200);
    expect(w.push.pages).toHaveLength(0);
    expect(w.push.resolved).toHaveLength(0);
    expect(w.mailer.sent).toHaveLength(0);
  });

  it("no last-resort arm: the same 503 and nothing else", async () => {
    const w = await world();
    const res = await run({ ...w.withAlerts(adminDbFor(urlOf(await refusedPort()))), alerts: { secret: SECRET, sinks: [] } });
    expect(res.status).toBe(503);
    expect(w.lines.map((l) => (JSON.parse(l) as { event: string }).event)).not.toContain("alert_last_resort");
  });
});

describe("a read-only database", () => {
  it("answers 503, pages each arm once from memory, and the next call sends nothing", async () => {
    const w = await world();
    const ro = await makeTestDb();
    await ro.execute(sql`set default_transaction_read_only = on`);
    const staff = (): Promise<AdminDb> => Promise.resolve(ro as unknown as AdminDb);
    // The push arm is also an ordinary arm, as on the hosts: the pass writes before it delivers.
    const res = await run(w.withAlerts(staff, { sinks: [w.push] }));
    expect(res.status).toBe(503);
    expect(w.push.pages.map((p) => p.map((a) => a.key))).toEqual([["alert_db_unreadable:api"]]);
    expect(w.mailer.sent.map((m) => m.template)).toEqual(["operator_alert"]);
    const events = (): Array<Record<string, unknown>> => w.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events().find((e) => e.event === "alert_pass_failed")?.errorCode).toBe("25006");
    expect((await run(w.withAlerts(staff, { sinks: [w.push] }))).status).toBe(503);
    expect(w.push.pages).toHaveLength(1);
    expect(w.mailer.sent).toHaveLength(1);
    expect(events().filter((e) => e.event === "alert_last_resort").map((e) => e.state)).toEqual(["paged"]);
  });
});

/** A staff handle whose first read answers and whose rule reads never do. */
function stalledAfterPreflight(base: Awaited<ReturnType<typeof makeTestDb>>): AdminDb {
  const client = (base as unknown as { $client: PGlite }).$client;
  const stalled = new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === "query") {
        return (text: string, ...rest: unknown[]) => (/information_schema\.columns/.test(text)
          ? (value as (...a: unknown[]) => unknown).call(target, text, ...rest)
          : new Promise(() => undefined));
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return drizzlePglite({ client: stalled as unknown as PGlite, schema }) as unknown as AdminDb;
}

describe("a pass too slow to finish", () => {
  it("pages at the evaluation's deadline instead of running into the platform's limit", async () => {
    const w = await world();
    const slow = stalledAfterPreflight(await makeTestDb());
    const started = Date.now();
    const res = await run(w.withAlerts(() => Promise.resolve(slow), { readDeadlinesMs: { evaluate: 400 } }));
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(w.push.pages.map((p) => p.map((a) => a.key))).toEqual([["alert_db_unreadable:api"]]);
  });

  it("the evaluation's budget counts from the request's start, the staff handle's time included", async () => {
    const w = await world();
    const slow = stalledAfterPreflight(await makeTestDb());
    const late = async (): Promise<AdminDb> => { await new Promise((r) => setTimeout(r, 1_000)); return slow; };
    const started = Date.now();
    const res = await run(w.withAlerts(late, { readDeadlinesMs: { evaluate: 1_500 } }));
    const took = Date.now() - started;
    expect(res.status).toBe(503);
    expect(took, "1.5 s from the start, not 1 s + 1.5 s").toBeLessThan(2_000);
    expect(took).toBeGreaterThanOrEqual(1_400);
    expect(w.push.pages).toHaveLength(1);
  });
});

describe("a staff server that accepts and never answers", () => {
  it("pages once, at the handle's deadline", async () => {
    const w = await world();
    const silent = await listener();
    const started = Date.now();
    const res = await run(w.withAlerts(adminDbFor(urlOf(silent.port)), { readDeadlinesMs: { handle: 300 } }));
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(w.push.pages).toHaveLength(1);
  });
});

describe("the last-resort mail arm never dials the database", () => {
  it("the limiter's database sees no connection; built with the database limiter, it does and the mail fails", async () => {
    const w = await world();
    const pooled = await listener();
    const down = adminDbFor(urlOf(await refusedPort()));
    expect((await run(w.withAlerts(down))).status).toBe(503);
    expect(w.mailer.sent).toHaveLength(1);
    expect(pooled.connections(), "the db-free arm made no connection").toBe(0);

    // Positive control: the ordinary arm, its limiter on that listener's URL.
    resetApiLastResortForTests();
    const mailer = new SpyMailer();
    const dbArm = mailAlertSink(mailService(mailer), {
      limiter: dbRecipientLimiter(makePooledDb(urlOf(pooled.port), { acquireTimeoutMs: 300, max: 1 })),
      now: () => new Date(),
    });
    const res = await run({ ...w.withAlerts(down), alerts: { secret: SECRET, sinks: [], lastResortSinks: [dbArm] } });
    expect(res.status).toBe(503);
    expect(pooled.connections(), "the control dialled the database").toBeGreaterThan(0);
    expect(mailer.sent, "and could not mail").toHaveLength(0);
  }, 20_000);
});

describe("the staff refusal's cause", () => {
  it("a refused connection carries ECONNREFUSED as its cause; a role verdict carries none", async () => {
    const err = await adminDbFor(urlOf(await refusedPort()))().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotContentBlindError);
    expect(((err as Error).cause as { code?: string }).code).toBe("ECONNREFUSED");
    const verdict = await assertContentBlind({ execute: async () => [] } as never).catch((e: unknown) => e);
    expect(verdict).toBeInstanceOf(NotContentBlindError);
    expect((verdict as Error).cause).toBeUndefined();
  });
});

describe("the heartbeat", () => {
  const URL = "https://hc.example/ping/9a8b7c-secret-path";
  const recording = (answer: () => Promise<{ status: number }>): HeartbeatGet & { calls: number } => {
    const get = ((): Promise<{ status: number }> => { get.calls++; return answer(); }) as HeartbeatGet & { calls: number };
    get.calls = 0;
    return get;
  };

  it("fires once after a 200, never on a 503, and is absent when unset", async () => {
    const w = await world();
    const get = recording(async () => ({ status: 200 }));
    const heartbeat = alertHeartbeatFor(URL, get);
    expect((await run(w.withAlerts(w.working, { heartbeat }))).status).toBe(200);
    expect(get.calls).toBe(1);
    expect((await run(w.withAlerts(adminDbFor(urlOf(await refusedPort())), { heartbeat }))).status).toBe(503);
    expect(get.calls).toBe(1);
    expect((await run(w.withAlerts(w.working, { heartbeat: alertHeartbeatFor(undefined, get) }))).status).toBe(200);
    expect(get.calls).toBe(1);
  });

  it("a hanging ping still answers 200 within the bound plus a second, and no log line names the URL", async () => {
    const w = await world();
    const heartbeat = alertHeartbeatFor(URL, recording(() => new Promise(() => undefined)), 300);
    const started = Date.now();
    expect((await run(w.withAlerts(w.working, { heartbeat }))).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_300);
    expect(w.lines.map((l) => JSON.parse(l).event)).toContain("alert_heartbeat_failed");
    expect(w.lines.join("\n")).not.toContain("hc.example");
    expect(w.lines.join("\n")).not.toContain("secret-path");
  });
});

describe("the budget a serverless instance has", () => {
  it("the evaluation's deadline, from the request's start, + webhook and Telegram (8 s each) + Resend (10 s) stays under 60 s", () => {
    // The staff handle and the first read run inside the evaluation's budget, which counts from the
    // request's start; the last-resort page then goes to the three arms one after the other.
    expect(ALERT_DB_HANDLE_MS).toBeLessThan(ALERT_DB_EVALUATE_MS);
    expect(ALERT_DB_FIRST_READ_MS).toBeLessThan(ALERT_DB_EVALUATE_MS);
    expect(ALERT_DB_EVALUATE_MS + 2 * 8_000 + 10_000).toBeLessThan(60_000);
  });
});
