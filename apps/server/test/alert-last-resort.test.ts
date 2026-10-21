import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { resetApiLastResortForTests } from "@trafficflow/api";
import { createLogger, silentLogger, type Logger } from "@trafficflow/core";
import type { Tx } from "@trafficflow/db";
import { alertHeartbeatFor, type Alert, type AlertSink, type HeartbeatGet, type ResolutionNotice } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { SmtpMailer } from "@trafficflow/services";
import { loadServerConfig, type ServerConfig } from "../src/config.js";
import { alertArmsFor, alertHeartbeatForServer, type ServerRuntime } from "../src/deps.js";
import { alertClockFor } from "../src/alert-clock.js";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";

/**
 * THE SELF-HOST API DRIVER WHEN THE DATABASE IS GONE: the same pass and the same last-resort path
 * as the managed host, on this server's own clock. Failing ticks page once from memory; good
 * ticks close the episode and ping the heartbeat; the arms are the ordinary ones with the mail
 * arm's limiter in memory.
 */

const SECRET = "a".repeat(32);
const SMTP = { SMTP_URL: "smtp://127.0.0.1:2525", MAIL_FROM: "ohmail <no-reply@mail.example.com>" };
const BASE = {
  OHMAIL_ORIGIN: "https://mail.example.com",
  DATABASE_URL: "postgres://tf:tf@localhost:5433/never_dialed",
  [KEY_RING_V1]: "ab".repeat(32),
};
const cfgWith = (extra: Record<string, string>): ServerConfig =>
  loadServerConfig({ ...BASE, ...extra } as NodeJS.ProcessEnv);

function captured(): { lines: Array<Record<string, unknown>>; logger: Logger } {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    service: "server", level: "debug", sink: (l) => { lines.push(JSON.parse(l) as Record<string, unknown>); },
  });
  return { lines, logger };
}

beforeEach(() => { resetApiLastResortForTests(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("the clock's failing ticks page once; good ticks resolve and ping", () => {
  it("three failed ticks, one page; then a good tick, one resolved notice and the heartbeat", async () => {
    const db = await makeTestDb();
    const { lines, logger } = captured();
    const pages: Alert[][] = [];
    const resolved: ResolutionNotice[][] = [];
    const push: AlertSink = {
      name: "telegram",
      notify: async (a) => { pages.push([...a]); return true; },
      notifyResolved: async (n) => { resolved.push([...n]); return true; },
    };
    let pings = 0;
    const get: HeartbeatGet = async () => { pings++; return { status: 200 }; };
    let up = false;
    const refused = Object.assign(new Error("connect"), { code: "ECONNREFUSED" });
    const rt: ServerRuntime = {
      cfg: cfgWith({ TF_ALERT_SECRET: SECRET }), db: db as never, services: {} as never, changeWake: null,
      oauth: {} as never, onSetupTokenMinted: () => {}, logger,
      alertSinks: [], alertLastResortSinks: [push],
      alertHeartbeat: alertHeartbeatFor("https://hc.example/ping/selfhost", get),
      alertDb: () => (up ? Promise.resolve(db as unknown as Tx) : Promise.reject(refused)),
    };
    const clock = alertClockFor(rt, { everyMs: 20, firstDelayMs: 1 })!;
    const failed = (): number => lines.filter((l) => l.event === "alert_pass_failed").length;
    await vi.waitFor(() => { expect(failed()).toBeGreaterThanOrEqual(3); }, { timeout: 10_000 });
    expect(pages.map((p) => p.map((a) => a.key))).toEqual([["alert_db_unreadable:api"]]);
    expect(pings, "no heartbeat while no pass completes").toBe(0);
    up = true;
    await vi.waitFor(() => { expect(pings).toBeGreaterThanOrEqual(1); }, { timeout: 10_000 });
    await clock.stop();
    expect(resolved.map((n) => n.map((x) => x.key))).toEqual([["alert_db_unreadable:api"]]);
    expect(pages).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain("hc.example");
  }, 30_000);
});

describe("a read-only database on the clock", () => {
  it("every tick refuses at its first write; one page from memory, and no heartbeat while no pass completes", async () => {
    const db = await makeTestDb();
    await db.execute(sql`set default_transaction_read_only = on`);
    const { lines, logger } = captured();
    const pages: Alert[][] = [];
    // The ordinary arm and the last-resort arm are one object, as `alertArmsFor` builds a push arm.
    const push: AlertSink = {
      name: "telegram",
      notify: async (a) => { pages.push([...a]); return true; },
      notifyResolved: async () => true,
    };
    let pings = 0;
    const get: HeartbeatGet = async () => { pings++; return { status: 200 }; };
    const rt: ServerRuntime = {
      cfg: cfgWith({ TF_ALERT_SECRET: SECRET }), db: db as never, services: {} as never, changeWake: null,
      oauth: {} as never, onSetupTokenMinted: () => {}, logger,
      alertSinks: [push], alertLastResortSinks: [push],
      alertHeartbeat: alertHeartbeatFor("https://hc.example/ping/selfhost", get),
      alertDb: () => Promise.resolve(db as unknown as Tx),
    };
    const clock = alertClockFor(rt, { everyMs: 20, firstDelayMs: 1 })!;
    const failed = (): Array<Record<string, unknown>> => lines.filter((l) => l.event === "alert_pass_failed");
    await vi.waitFor(() => { expect(failed().length).toBeGreaterThanOrEqual(4); }, { timeout: 10_000 });
    await clock.stop();
    expect(failed()[0]?.errorCode).toBe("25006");
    expect(pages.map((p) => p.map((a) => a.key))).toEqual([["alert_db_unreadable:api"]]);
    expect(pings, "no heartbeat while no pass completes").toBe(0);
  }, 30_000);
});

describe("composition", () => {
  it("the last-resort arms are the ordinary arms, by name and in order", () => {
    vi.spyOn(SmtpMailer.prototype, "send").mockResolvedValue({ status: "sent", providerId: null });
    const cfg = cfgWith({
      TF_ALERT_SECRET: SECRET, TF_ALERT_WEBHOOK_URL: "https://ntfy.example/ohmail",
      TF_ALERT_TELEGRAM_BOT_TOKEN: `${"8".repeat(10)}:${"A".repeat(35)}`, TF_ALERT_TELEGRAM_CHAT_ID: `-100${"7".repeat(10)}`,
      ...SMTP, TF_ALERT_EMAIL: "ops@mail.example.com",
    });
    const { sinks, lastResort } = alertArmsFor(cfg, silentLogger, {} as never);
    expect(lastResort.map((s) => s.name)).toEqual(["webhook", "telegram", "mail"]);
    expect(lastResort.map((s) => s.name)).toEqual(sinks.map((s) => s.name));
    expect(lastResort[0], "the webhook is the same object").toBe(sinks[0]);
    expect(lastResort[2], "the mail arm is its own").not.toBe(sinks[2]);
  });

  it("the last-resort mail arm sends with no database at all", async () => {
    const sent = vi.spyOn(SmtpMailer.prototype, "send").mockResolvedValue({ status: "sent", providerId: null });
    const cfg = cfgWith({ TF_ALERT_SECRET: SECRET, ...SMTP, TF_ALERT_EMAIL: "ops@mail.example.com" });
    const explode = new Proxy({}, { get: () => { throw new Error("the database was touched"); } });
    const { lastResort } = alertArmsFor(cfg, silentLogger, explode as never);
    const out = await lastResort[0]!.notify([{
      key: "alert_db_unreadable:api", kind: "alert_db_unreadable", severity: "critical",
      title: "The api alert pass cannot use the database", detail: "x", count: 1, oldestSeconds: null,
    }], { source: "api", environment: "production", now: new Date() });
    expect(out).toBe(true);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("both hosts build the last-resort mail arm with dbFreeMailAlertSink, never the database limiter", () => {
    for (const file of ["../src/deps.ts", "../../api-vercel/src/deps.ts"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      const lines = src.split("\n").filter((l) => /lastResort:/.test(l) && !/^\s*(\/\/|\*)/.test(l));
      const mail = lines.filter((l) => /Mail|mail/.test(l));
      expect(mail.length, `${file} builds a last-resort mail arm`).toBe(1);
      expect(mail[0]).toMatch(/lastResort:\s*dbFreeMailAlertSink\(service\)/);
      expect(lines.join("\n")).not.toContain("dbRecipientLimiter");
    }
  });

  it("an unusable heartbeat URL is named by its variable, never its value", () => {
    const { lines, logger } = captured();
    const hb = alertHeartbeatForServer(cfgWith({ TF_ALERT_SECRET: SECRET, TF_ALERT_HEARTBEAT_URL: '"https://hc.example/ping/q"' }), logger);
    expect(hb.state).toBe("unusable");
    expect(lines).toEqual([expect.objectContaining({ event: "alert_heartbeat_unusable", configVar: "TF_ALERT_HEARTBEAT_URL" })]);
    expect(JSON.stringify(lines)).not.toContain("hc.example");
    expect(lines.filter((l) => "droppedFields" in l)).toEqual([]);
  });
});
