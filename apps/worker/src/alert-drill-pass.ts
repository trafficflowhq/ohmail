import {
  deliverDrill, recordDrillOutcomes, takeQueuedDrill,
  type AlertSink, type QueuedDrill,
} from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import type { Logger } from "@trafficflow/core/mail";

export interface AlertDrillPassOptions {
  sinks: readonly AlertSink[];
  environment: string;
  now: Date;
  log: Pick<Logger, "info" | "warn">;
  shardIndex: number;
}

export type AlertDrillPassResult =
  | { state: "skipped" | "failed" }
  | QueuedDrill
  | { state: "delivered"; runId: string; delivered: string[]; failed: string[] };

/**
 * THE WORKER DRIVER'S DRILL (cloud 0051): a run the API queued for this driver, delivered through
 * this worker's own arms and recorded. It rides the alert pass as its last step, on shard 0's
 * leader alone, and takes at most one run per pass; the claim's `fired_at IS NULL` guard makes a
 * second worker find nothing. It never touches the real pass's state. NEVER THROWS: a database that
 * cannot take the claim costs this pass a warning and leaves the run queued.
 */
export async function alertDrillPass(db: Tx, o: AlertDrillPassOptions): Promise<AlertDrillPassResult> {
  if (o.shardIndex !== 0) return { state: "skipped" };
  try {
    const usable = o.sinks.filter((s) => !s.unusable);
    const taken = await takeQueuedDrill(db, { sinkNames: usable.map((s) => s.name), now: o.now });
    if (taken.state === "none") return taken;
    if (taken.state !== "claimed") {
      o.log.info("alert_drill_not_sent", { state: taken.state, count: taken.kinds.length });
      return taken;
    }
    const report = await deliverDrill(usable, {
      runId: taken.runId, kinds: taken.kinds, tokens: taken.tokens, ackBase: taken.ackBase,
      source: "worker", environment: o.environment, now: o.now,
    });
    await recordDrillOutcomes(db, taken.runId, "worker", report.outcomes);
    o.log.info("alert_drill_delivered", {
      count: taken.kinds.length, delivered: report.delivered, failedSinks: report.failed, sinkErrors: report.errors,
    });
    return { state: "delivered", runId: taken.runId, delivered: report.delivered, failed: report.failed };
  } catch (err) {
    o.log.warn("alert_drill_pass_failed", { err });
    return { state: "failed" };
  }
}
