import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLogger } from "@trafficflow/core";
import { newDeliveryStreak, newLastResortState, runAlertPass, type AlertPassResult, type AlertHeartbeat } from "@trafficflow/db/cloud";
import { heartbeatSection } from "../src/start/heartbeat.js";
import type { WorkerScope } from "../src/start/scope.js";

/*
 * THE PASS'S OWN LINES ARE WRITTEN WHEN THE PASS RETURNS. `/health`'s pager verdict is read off the
 * delivery streak the pass moves while it delivers, so a line about what the pass did that waited on a
 * later step (the dead-man ping, the prunes) was missing while `/health` already said dead, and lost for
 * the streak when such a step threw. The pass is faked here; the steps after it are the real ones, the
 * ping a fake that waits or throws.
 */
vi.mock("@trafficflow/db/cloud", async (load) => ({ ...(await load<object>()), runAlertPass: vi.fn() }));

const alert = { key: "sync_lag", kind: "sync_lag", severity: "warning", count: 1, oldestSeconds: 3600, detail: "d" };
const shapes: Array<[string, Partial<AlertPassResult>, Record<string, unknown>]> = [
  ["every configured sink refusing", {
    notified: [alert] as never, failedSinks: ["webhook"], sinkErrors: ["webhook: 503"], sinkFailureStreak: 3,
    escalate: { consecutiveFailures: 3, sinks: ["webhook"], errors: ["webhook: 503"] },
  }, {
    firing: 1, reason: "every configured alert sink refused delivery, repeatedly — alerts are reaching nobody",
    sinks: ["webhook"], consecutiveFailures: 3, sinkErrors: ["webhook: 503"],
  }],
  ["no sink configured", { undeliverable: true }, {
    firing: 1, reason: "no alert sink is configured — set TF_ALERT_EMAIL (with RESEND_API_KEY + MAIL_FROM) or TF_ALERT_WEBHOOK_URL",
  }],
];

function passWith(result: Partial<AlertPassResult>, ping: AlertHeartbeat) {
  vi.mocked(runAlertPass).mockResolvedValue({
    now: new Date().toISOString(), resolutionsTold: [], mailHeld: [], digest: null, firing: [alert] as never, notified: [],
    resolved: [], closedUnconfirmed: [], delivered: [], failedSinks: [], sinkErrors: [], undeliverable: false,
    sinkFailureStreak: 0, escalate: null, sinkOutcomes: [], sinkDegraded: [], sinkHealth: [], unread: [],
    planeOps: "off", planeOpsFault: null, ...result,
  });
  const lines: string[] = [];
  const scope = {
    db: {}, roster: {}, config: {}, alertSinks: [], shards: 1, shardIndex: 1, environment: "test", alertReaders: {},
    parkedAccountsReader: null, apiCron: null, signalPoll: null, alertDeliveryStreak: newDeliveryStreak(),
    alertLastResort: newLastResortState(), alertHeartbeat: ping, alertHeartbeatLogged: { last: null },
    log: createLogger({ service: "worker", level: "debug", sink: (l) => lines.push(l) }),
  } as unknown as WorkerScope;
  heartbeatSection(scope);
  const read = () => lines.map((l) => JSON.parse(l) as { event: string } & Record<string, unknown>);
  return { run: scope.alertPass, read, events: () => read().map((l) => l.event) };
}

describe("the alert pass writes what it did before any later step", () => {
  beforeEach(() => { vi.mocked(runAlertPass).mockReset(); });

  it.each(shapes)("%s: the line stands while the dead-man ping is still waiting", async (_name, result, fields) => {
    let entered = false;
    let release: (v: { state: "ok" }) => void = () => {};
    const held = new Promise<{ state: "ok" }>((r) => { release = r; });
    const pass = passWith(result, { state: "on", ping: () => { entered = true; return held; } });
    const done = pass.run();
    await vi.waitFor(() => expect(entered).toBe(true));
    const line = pass.read().find((l) => l.event === "alerts_undeliverable");
    expect(line, "written when the pass returned, not when the ping settles").toMatchObject({ level: "error", ...fields });
    if (result.escalate) expect(pass.events().indexOf("alert_notified")).toBeLessThan(pass.events().indexOf("alerts_undeliverable"));
    release({ state: "ok" });
    await done;
    expect(pass.events().filter((e) => e === "alerts_undeliverable")).toHaveLength(1);
  });

  it.each(shapes)("%s: a later step that throws loses neither the line nor alert_pass_failed", async (_name, result, fields) => {
    const pass = passWith(result, { state: "on", ping: () => Promise.reject(new Error("ping threw")) });
    await pass.run();
    const events = pass.events();
    expect(pass.read().find((l) => l.event === "alerts_undeliverable")).toMatchObject({ level: "error", ...fields });
    expect(events).toContain("alert_pass_failed");
    expect(events.indexOf("alerts_undeliverable")).toBeLessThan(events.indexOf("alert_pass_failed"));
  });
});
