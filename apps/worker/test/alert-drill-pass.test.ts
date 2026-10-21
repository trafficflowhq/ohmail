import { describe, it, expect, vi } from "vitest";
import { asc } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  alertDrills, drillKinds, startDrillRun, DRILL_REQUEST_TTL_MS,
  type Alert, type AlertSink,
} from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import { alertDrillPass } from "../src/alert-drill-pass.js";

/**
 * THE WORKER DRIVER'S DRILL: a run the API queued is delivered once through the worker's own arms,
 * on shard 0 alone, and the pass never throws. Two workers claiming at once is the Postgres file's
 * (`packages/db/test/alert-drill.pg.test.ts`): PGlite has one session.
 */

const NOW = new Date("2026-12-01T12:00:00.000Z");
const MIN = 60_000;
const at = (ms: number): Date => new Date(NOW.getTime() + ms);
const ACK_BASE = "https://ohmail.example/api";

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function sink(name: string) {
  const messages: Alert[][] = [];
  const s: AlertSink = { name, async notify(alerts) { messages.push([...alerts]); return true; } };
  return { sink: s, messages };
}

async function queued(db: Tx) {
  const run = await startDrillRun(db, {
    kinds: drillKinds(), drivers: ["worker"], apiSinkNames: [], ackBase: ACK_BASE, now: NOW,
  });
  if (run.state !== "started") throw new Error("not started");
  return run.runId;
}

describe("alertDrillPass", () => {
  it("delivers a queued run once through each usable arm, records it, and the next pass finds nothing", async () => {
    const db = await makeTestDb() as unknown as Tx;
    const runId = await queued(db);
    const mail = sink("mail");
    const hook = sink("webhook");
    const dead: AlertSink = { name: "telegram", unusable: true, notify: async () => false };
    const log = logger();
    const opts = { sinks: [mail.sink, hook.sink, dead], environment: "production", log, shardIndex: 0 };

    const first = await alertDrillPass(db, { ...opts, now: at(MIN) });
    expect(first).toMatchObject({ state: "delivered", runId, delivered: ["mail", "webhook"], failed: [] });
    expect(mail.messages).toHaveLength(1);
    expect(hook.messages).toHaveLength(1);
    expect(mail.messages[0]!.map((a) => a.kind)).toEqual(drillKinds());
    expect(mail.messages[0]![0]!.detail).toContain(`${ACK_BASE}/internal/alerts/drill/ack?t=`);
    expect(log.info).toHaveBeenCalledWith("alert_drill_delivered", expect.objectContaining({ delivered: ["mail", "webhook"] }));
    const rows = await db.select().from(alertDrills).orderBy(asc(alertDrills.sink));
    expect(new Set(rows.map((r) => `${r.sink}:${r.outcome}`))).toEqual(new Set(["*:dispatched", "mail:ok", "webhook:ok"]));

    expect(await alertDrillPass(db, { ...opts, now: at(2 * MIN) })).toEqual({ state: "none" });
    expect(mail.messages).toHaveLength(1);
  });

  it("does nothing above shard 0", async () => {
    const db = await makeTestDb() as unknown as Tx;
    await queued(db);
    const mail = sink("mail");
    const out = await alertDrillPass(db, { sinks: [mail.sink], environment: "production", now: at(MIN), log: logger(), shardIndex: 1 });
    expect(out).toEqual({ state: "skipped" });
    expect(mail.messages).toEqual([]);
    expect((await db.select().from(alertDrills)).every((r) => r.firedAt === null)).toBe(true);
  });

  it("a request past its hour is stamped expired and not sent; with no usable arm, unarmed", async () => {
    const db = await makeTestDb() as unknown as Tx;
    await queued(db);
    const mail = sink("mail");
    const log = logger();
    const expired = await alertDrillPass(db, { sinks: [mail.sink], environment: "production", now: at(DRILL_REQUEST_TTL_MS + 1), log, shardIndex: 0 });
    expect(expired.state).toBe("expired");
    expect(mail.messages).toEqual([]);
    expect(log.info).toHaveBeenCalledWith("alert_drill_not_sent", { state: "expired", count: drillKinds().length });

    const other = await makeTestDb() as unknown as Tx;
    await queued(other);
    const unarmed = await alertDrillPass(other, {
      sinks: [{ name: "webhook", unusable: true, notify: async () => false }], environment: "production",
      now: at(MIN), log: logger(), shardIndex: 0,
    });
    expect(unarmed.state).toBe("unarmed");
  });

  it("a database that refuses the claim costs a warning, never a throw", async () => {
    const log = logger();
    const err = Object.assign(new Error('relation "alert_drills" does not exist'), { code: "42P01" });
    const db = { transaction: () => Promise.reject(err) } as unknown as Tx;
    const out = await alertDrillPass(db, { sinks: [sink("mail").sink], environment: "production", now: NOW, log, shardIndex: 0 });
    expect(out).toEqual({ state: "failed" });
    expect(log.warn).toHaveBeenCalledWith("alert_drill_pass_failed", expect.objectContaining({ err }));
  });
});
