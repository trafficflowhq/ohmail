import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { and, asc, eq, sql as dsql } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import {
  alertDrills, drillKinds, drillAlerts, drillEnvironment, drillAckUrl, startDrillRun, deliverDrill,
  recordDrillOutcomes, takeQueuedDrill, drillAckState, ackDrill, listDrillRuns, usableAckBase,
  isDrillToken, DRILL_ACK_TTL_MS, DRILL_MIN_INTERVAL_MS, DRILL_REQUEST_TTL_MS, DRILL_OUTCOMES,
  resendAlertSink, telegramAlertSink, webhookAlertSink, TELEGRAM_TEXT_LIMIT,
  type Alert, type AlertSink, type PostJson,
} from "../src/cloud.js";
import { resendKey } from "../../../test/support/fixture-credentials.js";
import {
  ACK_BASE, MIN, POLICY_KEY, REAL_KEY, cleanup, pagedThenDrill, unpagedThenDrill,
} from "./_alert-drill-scenario.js";
/* @reads: packages/db/src/alert-drill.ts packages/db/src/alert-types.ts */

/**
 * ALERT DRILLS (cloud 0051) on PGlite: the message every sink is handed, the rows a run writes, the
 * worker's queue, the ack and its window, and RISK 3 — a drill never consumes a real page. The
 * concurrency halves (two workers claiming at once, two runs started at once) are in
 * `alert-drill.pg.test.ts`: PGlite has one session.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;

// After the wall clock, so nothing a default stamps is newer than a pass.
const NOW = new Date("2026-12-01T12:00:00.000Z");
const HOUR = 60 * MIN;
const at = (ms: number): Date => new Date(NOW.getTime() + ms);
const RUN = "3f6c2a9e-1b7d-4c55-9a0e-6d2b8f41c7aa";
const hashOf = (token: string): string => createHash("sha256").update(token).digest("base64url");

/** The `AlertKind` union, read out of the source as `alert-kind-arms.test.ts` reads it. */
const KINDS_FROM_SOURCE = [...readFileSync(new URL("../src/alert-types.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
  .match(/export type AlertKind =([\s\S]*?);/)![1]!.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!).sort();

/** A sink that records each message it is handed, and answers what it is told to. */
function spy(name: string, answer: () => boolean | { ok: false; outcome: "refused"; error: string } = () => true) {
  const messages: Alert[][] = [];
  const sink: AlertSink = {
    name,
    async notify(alerts) { messages.push([...alerts]); return answer(); },
  };
  return { sink, messages };
}

async function rows(db: Db) {
  return db.select().from(alertDrills).orderBy(asc(alertDrills.driver), asc(alertDrills.sink), asc(alertDrills.kind));
}

async function started(db: Db, over: Partial<Parameters<typeof startDrillRun>[1]> = {}) {
  const run = await startDrillRun(db, {
    kinds: drillKinds(), drivers: ["api", "worker"], apiSinkNames: ["mail", "telegram"], ackBase: ACK_BASE, now: NOW,
    ...over,
  });
  if (run.state !== "started") throw new Error(`expected a started run, got ${run.state}`);
  return run;
}

describe("the drill message", () => {
  it("covers every alert kind there is, read from the union and never a count", () => {
    expect(drillKinds()).toEqual(KINDS_FROM_SOURCE);
    expect(KINDS_FROM_SOURCE.length, "the union is read").toBeGreaterThan(10);
  });

  it("is one alert per kind: a [DRILL] title with the run, a warning, an incident, no console link", () => {
    const url = drillAckUrl(ACK_BASE, "t".repeat(43));
    const alerts = drillAlerts(RUN, drillKinds(), url);
    expect(alerts.map((a) => a.kind)).toEqual(drillKinds());
    expect(new Set(alerts.map((a) => a.key)).size).toBe(alerts.length);
    for (const a of alerts) {
      expect(a.key).toBe(`drill:${RUN}:${a.kind}`);
      expect(a.title).toBe(`[DRILL] ${a.kind} (run ${RUN.slice(0, 8)})`);
      expect(a.severity, "a paging webhook never escalates a drill").toBe("warning");
      expect(a.cls).toBe("incident");
      expect(a.fixHref ?? null).toBeNull();
    }
    // ONE link per message, in the first alert's detail.
    expect(alerts.filter((a) => a.detail.includes(url)).map((a) => a.kind)).toEqual([alerts[0]!.kind]);
    expect(url).toBe(`${ACK_BASE}/internal/alerts/drill/ack?t=${"t".repeat(43)}`);
    // No ack base: no link at all.
    expect(drillAlerts(RUN, drillKinds(), null).some((a) => a.detail.includes("http"))).toBe(false);
  });

  it("names its environment DRILL, the first word of every sink's header", () => {
    expect(drillEnvironment("production")).toBe("DRILL production");
  });

  it("an ack base is https (or http on loopback), at most 200 characters, with no credentials, query or fragment", () => {
    expect(usableAckBase("https://ohmail.app/api")).toBe("https://ohmail.app/api");
    expect(usableAckBase("http://localhost:8080/api")).toBe("http://localhost:8080/api");
    expect(usableAckBase("http://127.0.0.1/api")).toBe("http://127.0.0.1/api");
    for (const bad of [
      "http://ohmail.example/api", "ftp://ohmail.example/api", `https://${["u", "p"].join(":")}@ohmail.example/api`,
      "https://ohmail.example/api?x=1", "https://ohmail.example/api#f", "not a url", "",
      `https://ohmail.example/${"a".repeat(200)}`,
    ]) {
      expect(usableAckBase(bad), bad).toBeNull();
    }
    expect(usableAckBase(null)).toBeNull();
  });

  it("a token is 43 base64url characters and nothing else", () => {
    expect(isDrillToken("A".repeat(43))).toBe(true);
    for (const bad of ["A".repeat(42), "A".repeat(44), `${"A".repeat(42)}=`, `${"A".repeat(42)}/`, "", null, 7]) {
      expect(isDrillToken(bad), String(bad)).toBe(false);
    }
  });
});

describe("a run's rows", () => {
  it("queues the worker's kinds, writes one row per kind and API sink, and stores no token", async () => {
    const db = await makeTestDb();
    const run = await started(db);
    const all = await rows(db);
    const kinds = drillKinds();

    const worker = all.filter((r) => r.driver === "worker");
    expect(worker.map((r) => r.kind)).toEqual(kinds);
    for (const r of worker) {
      expect(r).toMatchObject({ sink: "*", firedAt: null, outcome: null, ackTokenHash: null, ackBase: ACK_BASE });
    }

    const api = all.filter((r) => r.driver === "api");
    expect(api).toHaveLength(kinds.length * 2);
    expect([...run.tokens.keys()].sort()).toEqual(["mail", "telegram"]);
    for (const [sink, token] of run.tokens) {
      expect(isDrillToken(token)).toBe(true);
      const own = api.filter((r) => r.sink === sink);
      expect(own.map((r) => r.kind)).toEqual(kinds);
      expect(new Set(own.map((r) => r.ackTokenHash)), "one token per message").toEqual(new Set([hashOf(token)]));
      for (const r of own) {
        expect(new Date(r.firedAt as unknown as string).toISOString()).toBe(NOW.toISOString());
        expect(r.outcome).toBeNull();
      }
    }
    expect(run.tokens.get("mail")).not.toBe(run.tokens.get("telegram"));
    // No column of any row holds a plaintext token.
    const text = JSON.stringify(all);
    for (const token of run.tokens.values()) expect(text).not.toContain(token);
  });

  it("an API driver with no usable sink says so: its rows are unarmed, with no token", async () => {
    const db = await makeTestDb();
    const run = await started(db, { drivers: ["api"], apiSinkNames: [] });
    expect(run.tokens.size).toBe(0);
    const all = await rows(db);
    expect(all).toHaveLength(drillKinds().length);
    for (const r of all) expect(r).toMatchObject({ driver: "api", sink: "*", outcome: "unarmed", ackTokenHash: null });
  });

  it("refuses a second run within the hour and writes nothing; an hour later one starts", async () => {
    const db = await makeTestDb();
    await started(db);
    const count = (await rows(db)).length;
    const soon = await startDrillRun(db, {
      kinds: ["worker_down"], drivers: ["api"], apiSinkNames: ["mail"], ackBase: ACK_BASE,
      now: at(DRILL_MIN_INTERVAL_MS - 1),
    });
    expect(soon).toEqual({ state: "too_soon", retryAt: at(DRILL_MIN_INTERVAL_MS) });
    expect((await rows(db)).length).toBe(count);
    const later = await startDrillRun(db, {
      kinds: ["worker_down"], drivers: ["api"], apiSinkNames: ["mail"], ackBase: ACK_BASE,
      now: at(DRILL_MIN_INTERVAL_MS),
    });
    expect(later.state).toBe("started");
    expect((await rows(db)).length).toBe(count + 1);
  });

  it("the table holds exactly its ten columns and no foreign key: no account_id, no join to one", async () => {
    const db = await makeTestDb();
    const cols = await db.execute(dsql`select column_name as c from information_schema.columns
      where table_schema = 'public' and table_name = 'alert_drills' order by column_name`);
    expect((cols.rows as Array<{ c: string }>).map((r) => r.c)).toEqual([
      "ack_base", "ack_token_hash", "acked_at", "driver", "fired_at", "kind", "outcome", "requested_at", "run_id", "sink",
    ]);
    const fks = await db.execute(dsql`select count(*)::int as n from pg_constraint
      where conrelid = 'public.alert_drills'::regclass and contype = 'f'`);
    expect((fks.rows[0] as { n: number }).n).toBe(0);
  });

  it("the outcome codes are the CHECK's, and an unknown one is refused", async () => {
    const db = await makeTestDb();
    expect([...DRILL_OUTCOMES].sort()).toEqual(
      ["dispatched", "expired", "misconfigured", "ok", "refused", "threw", "timeout", "unarmed", "unreachable"]);
    await started(db, { drivers: ["api"], apiSinkNames: ["mail"] });
    const refused = await db.update(alertDrills).set({ outcome: "delivered" }).then(() => "accepted", (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code);
    expect(refused).toBe("23514");
  });
});

describe("delivery", () => {
  it("hands each sink one message carrying its own token, and records closed outcome codes only", async () => {
    const db = await makeTestDb();
    const run = await started(db, { drivers: ["api"] });
    const mail = spy("mail");
    const push = spy("telegram", () => ({ ok: false, outcome: "refused", error: "HTTP 500 — the vendor's own sentence" }));
    const report = await deliverDrill([mail.sink, push.sink], {
      runId: run.runId, kinds: drillKinds(), tokens: run.tokens, ackBase: ACK_BASE, source: "api",
      environment: "production", now: NOW,
    });
    expect(mail.messages).toHaveLength(1);
    expect(push.messages).toHaveLength(1);
    expect(mail.messages[0]![0]!.detail).toContain(drillAckUrl(ACK_BASE, run.tokens.get("mail")!));
    expect(push.messages[0]![0]!.detail).toContain(drillAckUrl(ACK_BASE, run.tokens.get("telegram")!));
    expect(report.delivered).toEqual(["mail"]);
    expect(report.failed).toEqual(["telegram"]);

    await recordDrillOutcomes(db, run.runId, "api", report.outcomes);
    const all = await rows(db);
    expect(new Set(all.filter((r) => r.sink === "mail").map((r) => r.outcome))).toEqual(new Set(["ok"]));
    expect(new Set(all.filter((r) => r.sink === "telegram").map((r) => r.outcome))).toEqual(new Set(["refused"]));
    expect(JSON.stringify(all)).not.toContain("vendor");
  });

  it("the mail subject, the Telegram header and the webhook title all say DRILL, and a run fits one Telegram message", async () => {
    const bodies = { mail: [] as string[], telegram: [] as string[], webhook: [] as string[] };
    const posting = (into: string[]): PostJson => async (_url, body) => { into.push(body); return { status: 200 }; };
    const mail = resendAlertSink({ apiKey: resendKey("drill-sinks"), from: "ohmail <alerts@ohmail.example>", to: "operator@ohmail.example" }, posting(bodies.mail))!;
    const botToken = [String(8_123_456_789), "drill-fixture-token-drill-fixture-token"].join(":");
    const telegram = telegramAlertSink({ botToken, chatId: "-1001234567890" }, posting(bodies.telegram))!;
    const webhook = webhookAlertSink("https://hooks.ohmail.example/drill", posting(bodies.webhook))!;
    const token = "T".repeat(43);
    await deliverDrill([mail, telegram, webhook], {
      runId: RUN, kinds: drillKinds(), tokens: new Map([["mail", token], ["telegram", token], ["webhook", token]]),
      ackBase: ACK_BASE, source: "api", environment: "production", now: NOW,
    });
    const n = drillKinds().length;
    const sent = JSON.parse(bodies.mail[0]!) as { subject: string; text: string };
    expect(sent.subject).toBe(`[DRILL production] ohmail: ${n} alerts firing`);
    const push = JSON.parse(bodies.telegram[0]!) as { text: string };
    expect(push.text.startsWith("ohmail DRILL production\n")).toBe(true);
    expect(push.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(push.text, "the whole run, not a truncation").not.toContain("(truncated)");
    expect(push.text).toContain(drillAckUrl(ACK_BASE, token));
    const hook = JSON.parse(bodies.webhook[0]!) as { title: string; alerts: Array<{ title: string; severity: string }> };
    expect(hook.title).toBe(`ohmail DRILL production: ${n} alert(s)`);
    expect(hook.alerts.every((a) => a.title.startsWith("[DRILL] ") && a.severity === "warning")).toBe(true);

    // POSITIVE CONTROL: a link on every kind does not fit one message — why one link per message.
    const perKind = drillAlerts(RUN, drillKinds(), null)
      .map((a) => ({ ...a, detail: `${a.detail} ${drillAckUrl(ACK_BASE, token)}` }));
    const control: string[] = [];
    await telegramAlertSink({ botToken, chatId: "-1001234567890" }, posting(control))!
      .notify(perKind, { source: "api", environment: drillEnvironment("production"), now: NOW });
    expect((JSON.parse(control[0]!) as { text: string }).text).toContain("(truncated)");
  });

  it("two single-kind schema_behind runs get two keys at the worker's mail arm", async () => {
    const keys: string[] = [];
    const post: PostJson = async (_url, _body, headers) => { keys.push(headers?.["Idempotency-Key"] ?? ""); return { status: 200 }; };
    const mail = resendAlertSink({ apiKey: resendKey("drill-keys"), from: "ohmail <alerts@ohmail.example>", to: "operator@ohmail.example" }, post)!;
    const one = (runId: string) => deliverDrill([mail], {
      runId, kinds: ["schema_behind"], tokens: new Map(), ackBase: null, source: "worker", environment: "production", now: NOW,
    });
    await one(RUN);
    await one(RUN);
    await one("9d1b7e44-2c6f-4a3e-8b5d-0f7e6c5b4a39");
    expect(keys[0], "a retry of one run replays its key").toBe(keys[1]);
    expect(keys[2], "another run is another mail").not.toBe(keys[0]);
  });
});

describe("the acknowledgement", () => {
  it("the first ack stamps every row of its message; a second and a tampered token stamp none", async () => {
    const db = await makeTestDb();
    const run = await started(db, { drivers: ["api"] });
    const token = run.tokens.get("mail")!;
    expect(await ackDrill(db, token, at(MIN))).toBe(drillKinds().length);
    const mail = (await rows(db)).filter((r) => r.sink === "mail");
    expect(mail.every((r) => new Date(r.ackedAt as unknown as string).getTime() === at(MIN).getTime())).toBe(true);
    expect((await rows(db)).filter((r) => r.sink === "telegram").every((r) => r.ackedAt === null)).toBe(true);
    expect(await ackDrill(db, token, at(2 * MIN)), "single use").toBe(0);
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(await ackDrill(db, tampered, at(2 * MIN))).toBe(0);
    expect((await rows(db)).filter((r) => r.sink === "telegram").every((r) => r.ackedAt === null)).toBe(true);
  });

  it("is accepted 1 ms before 24 h from the message and refused at 24 h and after", async () => {
    const db = await makeTestDb();
    const run = await started(db, { drivers: ["api"], apiSinkNames: ["mail", "telegram", "webhook"] });
    expect(await ackDrill(db, run.tokens.get("mail")!, at(DRILL_ACK_TTL_MS - 1))).toBe(drillKinds().length);
    expect(await ackDrill(db, run.tokens.get("telegram")!, at(DRILL_ACK_TTL_MS))).toBe(0);
    expect(await ackDrill(db, run.tokens.get("webhook")!, at(DRILL_ACK_TTL_MS + 1))).toBe(0);
    expect((await drillAckState(db, run.tokens.get("webhook")!, at(DRILL_ACK_TTL_MS + 1))).state).toBe("expired");
  });

  it("reading a token's state writes nothing, however often", async () => {
    const db = await makeTestDb();
    const run = await started(db, { drivers: ["api"] });
    const token = run.tokens.get("mail")!;
    for (let i = 0; i < 3; i++) {
      expect(await drillAckState(db, token, at(MIN))).toEqual({
        state: "open", runId: run.runId, driver: "api", sink: "mail", kinds: drillKinds().length,
        firedAt: NOW, ackedAt: null,
      });
    }
    expect((await rows(db)).every((r) => r.ackedAt === null)).toBe(true);
    await ackDrill(db, token, at(2 * MIN));
    expect(await drillAckState(db, token, at(3 * MIN))).toMatchObject({ state: "acked", ackedAt: at(2 * MIN) });
    expect(await drillAckState(db, "Z".repeat(43), at(3 * MIN))).toEqual({ state: "unknown" });
  });
});

describe("the worker's queue", () => {
  it("is taken once: the pass claims the run and writes its own rows, and the next pass finds nothing", async () => {
    const db = await makeTestDb();
    const run = await started(db, { drivers: ["worker"] });
    const taken = await takeQueuedDrill(db, { sinkNames: ["mail", "webhook"], now: at(MIN) });
    expect(taken.state).toBe("claimed");
    if (taken.state !== "claimed") return;
    expect(taken.runId).toBe(run.runId);
    expect(taken.kinds).toEqual(drillKinds());
    expect(taken.ackBase).toBe(ACK_BASE);
    expect([...taken.tokens.keys()].sort()).toEqual(["mail", "webhook"]);
    const all = await rows(db);
    for (const r of all.filter((x) => x.sink === "*")) {
      expect(r.outcome).toBe("dispatched");
      expect(new Date(r.firedAt as unknown as string).getTime()).toBe(at(MIN).getTime());
    }
    for (const [sink, token] of taken.tokens) {
      const own = all.filter((r) => r.sink === sink);
      expect(own.map((r) => r.kind)).toEqual(drillKinds());
      expect(new Set(own.map((r) => r.ackTokenHash))).toEqual(new Set([hashOf(token)]));
      expect(own.every((r) => r.driver === "worker" && r.outcome === null && r.ackBase === ACK_BASE)).toBe(true);
    }
    expect(await takeQueuedDrill(db, { sinkNames: ["mail", "webhook"], now: at(2 * MIN) })).toEqual({ state: "none" });
  });

  it("a request past its hour is stamped expired and never delivered", async () => {
    const db = await makeTestDb();
    await started(db, { drivers: ["worker"] });
    const taken = await takeQueuedDrill(db, { sinkNames: ["mail"], now: at(DRILL_REQUEST_TTL_MS + 1) });
    expect(taken.state).toBe("expired");
    const all = await rows(db);
    expect(all.every((r) => r.sink === "*" && r.outcome === "expired")).toBe(true);
    expect(await takeQueuedDrill(db, { sinkNames: ["mail"], now: at(DRILL_REQUEST_TTL_MS + 2) })).toEqual({ state: "none" });
  });

  it("a worker with no usable sink stamps its request unarmed", async () => {
    const db = await makeTestDb();
    await started(db, { drivers: ["worker"] });
    expect((await takeQueuedDrill(db, { sinkNames: [], now: at(MIN) })).state).toBe("unarmed");
    expect((await rows(db)).every((r) => r.sink === "*" && r.outcome === "unarmed")).toBe(true);
  });

  it("an ack base it cannot use is not linked: the run is still delivered, with no token", async () => {
    const db = await makeTestDb();
    await db.insert(alertDrills).values({
      runId: RUN, kind: "worker_down", driver: "worker", sink: "*", ackBase: "http://ohmail.example/api", requestedAt: NOW,
    });
    const taken = await takeQueuedDrill(db, { sinkNames: ["mail"], now: at(MIN) });
    expect(taken).toMatchObject({ state: "claimed", ackBase: null });
    if (taken.state !== "claimed") return;
    expect(taken.tokens.size).toBe(0);
    const [own] = await db.select().from(alertDrills).where(and(eq(alertDrills.runId, RUN), eq(alertDrills.sink, "mail")));
    expect(own).toMatchObject({ ackTokenHash: null, ackBase: null });
  });
});

describe("the last runs, as GET /internal/alerts/drill answers them", () => {
  it("one entry per run, per message, with no hash", async () => {
    const db = await makeTestDb();
    const run = await started(db);
    await recordDrillOutcomes(db, run.runId, "api", [
      { sink: "mail", ok: true, outcome: "ok", error: null },
      { sink: "telegram", ok: false, outcome: "unreachable", error: "TypeError: fetch failed" },
    ]);
    await ackDrill(db, run.tokens.get("mail")!, at(MIN));
    const runs = await listDrillRuns(db, 5);
    expect(runs).toEqual([{
      runId: run.runId, requestedAt: NOW.toISOString(), kinds: drillKinds().length,
      messages: [
        { driver: "api", sink: "mail", kinds: drillKinds().length, firedAt: NOW.toISOString(), outcome: "ok", ackedAt: at(MIN).toISOString() },
        { driver: "api", sink: "telegram", kinds: drillKinds().length, firedAt: NOW.toISOString(), outcome: "unreachable", ackedAt: null },
        { driver: "worker", sink: "*", kinds: drillKinds().length, firedAt: null, outcome: null, ackedAt: null },
      ],
    }]);
    const text = JSON.stringify(runs);
    for (const token of run.tokens.values()) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(hashOf(token));
    }
  });
});

describe("RISK 3 — a drill never consumes a real page", () => {
  it("an unpaged real incident is mailed on the next pass after a drill, and the pager remembers nothing of the drill", async () => {
    const db = await makeTestDb();
    const r = await unpagedThenDrill(db, NOW);
    expect(r.first.firing.map((a) => a.key)).toContain(REAL_KEY);
    expect(r.arm.attempts.some((m) => m.includes(REAL_KEY)), "the real page was tried").toBe(true);
    expect(r.realAfterRefusal, "and refused, so it stands unpaged").toBeNull();
    expect(r.windowAfterRefusal).toBeNull();
    expect(r.acceptedByDrill, "the drill mailed").toBe(1);
    expect(r.arm.accepted[0]!.every((k) => k.startsWith(`drill:${r.drilled.runId}:`))).toBe(true);
    expect(r.after, "alert_state, alert_pass_runs and the streak are untouched").toBe(r.before);
    expect(r.second.notified.map((a) => a.key), "the next real pass pages at once").toContain(REAL_KEY);
    expect(r.arm.accepted.slice(1).some((m) => m.includes(REAL_KEY))).toBe(true);
  });

  it("after a real page, a drill is still delivered and the real window does not move", async () => {
    const db = await makeTestDb();
    const r = await pagedThenDrill(db, NOW);
    expect(r.realBefore).toBe(NOW.toISOString());
    expect(r.windowBefore).toBe(NOW.toISOString());
    expect(r.arm.accepted.length, "the drill mailed inside the real window").toBe(r.pagesBefore + 1);
    expect(r.realAfter).toBe(r.realBefore);
    expect(r.windowAfter).toBe(r.windowBefore);
    await cleanup(db);
  });

  it("the drill module names none of the real pager's memory", () => {
    const src = readFileSync(new URL("../src/alert-drill.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const name of [
      /\balertState\b/, /\balert_state\b/, /\balertPassRuns\b/, /\balert_pass_runs\b/, /\brunAlertPass\b/,
      /\brecordAlertPass\b/, /\w*PolicyRow\b/, /\baccountDelivery\b/, /\baccountSinkDelivery\b/,
      /\bdeliveryStreak\b/i, new RegExp(`["'\`]${POLICY_KEY.split(":")[0]}:`),
    ]) {
      expect(src, String(name)).not.toMatch(name);
    }
  });
});
