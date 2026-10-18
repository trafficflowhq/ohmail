import { describe, it, expect, vi, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { silentLogger, type Logger } from "@trafficflow/core";
import type { Tx } from "@trafficflow/db";
import type { Alert } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { SmtpMailer } from "@trafficflow/services";
import { loadServerConfig, type ServerConfig } from "../src/config.js";
import { alertSinksFor, buildDeps, customerMailerFor, type ServerRuntime } from "../src/deps.js";
import { handleServerRequest } from "../src/handler.js";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";

/**
 * THE SELF-HOST API ALERT ARM'S CHANNELS AND ITS HANDLE.
 *
 * `TF_ALERT_SECRET` armed the intake and every `/internal/alerts` route answered 503: this host
 * composed no handle for the pass. Now the runtime pool is that handle (`alertDb`), the arms are
 * the worker's three (webhook, Telegram, mail — mail through this server's own SMTP block), and
 * `/health` says the same thing the routes do: `alertsFault` present exactly when they answer 503.
 */

const SECRET = "a".repeat(32);
const WEBHOOK = "https://ntfy.example/ohmail";
// Assembled at run time: shaped like a BotFather token and a chat id, and neither is one.
const BOT_TOKEN = `${"8".repeat(10)}:${"A".repeat(35)}`;
const CHAT_ID = `-100${"7".repeat(10)}`;
const PAGER = "ops@mail.example.com";
const SMTP = { SMTP_URL: "smtp://127.0.0.1:2525", MAIL_FROM: "ohmail <no-reply@mail.example.com>" };

const BASE = {
  OHMAIL_ORIGIN: "https://mail.example.com",
  DATABASE_URL: "postgres://tf:tf@localhost:5433/never_dialed",
  [KEY_RING_V1]: "ab".repeat(32),
};
const cfgWith = (extra: Record<string, string>): ServerConfig =>
  loadServerConfig({ ...BASE, ...extra } as NodeJS.ProcessEnv);
const armNames = (cfg: ServerConfig): string[] => alertSinksFor(cfg, silentLogger, {} as never).map((s) => s.name);

function runtime(cfg: ServerConfig, db: unknown, logger: Logger = silentLogger): ServerRuntime {
  return {
    cfg, db: db as never, services: {} as never, changeWake: null, oauth: {} as never,
    onSetupTokenMinted: () => {}, logger,
    alertSinks: alertSinksFor(cfg, logger, db as never),
    alertDb: () => Promise.resolve(db as unknown as Tx),
  };
}

const alertsGet = (): Request => new Request("http://localhost:8080/internal/alerts", {
  headers: { authorization: `Bearer ${SECRET}` },
});

afterEach(() => { vi.restoreAllMocks(); });

describe("the arms TF_ALERT_SECRET arms, named the way the organizer names its own", () => {
  it("none without the secret, whatever channel is set: the api pages nobody and its routes are 404", () => {
    expect(armNames(cfgWith({ TF_ALERT_WEBHOOK_URL: WEBHOOK, ...SMTP, TF_ALERT_EMAIL: PAGER }))).toEqual([]);
  });

  it("[] → [webhook] → [webhook, telegram] → [webhook, telegram, mail]", () => {
    // Red mutation: drop the Telegram or the mail arm from alertSinksFor — its row loses the name.
    expect(armNames(cfgWith({ TF_ALERT_SECRET: SECRET }))).toEqual([]);
    expect(armNames(cfgWith({ TF_ALERT_SECRET: SECRET, TF_ALERT_WEBHOOK_URL: WEBHOOK }))).toEqual(["webhook"]);
    const push = { TF_ALERT_TELEGRAM_BOT_TOKEN: BOT_TOKEN, TF_ALERT_TELEGRAM_CHAT_ID: CHAT_ID };
    expect(armNames(cfgWith({ TF_ALERT_SECRET: SECRET, TF_ALERT_WEBHOOK_URL: WEBHOOK, ...push })))
      .toEqual(["webhook", "telegram"]);
    expect(armNames(cfgWith({
      TF_ALERT_SECRET: SECRET, TF_ALERT_WEBHOOK_URL: WEBHOOK, ...push, ...SMTP, TF_ALERT_EMAIL: PAGER,
    }))).toEqual(["webhook", "telegram", "mail"]);
  });

  it("a half-set Telegram pair is an arm that refuses every page naming the missing variable", async () => {
    const [arm] = alertSinksFor(
      cfgWith({ TF_ALERT_SECRET: SECRET, TF_ALERT_TELEGRAM_BOT_TOKEN: BOT_TOKEN }), silentLogger, {} as never,
    );
    expect(arm?.name).toBe("telegram");
    const out = await arm!.notify([], { source: "api", environment: "production", now: new Date() });
    expect(out).toMatchObject({ ok: false, outcome: "misconfigured" });
    expect(JSON.stringify(out)).toContain("TF_ALERT_TELEGRAM_CHAT_ID");
  });
});

describe("TF_ALERT_EMAIL refuses the boot where the mail arm could not exist", () => {
  const refusal = (extra: Record<string, string>): string => {
    try {
      cfgWith({ TF_ALERT_SECRET: SECRET, ...extra });
    } catch (err) {
      return (err as Error).message;
    }
    return "";
  };

  it("with no SMTP block: names TF_ALERT_EMAIL, SMTP_URL and MAIL_FROM, and never the address", () => {
    // Red mutation: drop the refusal — the boot succeeds with a mail arm nobody built.
    const message = refusal({ TF_ALERT_EMAIL: PAGER });
    expect(message).toMatch(/TF_ALERT_EMAIL/);
    expect(message).toMatch(/SMTP_URL/);
    expect(message).toMatch(/MAIL_FROM/);
    expect(message).not.toContain(PAGER);
    expect(message).not.toContain("mail.example.com");
  });

  it("not one plain address: names the variable, never the value", () => {
    for (const bad of ["Ops <ops@mail.example.com>", "ops@mail.example.com, b@mail.example.com", "\"ops@mail.example.com\""]) {
      const message = refusal({ ...SMTP, TF_ALERT_EMAIL: bad });
      expect(message, bad).toMatch(/TF_ALERT_EMAIL/);
      expect(message, bad).not.toContain("mail.example.com");
    }
  });

  it("without the secret the variable arms nothing and refuses nothing", () => {
    expect(cfgWith({ TF_ALERT_EMAIL: PAGER }).alerts).toBeNull();
  });
});

describe("the mail arm pages the operator through this server's own SMTP block", () => {
  const firing: Alert = {
    key: "worker_down:0", kind: "worker_down", severity: "critical",
    title: "The organizer is down", detail: "No leader heartbeat for 3 minutes.", count: 1, oldestSeconds: 180,
  };

  it("notify → MailService.sendOperatorAlert → the SMTP transport, the slot claimed on the runtime pool", async () => {
    // Red mutation: build the mail arm over the customer mailer (no operatorEmail) — the send is
    // skipped and notify answers false.
    const sent = vi.spyOn(SmtpMailer.prototype, "send").mockResolvedValue({ status: "sent", providerId: null });
    const db = await makeTestDb();
    const cfg = cfgWith({ TF_ALERT_SECRET: SECRET, ...SMTP, TF_ALERT_EMAIL: PAGER });
    const mail = alertSinksFor(cfg, silentLogger, db as never).find((s) => s.name === "mail");
    expect(mail?.channel, "a quota-bound inbox, paged under the mail policy").toBe("mail");

    const delivered = await mail!.notify([firing], { source: "api", environment: "production", now: new Date() });
    expect(delivered).toBe(true);
    expect(sent).toHaveBeenCalledTimes(1);
    const [to, template, data] = sent.mock.calls[0]!;
    expect(to).toBe(PAGER);
    expect(template).toBe("operator_alert");
    expect(JSON.stringify(data)).toContain("The organizer is down");
    // The per-recipient limiter's slot, written on the handle this arm was given.
    const rows = await db.execute(sql`select count(*)::int as n from auth_throttle where key like 'mail:transactional:%'`);
    expect((rows.rows[0] as { n: number }).n).toBe(1);
  });

  it("the customer mailer still cannot mail the pager: two instances, two threat models", async () => {
    const sent = vi.spyOn(SmtpMailer.prototype, "send").mockResolvedValue({ status: "sent", providerId: null });
    const customer = customerMailerFor(cfgWith({ TF_ALERT_SECRET: SECRET, ...SMTP, TF_ALERT_EMAIL: PAGER }))!;
    const out = await customer.sendOperatorAlert(
      { limiter: { claim: async () => 1 }, now: () => new Date() },
      { alerts: [firing], source: "api", environment: "production", idempotencyBucketMs: 60_000 },
    );
    expect(out.status).toBe("skipped");
    expect(sent).not.toHaveBeenCalled();
  });
});

describe("the composed host: /internal/alerts answers, and /health says what the routes do", () => {
  it("GET /internal/alerts answers 200 with both drivers, where it answered 503 alerts_db_unarmed", async () => {
    // Red mutation: drop `db:` from buildDeps' alerts block — 503 alerts_db_unarmed again.
    const db = await makeTestDb();
    const res = await handleServerRequest(alertsGet(), runtime(cfgWith({ TF_ALERT_SECRET: SECRET }), db));
    expect(res.status).toBe(200);
    const body = await res.json() as { drivers: Array<{ driver: string }> };
    expect(body.drivers.map((d) => d.driver).sort()).toEqual(["api", "worker"]);
  });

  it("alertsFault present ⇔ the routes answer 503: absent with the handle, named without it", async () => {
    // Red mutation: alertsError hard-wired to null — the dark pager answers 503 and /health is silent.
    const db = await makeTestDb();
    const cfg = cfgWith({ TF_ALERT_SECRET: SECRET });
    const armed = runtime(cfg, db);
    expect(buildDeps(new Request(cfg.origin), armed).health?.alertsError ?? null).toBeNull();

    const dark: ServerRuntime = { ...armed, alertDb: null };
    const fault = buildDeps(new Request(cfg.origin), dark).health?.alertsError;
    expect(fault).toMatch(/alerts_db_unarmed/);
    const res = await handleServerRequest(alertsGet(), dark);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "alerts_db_unarmed" } });
  });

  it("alertsFault is null with no secret: an unarmed pager is absent, not broken", () => {
    const cfg = cfgWith({});
    const dark: ServerRuntime = { ...runtime(cfg, {}), alertDb: null };
    expect(buildDeps(new Request(cfg.origin), dark).health?.alertsError ?? null).toBeNull();
  });

  it("no secret, no pager: /health publishes no alertSinks; armed with no arm, it publishes []", () => {
    // Red mutation: inject alertSinks unconditionally — an unarmed box claims a pager that cannot page.
    const unarmed = cfgWith({});
    expect(buildDeps(new Request(unarmed.origin), runtime(unarmed, {})).health?.alertSinks ?? null).toBeNull();
    const armed = cfgWith({ TF_ALERT_SECRET: SECRET });
    expect(buildDeps(new Request(armed.origin), runtime(armed, {})).health?.alertSinks?.().arms).toEqual([]);
  });

  it("/health's alertSinks names the arms the pass delivers to", () => {
    const cfg = cfgWith({
      TF_ALERT_SECRET: SECRET, TF_ALERT_WEBHOOK_URL: WEBHOOK, ...SMTP, TF_ALERT_EMAIL: PAGER,
    });
    const summary = buildDeps(new Request(cfg.origin), runtime(cfg, {})).health?.alertSinks?.();
    expect(summary?.arms.map((a) => a.name)).toEqual(["webhook", "mail"]);
  });
});
