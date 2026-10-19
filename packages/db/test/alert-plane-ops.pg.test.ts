import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomInt } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { schema } from "../src/schema.js";
import { evaluateAlerts, runAlertPass, type AlertPassOptions, type AlertSink } from "../src/alerts.js";
import { makeEntitlementsClient } from "../src/entitlements-client.js";
import { entitlementsFaultRecorder } from "../src/api-faults.js";
import { planeOpsReaderOf } from "../src/plane-ops.js";
import type { PlaneOpsAlert, PlaneOpsPass, PlaneOpsReading } from "../src/entitlements-port.js";
import type { Tx } from "../src/change-log.js";

/**
 * THE BILLING PLANE'S OWN FAILURES REACH THE PAGER, on real Postgres: a stopped pass, every billing
 * alert, and a plane the driver cannot read, each deduped through `alert_state` like every kind,
 * cleared when it clears, and never cleared by a reading that did not look.
 *
 * Isolated by its own instants: every pass runs in 2025, before every other alert file's NOW, so
 * the fence keeps its passes off their rows; the three kinds are produced by no other file, and what
 * this file stamped (pass rows, gap days, fault rows) is removed by its own instants after.
 */
const AVAILABLE = await realPgAvailable();
const BASE = new Date("2025-02-17T09:00:00.000Z");
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const END = new Date(BASE.getTime() + 16 * DAY);
const KINDS = ["plane_pass_stale", "billing_alert", "plane_ops_unreadable"] as const;
const POLICY_KEYS = KINDS.map((k) => `mail:${k}`);
const UNREADABLE_WORKER = "plane_ops_unreadable:worker";
const UNREADABLE_API = "plane_ops_unreadable:api";

/** Test `n`'s own day, so no two tests share an instant. */
const dayOf = (n: number): Date => new Date(BASE.getTime() + n * DAY);
const at = (base: Date, ms: number): Date => new Date(base.getTime() + ms);
const iso = (d: Date): string => d.toISOString();
const letters = (n = 10): string => Array.from({ length: n }, () => String.fromCharCode(97 + randomInt(0, 26))).join("");

function pass(name: string, now: Date, over: Partial<PlaneOpsPass> = {}): PlaneOpsPass {
  return {
    name, stale: false, severity: "warning", ageSeconds: 600, staleAfterSeconds: 6 * 3600,
    lastDoneAt: iso(at(now, -10 * MIN)), lastOutcome: "done", lastOutcomeAt: iso(at(now, -10 * MIN)),
    failureStreak: 0, lastErrorClass: null, recorded: true, ...over,
  };
}
/** Seven hours without a completion against a six-hour bound, the last two runs failed. */
const stalePass = (name: string, now: Date): PlaneOpsPass => pass(name, now, {
  stale: true, ageSeconds: 7 * 3600, lastDoneAt: iso(at(now, -7 * HOUR)), lastOutcome: "failed",
  lastOutcomeAt: iso(at(now, -20 * MIN)), failureStreak: 2, lastErrorClass: "PostgresError",
});
const billing = (key: string, now: Date, over: Partial<PlaneOpsAlert> = {}): PlaneOpsAlert => ({
  key, severity: "critical", count: 1, firstAt: iso(at(now, -HOUR)), lastAt: iso(at(now, -MIN)),
  eventType: "invoice.paid", ...over,
});
const read = (
  now: Date, passes: PlaneOpsPass[], alerts: PlaneOpsAlert[] = [], alertsTruncated = false,
): PlaneOpsReading => ({ state: "read", answer: { v: 1, observedAt: iso(now), passes, alerts, alertsTruncated } });
const plane = (reading: PlaneOpsReading) => async (): Promise<PlaneOpsReading> => reading;

/** A pager and a mail arm, each recording the keys it was handed. */
function spies() {
  const pages: string[][] = [];
  const mails: string[][] = [];
  const told: string[] = [];
  const pager: AlertSink = {
    name: "pager",
    async notify(alerts) { pages.push(alerts.map((a) => a.key)); return true; },
    async notifyResolved(notices) { told.push(...notices.map((n) => n.key)); return true; },
  };
  const mail: AlertSink = {
    name: "mail", channel: "mail",
    async notify(alerts) { mails.push(alerts.map((a) => a.key)); return true; },
  };
  const count = (list: string[][], key: string): number => list.flat().filter((k) => k === key).length;
  const ours = (list: string[][]): string[] =>
    list.flat().filter((k) => KINDS.some((kind) => k.startsWith(`${kind}:`)));
  return {
    sinks: [pager, mail], told,
    paged: (key: string) => count(pages, key), mailed: (key: string) => count(mails, key),
    pagedOurs: () => ours(pages), mailedOurs: () => ours(mails),
  };
}
type Spies = ReturnType<typeof spies>;

describe.skipIf(!AVAILABLE)("the billing plane's ops facts page, on real Postgres", () => {
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const purge = async (): Promise<void> => {
    await sql`delete from alert_state where kind = any(${[...KINDS]}) or alert_key = any(${POLICY_KEYS})`;
  };

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);
  beforeEach(purge);
  afterAll(async () => {
    await purge();
    await sql`delete from alert_pass_runs where ran_at >= ${iso(BASE)}::timestamptz and ran_at < ${iso(END)}::timestamptz`;
    await sql`delete from alert_driver_gaps where day >= ${iso(BASE).slice(0, 10)}::date and day < ${iso(END).slice(0, 10)}::date`;
    await sql`delete from api_faults where route like 'entitlements:%'
      and at >= ${iso(BASE)}::timestamptz and at < ${iso(END)}::timestamptz`;
    await sql.end({ timeout: 5 });
  });

  const run = (now: Date, driver: "worker" | "api" | undefined, planeOps: AlertPassOptions["planeOps"], s: Spies) =>
    runAlertPass(db, { now, sinks: s.sinks, shards: [], driver, planeOps });
  const rowOf = async (key: string) => {
    const [r] = await sql`select alert_key, kind, severity, cls, count, resolved_at, notify_count, title, detail
      from alert_state where alert_key = ${key}`;
    return r as undefined | {
      alert_key: string; kind: string; severity: string; cls: string; count: number;
      resolved_at: Date | null; notify_count: number; title: string | null; detail: string | null;
    };
  };

  describe("1 — a stalled pass", () => {
    it("pages once over several passes; stale: false resolves it, with one notice past the flap floor", async () => {
      const t = dayOf(1);
      const s = spies();
      const name = letters();
      const key = `plane_pass_stale:${name}`;
      for (let i = 0; i < 4; i++) {
        const now = at(t, i * MIN);
        const r = await run(now, "worker", plane(read(now, [stalePass(name, now)])), s);
        expect(r.firing.map((a) => a.key)).toContain(key);
        expect(r.planeOps).toBe("read");
      }
      expect(s.paged(key), "one page across four passes").toBe(1);
      expect(s.mailed(key), "and one mail").toBe(1);
      const open = await rowOf(key);
      expect(open).toMatchObject({ kind: "plane_pass_stale", severity: "warning", cls: "incident" });
      expect(open!.detail).toContain("PostgresError");

      const clear = at(t, 5 * MIN);
      const cleared = await run(clear, "worker", plane(read(clear, [pass(name, clear)])), s);
      expect(cleared.resolved).toContain(key);
      for (const later of [at(clear, 61 * MIN), at(clear, 62 * MIN)]) {
        await run(later, "worker", plane(read(later, [pass(name, later)])), s);
      }
      expect(s.told.filter((k) => k === key), "the resolution is told once").toHaveLength(1);
      expect(s.paged(key)).toBe(1);
    });

    it("control: the same world with stale: false fires nothing", async () => {
      const t = dayOf(2);
      const s = spies();
      const name = letters();
      for (let i = 0; i < 3; i++) {
        const now = at(t, i * MIN);
        const r = await run(now, "worker", plane(read(now, [pass(name, now)])), s);
        expect(r.firing.filter((a) => a.kind === "plane_pass_stale")).toEqual([]);
      }
      expect(s.pagedOurs()).toEqual([]);
      expect(await rowOf(`plane_pass_stale:${name}`)).toBeUndefined();
    });
  });

  describe("2 — a billing alert", () => {
    it("pages once while its count grows from 3 to 9; the entry leaving resolves it", async () => {
      const t = dayOf(3);
      const s = spies();
      const code = `apply:Billing${letters(6)}:unknown_price`;
      const key = `billing_alert:${code}`;
      for (const [i, count] of [3, 5, 9].entries()) {
        const now = at(t, i * MIN);
        await run(now, "worker", plane(read(now, [pass("reconcile", now)], [billing(code, now, { count })])), s);
      }
      expect(s.paged(key), "a growing count never pages again").toBe(1);
      expect(await rowOf(key)).toMatchObject({ severity: "critical", cls: "incident", count: 9 });
      const gone = at(t, 4 * MIN);
      const r = await run(gone, "worker", plane(read(gone, [pass("reconcile", gone)], [])), s);
      expect(r.resolved).toContain(key);
    });

    it("control: warning, then critical, re-pages", async () => {
      const t = dayOf(4);
      const s = spies();
      const code = `link:Customer${letters(6)}`;
      const key = `billing_alert:${code}`;
      await run(t, "worker", plane(read(t, [pass("reconcile", t)], [billing(code, t, { severity: "warning", count: 3 })])), s);
      const later = at(t, 3 * MIN);
      await run(later, "worker", plane(read(later, [pass("reconcile", later)], [billing(code, later, { count: 3 })])), s);
      expect(s.paged(key), "a severity rise escalates").toBe(2);
    });
  });

  it("3 — events_failed and unrecorded get their keys; a signal entry is recorded and reaches no sink", async () => {
    const t = dayOf(5);
    const s = spies();
    const r = await run(t, "worker", plane(read(t, [pass("reconcile", t)], [
      billing("events_failed", t, { count: 2, eventType: null }),
      billing("unrecorded", t, { count: 1, eventType: null }),
      billing("apply:zero_cash_upgrade_ignored", t, { severity: "signal" }),
    ])), s);
    const byKey = new Map(r.firing.map((a) => [a.key, a]));
    expect(byKey.get("billing_alert:events_failed")).toMatchObject({ severity: "critical", count: 2 });
    expect(byKey.get("billing_alert:unrecorded")).toMatchObject({ severity: "critical", count: 1 });
    expect(byKey.get("billing_alert:apply:zero_cash_upgrade_ignored")).toMatchObject({ severity: "warning", cls: "signal" });
    expect(s.pagedOurs().sort()).toEqual(["billing_alert:events_failed", "billing_alert:unrecorded"]);
    expect(s.mailedOurs().sort()).toEqual(["billing_alert:events_failed", "billing_alert:unrecorded"]);
    expect(await rowOf("billing_alert:apply:zero_cash_upgrade_ignored")).toMatchObject({ cls: "signal", resolved_at: null });
  });

  it("4 — a truncated answer keeps an absent open billing row open and says partial; untruncated it resolves", async () => {
    const t = dayOf(6);
    const s = spies();
    const a = `apply:Kept${letters(6)}`;
    const b = `apply:Absent${letters(6)}`;
    await run(t, "worker", plane(read(t, [pass("reconcile", t)], [billing(a, t), billing(b, t)])), s);
    const partial = at(t, MIN);
    const r = await run(partial, "worker", plane(read(partial, [pass("reconcile", partial)], [billing(a, partial)], true)), s);
    expect(r.unread).toContainEqual({ kind: "billing_alert", reason: "partial" });
    expect(r.firing.map((x) => x.key)).toContain(`billing_alert:${a}`);
    expect((await rowOf(`billing_alert:${b}`))!.resolved_at, "a partial reading resolves nothing").toBeNull();

    const whole = at(t, 2 * MIN);
    const done = await run(whole, "worker", plane(read(whole, [pass("reconcile", whole)], [billing(a, whole)])), s);
    expect(done.resolved).toContain(`billing_alert:${b}`);
  });

  describe("5 — a plane the driver cannot read", () => {
    it("reads 1-4 are a signal, read 5 an incident with one page, read 6 no page; the open stale row stays", async () => {
      const t = dayOf(7);
      const s = spies();
      const name = letters();
      const stale = `plane_pass_stale:${name}`;
      await run(t, "worker", plane(read(t, [stalePass(name, t)])), s);
      expect(s.paged(stale)).toBe(1);
      for (let k = 1; k <= 6; k++) {
        const now = at(t, k * MIN);
        const r = await run(now, "worker", plane({ state: "unreachable" }), s);
        expect(r.planeOps).toBe("unreachable");
        expect(r.unread).toContainEqual({ kind: "plane_pass_stale", reason: "refused" });
        expect(r.unread).toContainEqual({ kind: "billing_alert", reason: "refused" });
        const row = await rowOf(UNREADABLE_WORKER);
        expect(row, `read ${k}`).toMatchObject({ cls: k < 5 ? "signal" : "incident", count: k, severity: "critical" });
        expect(s.paged(UNREADABLE_WORKER), `read ${k}`).toBe(k < 5 ? 0 : 1);
        expect((await rowOf(stale))!.resolved_at, "never read is never cleared").toBeNull();
      }
      const back = at(t, 7 * MIN);
      const r = await run(back, "worker", plane(read(back, [pass(name, back)])), s);
      expect(r.resolved).toEqual(expect.arrayContaining([stale, UNREADABLE_WORKER]));
    });

    it("6 — a flap (4 failed, 1 good, 4 failed) never pages", async () => {
      const t = dayOf(8);
      const s = spies();
      const refused = plane({ state: "refused", status: 503 });
      let k = 0;
      for (let i = 0; i < 4; i++) await run(at(t, k++ * MIN), "worker", refused, s);
      const good = at(t, k++ * MIN);
      const r = await run(good, "worker", plane(read(good, [pass("reconcile", good)])), s);
      expect(r.resolved).toContain(UNREADABLE_WORKER);
      for (let i = 0; i < 4; i++) await run(at(t, k++ * MIN), "worker", refused, s);
      expect(s.paged(UNREADABLE_WORKER)).toBe(0);
      expect(await rowOf(UNREADABLE_WORKER), "the count restarted at the good read").toMatchObject({ count: 4, cls: "signal" });
    });

    it("7 — the API failing while the worker reads: the API's key pages after five API passes, and no worker pass clears it", async () => {
      const t = dayOf(9);
      const s = spies();
      for (let i = 0; i < 5; i++) {
        const w = at(t, 2 * i * MIN);
        await run(w, "worker", plane(read(w, [pass("reconcile", w)])), s);
        await run(at(w, MIN), "api", plane({ state: "refused", status: 401 }), s);
        expect(await rowOf(UNREADABLE_API), `api read ${i + 1}`).toMatchObject({
          cls: i < 4 ? "signal" : "incident", count: i + 1, resolved_at: null,
        });
      }
      expect(s.paged(UNREADABLE_API)).toBe(1);
      const w = at(t, 11 * MIN);
      await run(w, "worker", plane(read(w, [pass("reconcile", w)])), s);
      expect((await rowOf(UNREADABLE_API))!.resolved_at, "the worker never evaluates the api's key").toBeNull();

      const good = at(t, 12 * MIN);
      const r = await run(good, "api", plane(read(good, [pass("reconcile", good)])), s);
      expect(r.resolved).toContain(UNREADABLE_API);
    });
  });

  describe("8 — an answer the reader refuses", () => {
    const answerWith = (key: string, now: Date) => ({
      v: 1, observedAt: iso(now), alertsTruncated: false,
      passes: [pass("reconcile", now)],
      alerts: [{ key, severity: "critical", count: 1, firstAt: iso(at(now, -HOUR)), lastAt: iso(at(now, -MIN)), eventType: null }],
    });
    const throughTheClient = (key: string, clock: { now: Date }) => planeOpsReaderOf(makeEntitlementsClient({
      baseUrl: "https://plane.example", secret: "x".repeat(24), now: () => clock.now.getTime(),
      onCallFault: "unrecorded",
      fetchImpl: async () => ({ status: 200, json: async () => answerWith(key, clock.now) }),
    }))!;

    it("an identifier-shaped code pages unreadable after the grace, and the value is in no key, title or detail", async () => {
      const t = dayOf(10);
      const s = spies();
      const value = `cus_${letters(8)}`;
      const clock = { now: t };
      const reader = throughTheClient(`apply:${value}`, clock);
      for (let k = 1; k <= 5; k++) {
        clock.now = at(t, k * MIN);
        const r = await run(clock.now, "worker", reader, s);
        expect(r.planeOps).toBe("unreadable");
        expect(JSON.stringify(r.firing)).not.toContain(value);
      }
      expect(s.paged(UNREADABLE_WORKER)).toBe(1);
      expect(await rowOf(UNREADABLE_WORKER)).toMatchObject({ severity: "warning", cls: "incident" });
      const rows = await sql`select alert_key, title, detail from alert_state where kind = any(${[...KINDS]})`;
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain(value);
      expect(JSON.stringify(rows)).toContain("alerts[0].key");
    });

    it("control: the same answer with unnamed pages a billing alert on the first pass", async () => {
      const t = dayOf(11);
      const s = spies();
      const clock = { now: t };
      const r = await run(t, "worker", throughTheClient("apply:unnamed", clock), s);
      expect(r.planeOps).toBe("read");
      expect(s.paged("billing_alert:apply:unnamed")).toBe(1);
    });
  });

  it("9 — a 404 pages nothing, keeps open fact rows open and resolves the driver's own unreadable row", async () => {
    const t = dayOf(12);
    const s = spies();
    const name = letters();
    const stale = `plane_pass_stale:${name}`;
    await run(t, "worker", plane(read(t, [stalePass(name, t)])), s);
    await run(at(t, MIN), "worker", plane({ state: "refused", status: 503 }), s);
    expect(await rowOf(UNREADABLE_WORKER)).toMatchObject({ cls: "signal", count: 1 });
    const pagedBefore = s.pagedOurs().length;

    const r = await run(at(t, 2 * MIN), "worker", plane({ state: "unsupported" }), s);
    expect(r.planeOps).toBe("unsupported");
    expect(r.resolved).toContain(UNREADABLE_WORKER);
    expect(r.unread).toContainEqual({ kind: "plane_pass_stale", reason: "no_reader" });
    expect(r.unread).toContainEqual({ kind: "billing_alert", reason: "no_reader" });
    expect((await rowOf(stale))!.resolved_at, "a plane without the route clears nothing").toBeNull();
    expect(s.pagedOurs().length, "and pages nothing").toBe(pagedBefore);
  });

  it("10 — no reader, absent or null: all three kinds unread no_reader and open rows untouched", async () => {
    const t = dayOf(13);
    const s = spies();
    const name = letters();
    const stale = `plane_pass_stale:${name}`;
    await run(t, "worker", plane(read(t, [stalePass(name, t)])), s);
    await run(at(t, MIN), "worker", plane({ state: "refused", status: 401 }), s);
    for (const [i, planeOps] of [undefined, null].entries()) {
      const r = await run(at(t, (2 + i) * MIN), "worker", planeOps, s);
      expect(r.planeOps).toBe("off");
      for (const kind of KINDS) expect(r.unread).toContainEqual({ kind, reason: "no_reader" });
      expect((await rowOf(stale))!.resolved_at).toBeNull();
      expect((await rowOf(UNREADABLE_WORKER))!.resolved_at).toBeNull();
    }
  });

  it("11 — five failing reads write no api_faults row; control: a failing /v1/access writes one", async () => {
    const t = dayOf(14);
    const s = spies();
    const clock = { now: t };
    const client = makeEntitlementsClient({
      baseUrl: "https://plane.example", secret: "x".repeat(24), now: () => clock.now.getTime(),
      onCallFault: entitlementsFaultRecorder(() => db as unknown as Tx, "api", { now: () => clock.now }),
      fetchImpl: async () => ({ status: 503, json: async () => ({ error: "db_unavailable" }) }),
    });
    const faultsAt = async (route: string): Promise<number> => {
      const [r] = await sql`select count(*)::int as n from api_faults where route = ${route}
        and at >= ${iso(t)}::timestamptz and at < ${iso(at(t, HOUR))}::timestamptz`;
      return Number(r!.n);
    };
    for (let k = 1; k <= 5; k++) {
      clock.now = at(t, k * MIN);
      await run(clock.now, "worker", planeOpsReaderOf(client), s);
    }
    expect(s.paged(UNREADABLE_WORKER), "the outage pages as the reader's own fault").toBe(1);
    expect(await faultsAt("entitlements:/v1/ops")).toBe(0);
    await client.access(["0f1e2d3c", "4b5a", "4978", "8695", "a4b3c2d1e0f9"].join("-"));
    expect(await faultsAt("entitlements:/v1/access")).toBe(1);
  });

  it("12 — a worker pass and an API pass each read once; the console's evaluation reads nothing", async () => {
    const t = dayOf(15);
    const s = spies();
    let reads = 0;
    const counted = async (): Promise<PlaneOpsReading> => { reads += 1; return read(t, [pass("reconcile", t)]); };
    await run(t, "worker", counted, s);
    expect(reads).toBe(1);
    await run(at(t, MIN), "api", counted, s);
    expect(reads).toBe(2);
    await evaluateAlerts(db, { now: at(t, 2 * MIN) });
    expect(reads, "the console is a pure read and never dials the plane").toBe(2);
  });
});
