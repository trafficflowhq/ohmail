import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { asc, eq, like, or } from "drizzle-orm";
import { createApp, apiRoutes, apiAlertSinkSummary, type ApiDeps } from "@trafficflow/api";
import {
  alertDrills, alertPassRuns, alertState, drillKinds, DRILL_ACK_PATH, DRILL_ACK_TTL_MS, DRILL_MIN_INTERVAL_MS,
  type Alert, type AlertSink,
} from "@trafficflow/db/cloud";
import { MailService, SpyMailer, mailAlertSink, type RecipientLimiter } from "@trafficflow/services";
import { makeDeps, req } from "./helpers.js";

/**
 * THE DRILL ROUTES (cloud 0051) on PGlite: the surface, one message per sink and run, the hourly
 * throttle, the ack page that writes nothing and the press that writes once, the API mail arm's one
 * limiter slot, and risk 3 through the real API driver: a drill never consumes a real page.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null });

const SECRET = "s".repeat(32);
const CRON = "c".repeat(32);
const ACK_BASE = "https://ohmail.example/api";
const DRILL = "/internal/alerts/drill";
// After the wall clock, so nothing a database default stamps is newer than a pass.
const START = new Date("2026-12-01T12:00:00.000Z");
const MIN = 60_000;
const hashOf = (t: string): string => createHash("sha256").update(t).digest("base64url");

type Harness = Awaited<ReturnType<typeof makeDeps>>;

/** A sink that records each message it is handed. */
function recorder(name: string, channel?: "mail") {
  const messages: Alert[][] = [];
  let refusing = false;
  const sink: AlertSink = {
    name, ...(channel ? { channel } : {}),
    async notify(alerts) {
      messages.push([...alerts]);
      return refusing ? { ok: false, outcome: "refused" as const, error: "HTTP 503" } : true;
    },
    async notifyDigest() { return true; },
  };
  return { sink, messages, refuse(on: boolean) { refusing = on; } };
}

/** The token a message's one ack link carries. */
function tokenIn(message: readonly Alert[]): string {
  const m = /\/internal\/alerts\/drill\/ack\?t=([A-Za-z0-9_-]{43})/.exec(message[0]!.detail);
  if (!m) throw new Error("no ack link in the message");
  return m[1]!;
}

function armed(h: Harness, sinks: AlertSink[], over: Record<string, unknown> = {}): ApiDeps {
  return {
    ...h.deps,
    alerts: { secret: SECRET, cronSecret: CRON, sinks, environment: "production", drillAckBase: ACK_BASE, ...over },
  } as ApiDeps;
}

const start = (d: ApiDeps, body?: unknown, bearer = SECRET) =>
  H(req("POST", DRILL, { bearer, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), d);
const ackPath = (t: string): string => `${DRILL_ACK_PATH}?t=${t}`;

async function drillRows(h: Harness) {
  return h.db.select().from(alertDrills).orderBy(asc(alertDrills.driver), asc(alertDrills.sink), asc(alertDrills.kind));
}

describe("POST /internal/alerts/drill — the surface", () => {
  it("404 where alerts are not configured, on all four routes", async () => {
    const h = await makeDeps(START);
    for (const [method, path] of [["POST", DRILL], ["GET", DRILL], ["GET", ackPath("A".repeat(43))], ["POST", ackPath("A".repeat(43))]] as const) {
      expect((await H(req(method, path, { bearer: SECRET }), h.deps)).status, `${method} ${path}`).toBe(404);
    }
  });

  it("mounts the ack page and its press at the path every link is built on", () => {
    const at = apiRoutes.filter((r) => r.pattern === DRILL_ACK_PATH).map((r) => r.method).sort();
    expect(at).toEqual(["GET", "POST"]);
  });

  it("503 where alerts are configured and have no database", async () => {
    const h = await makeDeps(START);
    const d = { ...armed(h, []), adminDb: undefined } as ApiDeps;
    const res = await start(d);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("alerts_db_unarmed");
  });

  it("401 without the alert secret, and the platform scheduler's secret starts nothing", async () => {
    const h = await makeDeps(START);
    const d = armed(h, [recorder("mail", "mail").sink]);
    expect((await start(d, undefined, "wrong")).status).toBe(401);
    expect((await start(d, undefined, CRON)).status, "the cron secret is not a drill credential").toBe(401);
    expect((await H(req("POST", DRILL), d)).status).toBe(401);
    expect((await H(req("GET", DRILL, { bearer: CRON }), d)).status).toBe(401);
    expect(await drillRows(h)).toEqual([]);
  });

  it("503 drill_ack_unarmed when the host composed no usable ack base", async () => {
    const h = await makeDeps(START);
    for (const drillAckBase of [undefined, "http://ohmail.example/api", "https://ohmail.example/api?x=1"]) {
      const res = await start(armed(h, [recorder("mail", "mail").sink], { drillAckBase }));
      expect(res.status, String(drillAckBase)).toBe(503);
      expect((await res.json()).error.code).toBe("drill_ack_unarmed");
    }
    expect(await drillRows(h)).toEqual([]);
  });

  it("400 for a body that is not a drill request, and nothing is written", async () => {
    const h = await makeDeps(START);
    const d = armed(h, [recorder("mail", "mail").sink]);
    const bad: unknown[] = [
      [], "x", 7, null, { kind: ["worker_down"] }, { kinds: [] }, { kinds: ["no_such_kind"] }, { kinds: "worker_down" },
      { drivers: [] }, { drivers: ["console"] }, { kinds: [7] },
    ];
    for (const body of bad) {
      const res = await start(d, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_drill");
    }
    const malformed = await H(req("POST", DRILL, { bearer: SECRET, body: "{" }), d);
    expect(malformed.status).toBe(400);
    expect(await drillRows(h)).toEqual([]);
  });

  it("a form-encoded POST is refused by the pipeline before any handler: why the ack page sends JSON", async () => {
    const h = await makeDeps(START);
    const res = await H(req("POST", ackPath("A".repeat(43)), {
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: "",
    }), armed(h, []));
    expect(res.status).toBe(415);
  });
});

describe("a drill run through the API driver", () => {
  it("one message per sink, the worker's rows queued, and an answer with no token and no hash", async () => {
    const h = await makeDeps(START);
    const mail = recorder("mail", "mail");
    const push = recorder("telegram");
    push.refuse(true);
    const d = armed(h, [mail.sink, push.sink]);
    const summaryBefore = JSON.stringify(apiAlertSinkSummary([mail.sink, push.sink]));
    const res = await start(d);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    const n = drillKinds().length;
    expect(body).toMatchObject({
      kinds: n, drivers: ["api", "worker"], worker: { queued: n },
      api: {
        unarmed: false, delivered: ["mail"], failedSinks: ["telegram"],
        outcomes: [{ sink: "mail", outcome: "ok" }, { sink: "telegram", outcome: "refused" }],
      },
    });
    expect(mail.messages).toHaveLength(1);
    expect(push.messages).toHaveLength(1);
    expect(mail.messages[0]!.map((a) => a.kind)).toEqual(drillKinds());
    const tokens = [tokenIn(mail.messages[0]!), tokenIn(push.messages[0]!)];
    expect(tokens[0]).not.toBe(tokens[1]);
    for (const t of tokens) {
      expect(text).not.toContain(t);
      expect(text).not.toContain(hashOf(t));
    }
    const rows = await drillRows(h);
    expect(rows.filter((r) => r.driver === "worker").every((r) => r.sink === "*" && r.firedAt === null)).toBe(true);
    expect(rows.filter((r) => r.driver === "api" && r.sink === "mail").every((r) => r.outcome === "ok")).toBe(true);
    // The pager's standing health on /health is this host's real passes', not the drill's.
    expect(JSON.stringify(apiAlertSinkSummary([mail.sink, push.sink]))).toBe(summaryBefore);

    const list = await H(req("GET", DRILL, { bearer: SECRET }), d);
    expect(list.status).toBe(200);
    const listed = await list.text();
    expect(JSON.parse(listed).runs).toHaveLength(1);
    for (const t of tokens) {
      expect(listed).not.toContain(t);
      expect(listed).not.toContain(hashOf(t));
    }
  });

  it("asks only for what it was given: one kind, the API driver only", async () => {
    const h = await makeDeps(START);
    const mail = recorder("mail", "mail");
    const res = await start(armed(h, [mail.sink]), { kinds: ["sends_stuck", "sends_stuck"], drivers: ["api"] });
    expect(res.status).toBe(200);
    expect((await res.json()).worker).toBeNull();
    expect(mail.messages[0]!.map((a) => a.kind)).toEqual(["sends_stuck"]);
    expect((await drillRows(h)).map((r) => `${r.driver}/${r.sink}/${r.kind}`)).toEqual(["api/mail/sends_stuck"]);
  });

  it("with no usable sink the API driver answers unarmed, and its rows say so", async () => {
    const h = await makeDeps(START);
    const res = await start(armed(h, [{ name: "webhook", unusable: true, notify: async () => false }]), { drivers: ["api"] });
    expect(res.status).toBe(200);
    expect((await res.json()).api).toMatchObject({ unarmed: true, outcomes: [] });
    expect((await drillRows(h)).every((r) => r.sink === "*" && r.outcome === "unarmed")).toBe(true);
  });

  it("a second run within the hour is 429 with when, and writes nothing", async () => {
    const h = await makeDeps(START);
    const d = armed(h, [recorder("mail", "mail").sink]);
    expect((await start(d)).status).toBe(200);
    const count = (await drillRows(h)).length;
    h.clock.advance(DRILL_MIN_INTERVAL_MS - MIN);
    const soon = await start(d);
    expect(soon.status).toBe(429);
    expect(soon.headers.get("retry-after")).toBe("60");
    expect((await soon.json()).retryAt).toBe(new Date(START.getTime() + DRILL_MIN_INTERVAL_MS).toISOString());
    expect((await drillRows(h)).length).toBe(count);
    h.clock.advance(MIN);
    expect((await start(d)).status).toBe(200);
  });
});

describe("the API mail arm", () => {
  function mailArm() {
    const mailer = new SpyMailer();
    let claims = 0;
    const limiter: RecipientLimiter = { async claim() { claims += 1; return claims; } };
    const service = new MailService({
      mailer,
      config: {
        appUrl: "https://app.ohmail.app", siteUrl: "https://ohmail.app", adminUrl: "https://admin.ohmail.app",
        supportEmail: "support@ohmail.app", operatorEmail: "operator@ohmail.example",
      },
    });
    return { mailer, claims: () => claims, sink: mailAlertSink(service, { limiter, now: () => START }) };
  }

  it("spends one limiter slot per run, for one mail whose subject says DRILL", async () => {
    const h = await makeDeps(START);
    const arm = mailArm();
    expect((await start(armed(h, [arm.sink]))).status).toBe(200);
    expect(arm.claims()).toBe(1);
    const sent = arm.mailer.only("operator_alert");
    expect(sent.rendered.subject).toBe(`[DRILL production] ohmail: ${drillKinds().length} alerts firing`);
  });

  it("two single-kind schema_behind runs an hour apart get two idempotency keys", async () => {
    const h = await makeDeps(START);
    const arm = mailArm();
    const d = armed(h, [arm.sink]);
    expect((await start(d, { kinds: ["schema_behind"], drivers: ["api"] })).status).toBe(200);
    h.clock.advance(DRILL_MIN_INTERVAL_MS);
    expect((await start(d, { kinds: ["schema_behind"], drivers: ["api"] })).status).toBe(200);
    const keys = arm.mailer.ofTemplate("operator_alert").map((s) => s.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1], "the provider would replay the first answer and send nothing").not.toBe(keys[0]);
  });
});

describe("the acknowledgement", () => {
  async function delivered() {
    const h = await makeDeps(START);
    const mail = recorder("mail", "mail");
    const push = recorder("telegram");
    const d = armed(h, [mail.sink, push.sink]);
    expect((await start(d, { drivers: ["api"] })).status).toBe(200);
    return { h, d, token: tokenIn(mail.messages[0]!), other: tokenIn(push.messages[0]!) };
  }
  const acked = async (h: Harness, sink: string) =>
    (await drillRows(h)).filter((r) => r.sink === sink).map((r) => r.ackedAt !== null);

  it("the page writes nothing, however often it is opened, and echoes nothing from the URL", async () => {
    const { h, d, token } = await delivered();
    for (let i = 0; i < 3; i++) {
      const res = await H(req("GET", `${ackPath(token)}&x=%3Cb%3Emarker-in-the-url%3C%2Fb%3E`), d);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="ack"');
      expect(html).not.toContain(token);
      expect(html).not.toContain("marker-in-the-url");
    }
    expect((await acked(h, "mail")).every((a) => !a)).toBe(true);
  });

  it("the page is served with a strict policy whose one script hash is the page's own script", async () => {
    const { d, token } = await delivered();
    const res = await H(req("GET", ackPath(token)), d);
    const csp = res.headers.get("content-security-policy") ?? "";
    for (const part of ["default-src 'none'", "form-action 'none'", "frame-ancestors 'none'", "base-uri 'none'", "connect-src 'self'"]) {
      expect(csp).toContain(part);
    }
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const html = await res.text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts).toHaveLength(1);
    const hash = createHash("sha256").update(scripts[0]!, "utf8").digest("base64");
    expect(csp).toContain(`script-src 'sha256-${hash}'`);
    // The press is a JSON POST back to this very URL, or the pipeline refuses it.
    expect(scripts[0]).toContain('method: "POST"');
    expect(scripts[0]).toContain('"content-type": "application/json"');
    expect(scripts[0]).toContain("location.href");
  });

  it("the press stamps every row of its message once; a second press is 409 and a tampered token 404", async () => {
    const { h, d, token, other } = await delivered();
    const res = await H(req("POST", ackPath(token), { body: "{}" }), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ acknowledged: true, kinds: drillKinds().length });
    expect((await acked(h, "mail")).every((a) => a)).toBe(true);
    expect((await acked(h, "telegram")).every((a) => !a), "the other sink's message is its own").toBe(true);
    expect((await H(req("POST", ackPath(token), { body: "{}" }), d)).status).toBe(409);
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect((await H(req("POST", ackPath(tampered), { body: "{}" }), d)).status).toBe(404);
    const page = await H(req("GET", ackPath(token)), d);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("was acknowledged at");
    expect(html).not.toContain('id="ack"');
    expect((await acked(h, "telegram")).every((a) => !a)).toBe(true);
    expect(other).not.toBe(token);
  });

  it("past 24 h, and for any token it does not know, one fixed 404 page and nothing stamped", async () => {
    const { h, d, token } = await delivered();
    const unknown = await (await H(req("GET", ackPath("Q".repeat(43))), d)).text();
    const malformed = await H(req("GET", ackPath("short")), d);
    expect(malformed.status).toBe(404);
    expect(await malformed.text()).toBe(unknown);
    expect((await H(req("GET", DRILL_ACK_PATH), d)).status).toBe(404);
    h.clock.advance(DRILL_ACK_TTL_MS + 1);
    const expired = await H(req("GET", ackPath(token)), d);
    expect(expired.status).toBe(404);
    expect(await expired.text()).toBe(unknown);
    expect((await H(req("POST", ackPath(token), { body: "{}" }), d)).status).toBe(404);
    expect((await acked(h, "mail")).every((a) => !a)).toBe(true);
  });
});

describe("RISK 3 through the API driver — a drill never consumes a real page", () => {
  const SHARD = 72;
  const REAL = `worker_down:${SHARD}`;

  async function memory(h: Harness): Promise<string> {
    const states = await h.db.select().from(alertState).orderBy(asc(alertState.alertKey));
    const runs = await h.db.select().from(alertPassRuns).orderBy(asc(alertPassRuns.driver));
    return JSON.stringify({ states, runs });
  }

  it("a refused real page stands unpaged, a drill mails, and the next real pass pages at once", async () => {
    const h = await makeDeps(START);
    await h.db.delete(alertState).where(or(eq(alertState.alertKey, REAL), like(alertState.alertKey, "mail:%")));
    const mail = recorder("mail", "mail");
    const d = armed(h, [mail.sink], { shards: [SHARD] });
    const realPass = () => H(req("POST", "/internal/alerts", { bearer: SECRET }), d);

    mail.refuse(true);
    expect((await realPass()).status).toBe(200);
    expect(mail.messages.some((m) => m.some((a) => a.key === REAL)), "the real page was tried").toBe(true);
    const [row] = await h.db.select().from(alertState).where(eq(alertState.alertKey, REAL));
    expect(row?.notifiedAt ?? null, "and refused").toBeNull();

    const before = await memory(h);
    mail.refuse(false);
    h.clock.advance(MIN);
    const drilled = await start(d, { drivers: ["api"] });
    expect(drilled.status).toBe(200);
    expect(mail.messages.at(-1)!.every((a) => a.key.startsWith("drill:"))).toBe(true);
    expect(await memory(h), "alert_state and alert_pass_runs are untouched by the drill").toBe(before);

    h.clock.advance(MIN);
    const next = await realPass();
    expect((await next.json()).notified).toContain(REAL);
    expect(mail.messages.at(-1)!.some((a) => a.key === REAL)).toBe(true);
  });
});
