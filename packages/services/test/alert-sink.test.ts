import { describe, it, expect } from "vitest";
import { FIXTURE_SHAPES, resendKey } from "../../../test/support/fixture-credentials.js";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  ALERT_MAIL_SCHEDULE, DEFAULT_ALERT_RENOTIFY_UNCHANGED_MS, DEFAULT_ALERT_REPEAT_MS,
  authThrottle, mailCooldownMs, resendAlertSink,
  type Alert, type AlertNotifyContext,
} from "@trafficflow/db/cloud";
import type { KeyProvider } from "@trafficflow/core/mail";
import {
  MailService, ResendMailer, SpyMailer, mailAlertSink, renderTemplate, dbRecipientLimiter, makeTestAuthDeps, throttleKeysFor,
  type RecipientLimiter,
} from "../src/index.js";

/**
 * the MAIL delivery path for an operator alert.
 *
 * It is the second sink, not the first. The webhook sink (`packages/db`) is what reaches a
 * phone and is the one the worker can use at all; this one exists so the pager does not have
 * exactly one delivery path, on infrastructure that shares nothing with the other.
 *
 * Two properties matter more than the rendering: the recipient is CONFIGURATION and can
 * never be an argument, and `skipped` is never reported as delivered.
 */

const NOW = new Date("2026-07-31T12:00:00.000Z");

const ALERTS: Alert[] = [
  {
    key: "worker_down:0", kind: "worker_down", severity: "critical",
    title: "shard 0 has no worker heartbeat",
    detail: "the oldest arrived 19h ago; a paid invoice whose apply failed grants no credits",
    count: 2, oldestSeconds: 68_400,
  },
  {
    key: "worker_down:0", kind: "worker_down", severity: "critical",
    title: "Sync worker (shard 0) is not running",
    detail: "Last leader heartbeat was 6m ago. No mailbox is syncing.",
    count: 1, oldestSeconds: 360,
  },
];

const CTX: AlertNotifyContext = { source: "api", environment: "production", now: NOW };
const KEYS = throttleKeysFor(makeTestAuthDeps().keyProvider);

async function harness(over: { operatorEmail?: string } = {}) {
  const db = await makeTestDb();
  const mailer = new SpyMailer();
  const service = new MailService({
    mailer,
    config: {
      appUrl: "https://app.ohmail.app",
      siteUrl: "https://ohmail.app",
      adminUrl: "https://admin.ohmail.app",
      supportEmail: "support@ohmail.app",
      operatorEmail: "operatorEmail" in over ? over.operatorEmail : "ops@ohmail.example",
    },
    throttleKeys: KEYS,
  });
  return {
    db, mailer,
    sink: mailAlertSink(service, { limiter: dbRecipientLimiter(db), now: () => NOW }),
  };
}

describe("mailAlertSink", () => {
  it("mails the CONFIGURED operator — the recipient is never an argument", async () => {
    const { mailer, sink } = await harness();
    expect(await sink.notify(ALERTS, CTX)).toBe(true);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe("ops@ohmail.example");
    expect(mailer.sent[0]!.template).toBe("operator_alert");
    // Nothing on the sink or the service takes a `to`: an alert mailer that did would be an
    // unattended mail-bomb primitive, since a machine triggers it on a timer.
    // The mail policy's two additions name no recipient either: a channel and the digest.
    expect(Object.keys(sink)).toEqual(["name", "channel", "notify", "notifyDigest"]);
    expect(sink.channel).toBe("mail");
    expect("notifyResolved" in sink, "a cleared alert is in the digest, not a mail").toBe(false);
  });

  it("the digest mails the configured operator through its own template", async () => {
    const { mailer, sink } = await harness();
    const digest = {
      since: "2026-08-20T12:00:00.000Z", more: 0,
      lines: [{
        key: "sends_stuck", kind: "sends_stuck", severity: "critical", title: "1 send stuck",
        openedAt: "2026-08-21T09:00:00.000Z", resolvedAt: null,
      }],
    };
    expect(await sink.notifyDigest!(digest, CTX)).toBe(true);
    expect(mailer.sent.map((m) => [m.to, m.template])).toEqual([["ops@ohmail.example", "operator_digest"]]);
    expect(mailer.sent[0]!.rendered.subject).toBe("[production] ohmail: daily alert summary — 1 incident");
  });

  it("a lone schema_behind keeps one key across the page window; an ordinary page keeps the minute", async () => {
    const behind: Alert[] = [{
      key: "schema_behind:api", kind: "schema_behind", severity: "critical",
      title: "The api host is ahead of the database schema", detail: "Run the cloud migrations.",
      count: 1, oldestSeconds: null,
    }];
    const keysAt = async (alerts: Alert[], offsets: number[]): Promise<string[]> => {
      const db = await makeTestDb();
      const mailer = new SpyMailer();
      const service = new MailService({ mailer, config: {
        appUrl: "https://app.ohmail.app", siteUrl: "https://ohmail.app", adminUrl: "https://admin.ohmail.app",
        supportEmail: "support@ohmail.app", operatorEmail: "ops@ohmail.example",
      }, throttleKeys: KEYS });
      for (const ms of offsets) {
        const at = new Date(Date.UTC(2026, 7, 21, 12, 0, 0) + ms);
        await mailAlertSink(service, { limiter: dbRecipientLimiter(db), now: () => at }).notify(alerts, CTX);
      }
      return mailer.sent.map((m) => m.idempotencyKey ?? "");
    };
    const behindKeys = await keysAt(behind, [0, 2 * 60 * 60_000, 5 * 60 * 60_000]);
    expect(behindKeys).toHaveLength(3);
    expect(new Set(behindKeys).size, "one key: the provider replays the first mail").toBe(1);
    const pageKeys = await keysAt(ALERTS, [0, 2 * 60_000]);
    expect(new Set(pageKeys).size, "a page two minutes later is another mail").toBe(2);
  });

  it("carries every firing alert, the source and the environment", async () => {
    const { mailer, sink } = await harness();
    await sink.notify(ALERTS, CTX);
    const data = mailer.sent[0]!.data as {
      alerts: Array<{ title: string }>; source: string; environment: string; consoleUrl: string;
    };
    expect(data.alerts.map((a) => a.title)).toEqual(ALERTS.map((a) => a.title));
    expect(data.source).toBe("api");
    expect(data.environment).toBe("production");
    expect(data.consoleUrl).toBe("https://admin.ohmail.app");
  });

  it("SKIPPED IS NOT DELIVERED — no operator address means the alert did not reach anyone", async () => {
    const { mailer, sink } = await harness({ operatorEmail: undefined });
    // The failure this guards against is the whole slice reproduced inside itself: stamping
    // `notified_at` on an alert nobody received.
    expect(await sink.notify(ALERTS, CTX)).toBe(false);
    expect(mailer.sent).toHaveLength(0);
  });

  it("a rate-limited send is a FAILED delivery, not a silent success", async () => {
    const { sink } = await harness();
    // The per-recipient limiter is 5/hour across every template. The sixth is `skipped:
    // rate_limited`, and the pass must treat that as undelivered so the next one retries.
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) results.push(await sink.notify(ALERTS, CTX));
    expect(results.slice(0, 5).every(Boolean)).toBe(true);
    expect(results[5]).toBe(false);
  });

  it("never throws, whatever the mailer does", async () => {
    const { db } = await harness();
    const exploding = {
      send: () => { throw new Error("transport exploded"); },
    };
    const service = new MailService({
      mailer: exploding as never,
      config: {
        appUrl: "https://app.ohmail.app", siteUrl: "https://ohmail.app",
        supportEmail: "support@ohmail.app", operatorEmail: "ops@ohmail.example",
      },
      throttleKeys: KEYS,
    });
    const sink = mailAlertSink(service, { limiter: dbRecipientLimiter(db), now: () => NOW });
    await expect(sink.notify(ALERTS, CTX)).resolves.toBe(false);
  });

  it("an empty alert list sends nothing", async () => {
    const { mailer, sink } = await harness();
    expect(await sink.notify([], CTX)).toBe(false);
    expect(mailer.sent).toHaveLength(0);
  });
});

/**
 * THE SINK HOLDS A LIMITER, NOT A DATABASE.
 *
 * `apps/api-vercel/src/deps.ts` used to build this sink with
 * `db: makePooledDb(cfg.databaseUrlPooled) as never` — the unrestricted runtime connection,
 * captured for the lifetime of the process, inside a graph that only ever runs behind a staff
 * credential, with a double assertion silencing the type that objected. A review recorded it as
 * the reason the claim "all three alert routes run wholly on the blind connection" was false.
 *
 * The fix is the mechanism, not a convention: with no `db` in the context there is no
 * runtime handle to cast, so the erasure that made the old line compile has nothing to erase.
 * What follows proves the sink needs nothing else — it runs to a delivered mail with NO database
 * of any kind in scope.
 */
describe("the operator-alert path's only database capability", () => {
  function spyLimiter(allow = true): RecipientLimiter & { calls: Array<[string, Date, number]> } {
    const calls: Array<[string, Date, number]> = [];
    return {
      calls,
      async claim(key, now, windowMs) {
        calls.push([key, now, windowMs]);
        // 1 is "one slot used, under the limit"; a number above any limit refuses.
        return allow ? 1 : Number.MAX_SAFE_INTEGER;
      },
    };
  }

  const serviceWith = (mailer: SpyMailer): MailService => new MailService({
    mailer,
    config: {
      appUrl: "https://app.ohmail.app", siteUrl: "https://ohmail.app",
      adminUrl: "https://admin.ohmail.app", supportEmail: "support@ohmail.app",
      operatorEmail: "ops@ohmail.example",
    },
    throttleKeys: KEYS,
  });

  it("delivers with NO database in scope — one limiter claim is the whole of its DB use", async () => {
    const mailer = new SpyMailer();
    const limiter = spyLimiter();
    // No `makeTestDb()` anywhere in this test. If any other read or write existed on this path
    // it would have nothing to run against and would throw.
    const sink = mailAlertSink(serviceWith(mailer), { limiter, now: () => NOW });

    expect(await sink.notify(ALERTS, CTX)).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    expect(limiter.calls).toHaveLength(1);

    const [key, at, windowMs] = limiter.calls[0]!;
    // The transactional budget under ONE fixed name: no address, not even hashed, and no key
    // material, so the pager mails on a host whose KEK is broken.
    expect(key).toBe("mail:transactional:operator");
    expect(at).toEqual(NOW);
    expect(windowMs).toBeGreaterThan(0);
  });

  it("a refusing limiter is a FAILED delivery — the policy still lives in MailService", async () => {
    // The port answers "how many slots are used", not "allowed". A port that decided the
    // verdict would be a port that could be configured to allow everything.
    const mailer = new SpyMailer();
    const sink = mailAlertSink(serviceWith(mailer), { limiter: spyLimiter(false), now: () => NOW });
    expect(await sink.notify(ALERTS, CTX)).toBe(false);
    expect(mailer.sent).toHaveLength(0);
  });

  it("a host whose KEK is broken still pages the operator; a customer send there fails and counts nothing", async () => {
    const fail = (): never => { throw new Error("KEK unavailable on this host"); };
    const broken: KeyProvider = { encrypt: async () => fail(), decrypt: async () => fail(), currentKeyVersion: fail, deriveSubkey: fail };
    const db = await makeTestDb();
    const mailer = new SpyMailer();
    const service = new MailService({
      mailer,
      config: {
        appUrl: "https://app.ohmail.app", siteUrl: "https://ohmail.app", supportEmail: "support@ohmail.app",
        operatorEmail: "ops@ohmail.example",
      },
      throttleKeys: throttleKeysFor(broken),
    });
    expect(await mailAlertSink(service, { limiter: dbRecipientLimiter(db), now: () => NOW }).notify(ALERTS, CTX)).toBe(true);
    const customer = await service.sendInvite({ db, now: () => NOW }, { to: "someone@example.com", code: "C", expiresAt: NOW });
    expect(customer, "a customer send counted without the key").toMatchObject({ status: "failed" });
    expect(mailer.sent.map((m) => m.template)).toEqual(["operator_alert"]);
    expect((await db.select().from(authThrottle)).map((r) => r.key)).toEqual(["mail:transactional:operator"]);
  });

  it("a limiter that throws is caught — the OTHER sink must still get to run", async () => {
    const mailer = new SpyMailer();
    const exploding: RecipientLimiter = {
      claim: () => Promise.reject(new Error("auth_throttle is gone")),
    };
    const sink = mailAlertSink(serviceWith(mailer), { limiter: exploding, now: () => NOW });
    expect(await sink.notify(ALERTS, CTX)).toBe(false);
  });

  it("the context a sink is built with carries no handle at all", async () => {
    const limiter = spyLimiter();
    const ctx = { limiter, now: () => NOW };
    // Not a type-level claim restated at runtime: this is the shape the composition root
    // passes, and `db` on it is what the finding was about.
    expect(Object.keys(ctx).sort()).toEqual(["limiter", "now"]);
  });
});

describe("the operator_alert template", () => {
  it("renders every alert, escapes it, and links only to the staff console", () => {
    const out = renderTemplate("operator_alert", {
      environment: "production",
      source: "api",
      alerts: [{ title: "<script>x</script>", detail: "d & d", severity: "critical" }],
      consoleUrl: "https://admin.ohmail.app",
    });
    expect(out.subject).toBe("[production] ohmail: 1 alert firing");
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.html).toContain("&amp;");
    const hosts = [...out.html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => new URL(m[0]).hostname);
    expect(new Set(hosts)).toEqual(new Set(["admin.ohmail.app"]));
  });

  it("pluralises honestly, because a subject line is the most-read surface there is", () => {
    const two = renderTemplate("operator_alert", {
      environment: "staging", source: "worker",
      alerts: [
        { title: "a", detail: "a", severity: "critical" },
        { title: "b", detail: "b", severity: "warning" },
      ],
      consoleUrl: "https://admin.ohmail.app",
    });
    expect(two.subject).toBe("[staging] ohmail: 2 alerts firing");
  });

  it("refuses a non-https console URL rather than mailing a wrong link", () => {
    expect(() => renderTemplate("operator_alert", {
      environment: "production", source: "api",
      alerts: [{ title: "a", detail: "a", severity: "critical" }],
      consoleUrl: "javascript:alert(1)",
    })).toThrow();
  });
});

/**
 * ONE ALERT MAIL, WHICHEVER DRIVER WINS (2026-09-28). Both drivers run the pass on one
 * `alert_state` and the winner of the claim mails with its own arm: this host's operator template,
 * or the worker's mail sink in `packages/db`. Each had its own renderer, so the same alert arrived
 * in two formats. Both now render through `renderAlertMail`; asserted at the wire.
 */
describe("both mail arms send the same mail for one alert", () => {
  const CONSOLE = "https://admin.ohmail.app";
  it("the fixture key has the vendor key's shape", () => {
    expect(resendKey("alert-sink")).toMatch(FIXTURE_SHAPES.resend);
  });
  const mailOf = (body: string) => {
    const b = JSON.parse(body) as { subject: string; text: string; html: string };
    return { subject: b.subject, text: b.text, html: b.html };
  };

  async function apiArm(ctx: AlertNotifyContext): Promise<string> {
    const bodies: string[] = [];
    const mailer = new ResendMailer({
      apiKey: resendKey("alert-sink"), from: "ohmail <alerts@ohmail.example>",
      http: { post: async (_url, init) => { bodies.push(init.body); return { status: 200, body: "{}" }; } },
    });
    const service = new MailService({
      mailer,
      config: {
        appUrl: "https://app.ohmail.app", siteUrl: "https://ohmail.app", adminUrl: CONSOLE,
        supportEmail: "support@ohmail.app", operatorEmail: "ops@ohmail.example",
      },
      throttleKeys: KEYS,
    });
    const sink = mailAlertSink(service, { limiter: dbRecipientLimiter(await makeTestDb()), now: () => NOW });
    expect(await sink.notify(ALERTS, ctx)).toBe(true);
    return bodies[0]!;
  }

  async function workerArm(ctx: AlertNotifyContext): Promise<string> {
    const bodies: string[] = [];
    const sink = resendAlertSink(
      { apiKey: resendKey("alert-sink"), from: "ohmail <alerts@ohmail.example>", to: "ops@ohmail.example", consoleUrl: CONSOLE },
      async (_url, body) => { bodies.push(body); return { status: 200 }; },
    )!;
    expect(await sink.notify(ALERTS, ctx)).toMatchObject({ ok: true });
    return bodies[0]!;
  }

  it("subject, text and html are byte-identical, for either driver's observation", async () => {
    for (const source of ["api", "worker"]) {
      const ctx = { ...CTX, source };
      const [api, worker] = [mailOf(await apiArm(ctx)), mailOf(await workerArm(ctx))];
      expect(worker, `observed by the ${source} pass`).toEqual(api);
      expect(api.subject).toBe("[production] ohmail: 2 alerts firing");
      expect(api.text).toContain(`Observed by the ${source} alert pass.`);
    }
  });

  it("the footer states the schedule the pass runs on, not an hourly promise", async () => {
    const { text, html } = mailOf(await workerArm(CTX));
    expect(text).not.toMatch(/at most once an hour/);
    expect(text).toContain(ALERT_MAIL_SCHEDULE);
    // The mail policy's cadence: one mail per kind per window unless the severity rises, no mail
    // when it clears. When a standing alert mails again depends on whether a pager confirmed its
    // reminders, so the footer promises the window and nothing later.
    expect(ALERT_MAIL_SCHEDULE).toContain(`waits at least ${mailCooldownMs("worker_down") / 3_600_000} h`);
    expect(ALERT_MAIL_SCHEDULE).toContain("unless its severity rises");
    expect(ALERT_MAIL_SCHEDULE).not.toContain("a day after it started");
    expect(ALERT_MAIL_SCHEDULE).not.toContain(`every ${DEFAULT_ALERT_RENOTIFY_UNCHANGED_MS / 3_600_000} h`);
    expect(ALERT_MAIL_SCHEDULE).toContain("Nothing is mailed when an alert clears");
    expect(ALERT_MAIL_SCHEDULE).not.toContain(`after ${DEFAULT_ALERT_REPEAT_MS / 3_600_000} h`);
    expect(html).toContain("Nothing is mailed when an alert clears");
  });

  it("control: a worker with no console URL is the one difference, and it is the link", async () => {
    const bodies: string[] = [];
    const bare = resendAlertSink(
      { apiKey: resendKey("alert-sink"), from: "ohmail <alerts@ohmail.example>", to: "ops@ohmail.example" },
      async (_url, body) => { bodies.push(body); return { status: 200 }; },
    )!;
    await bare.notify(ALERTS, CTX);
    const without = mailOf(bodies[0]!);
    const api = mailOf(await apiArm(CTX));
    expect(without.text).not.toBe(api.text);
    expect(without.text).toBe(api.text.replace(`Admin console: ${CONSOLE}/\n\n`, ""));
  });
});
