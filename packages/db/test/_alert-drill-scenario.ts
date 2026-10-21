import { asc, eq, like, or } from "drizzle-orm";
import {
  alertDrills, alertPassRuns, alertState, deliverDrill, drillKinds, newDeliveryStreak,
  recordDrillOutcomes, runAlertPass, startDrillRun,
  type Alert, type AlertSink, type DeliveryStreak,
} from "../src/cloud.js";
import type { Tx } from "../src/change-log.js";

/**
 * RISK 3 OF THE DRILL RULING, as two scenarios one PGlite file and one Postgres file both run: a drill
 * must never consume a real page. A drill delivers through `deliver()` and writes `alert_drills` only,
 * so the real incident's row, its mail window, the pass record and the driver's streak are the same
 * before and after it, and a real page the mail arm refused goes out on the very next pass.
 */

export const MIN = 60_000;
/** A shard no other alert test names, so `worker_down:71` is this file's alone. */
export const SHARD = 71;
export const REAL_KEY = `worker_down:${SHARD}`;
/** The one mail window every `worker_down` key shares. */
export const POLICY_KEY = "mail:worker_down";
export const ACK_BASE = "https://ohmail.example/api";

/** A mail arm (`channel: "mail"`) the test can make refuse; it records every message it is handed. */
export interface MailArm extends AlertSink {
  refusing: boolean;
  /** Every notify, accepted or not: the alert keys it carried. */
  attempts: string[][];
  /** The messages it accepted. */
  accepted: string[][];
}

export function mailArm(): MailArm {
  const arm: MailArm = {
    name: "mail",
    channel: "mail",
    refusing: false,
    attempts: [],
    accepted: [],
    async notify(alerts: readonly Alert[]) {
      const keys = alerts.map((a) => a.key);
      arm.attempts.push(keys);
      if (arm.refusing) return { ok: false, outcome: "refused" as const, error: "HTTP 503" };
      arm.accepted.push(keys);
      return true;
    },
    async notifyDigest() { return true; },
  };
  return arm;
}

const at = (t: Date, ms: number): Date => new Date(t.getTime() + ms);

/** What the real pager remembers: every `alert_state` row, every pass record and the streak. */
export async function pagerMemory(db: Tx, streak: DeliveryStreak): Promise<string> {
  const states = await db.select().from(alertState).orderBy(asc(alertState.alertKey));
  const runs = await db.select().from(alertPassRuns).orderBy(asc(alertPassRuns.driver));
  return JSON.stringify({ states, runs, streak });
}

async function notifiedAt(db: Tx, key: string): Promise<string | null> {
  const [row] = await db.select({ at: alertState.notifiedAt }).from(alertState).where(eq(alertState.alertKey, key));
  return row?.at ? new Date(row.at as unknown as string).toISOString() : null;
}

/** One real API-driver pass that evaluates shard 71 only. */
function realPass(db: Tx, arm: MailArm, now: Date, streak: DeliveryStreak) {
  return runAlertPass(db, {
    now, sinks: [arm], shards: [SHARD], driver: "api", source: "api", environment: "test",
    deliveryStreak: streak,
  });
}

/** A whole drill as the API driver runs one: start, deliver, record. */
export async function apiDrill(db: Tx, arm: AlertSink, now: Date) {
  const kinds = drillKinds();
  const run = await startDrillRun(db, { kinds, drivers: ["api"], apiSinkNames: [arm.name], ackBase: ACK_BASE, now });
  if (run.state !== "started") throw new Error(`the drill did not start: ${run.state}`);
  const report = await deliverDrill([arm], {
    runId: run.runId, kinds, tokens: run.tokens, ackBase: ACK_BASE, source: "api", environment: "test", now,
  });
  await recordDrillOutcomes(db, run.runId, "api", report.outcomes);
  return { runId: run.runId, report };
}

/** This scenario's rows, and only these: other files' alert rows are theirs. */
export async function cleanup(db: Tx): Promise<void> {
  await db.delete(alertDrills);
  await db.delete(alertState).where(or(eq(alertState.alertKey, REAL_KEY), like(alertState.alertKey, "mail:%")));
  await db.delete(alertPassRuns).where(eq(alertPassRuns.driver, "api"));
}

/**
 * The real `worker_down:71` opens while the mail arm refuses, so it stays unpaged; a drill then
 * mails; the next real pass must mail the real page at once.
 */
export async function unpagedThenDrill(db: Tx, t0: Date) {
  await cleanup(db);
  const arm = mailArm();
  const streak = newDeliveryStreak();
  arm.refusing = true;
  const first = await realPass(db, arm, t0, streak);
  const realAfterRefusal = await notifiedAt(db, REAL_KEY);
  const windowAfterRefusal = await notifiedAt(db, POLICY_KEY);
  const before = await pagerMemory(db, streak);
  arm.refusing = false;
  const drilled = await apiDrill(db, arm, at(t0, MIN));
  const after = await pagerMemory(db, streak);
  const acceptedByDrill = arm.accepted.length;
  const second = await realPass(db, arm, at(t0, 2 * MIN), streak);
  return { first, second, realAfterRefusal, windowAfterRefusal, before, after, drilled, acceptedByDrill, arm };
}

/** The reverse: the real page is mailed first, then a drill; the drill still mails, the window holds. */
export async function pagedThenDrill(db: Tx, t0: Date) {
  await cleanup(db);
  const arm = mailArm();
  const streak = newDeliveryStreak();
  await realPass(db, arm, t0, streak);
  const realBefore = await notifiedAt(db, REAL_KEY);
  const windowBefore = await notifiedAt(db, POLICY_KEY);
  const pagesBefore = arm.accepted.length;
  const drilled = await apiDrill(db, arm, at(t0, MIN));
  return {
    realBefore, windowBefore, pagesBefore, drilled, arm,
    realAfter: await notifiedAt(db, REAL_KEY),
    windowAfter: await notifiedAt(db, POLICY_KEY),
  };
}
