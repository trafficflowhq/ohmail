import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { makeDb, alertPassRuns, alertState } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger, type Logger } from "@trafficflow/core";
import { startWorker } from "../src/index.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";

/**
 * THE WORKER'S ALERT PASS READS THE BILLING PLANE'S OWN FAILURES, on shard 0 only. Driven through
 * `startWorker` against a FAKE PLANE on a loopback socket: the real entitlements client, the real
 * composition and the real pass. The boot says once whether the watch is on; a shard > 0 and a
 * worker that meters nothing never dial `/v1/ops`.
 */
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 9));
let DB = "";
/** The stalled cron job the fake plane reports. */
const JOB = "planeopswatch";

function collectingLogger(): { logger: Logger; lines: () => Array<Record<string, unknown>> } {
  const raw: string[] = [];
  return {
    logger: createLogger({ service: "worker", level: "debug", sink: (l) => raw.push(l) }),
    lines: () => raw.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

/** A plane whose `reconcile`-like pass is seven hours past a six-hour bound; another `opsStatus` refuses `/v1/ops`. */
async function fakePlane(opsStatus = 200): Promise<{ url: string; asked: string[]; close: () => Promise<void> }> {
  const asked: string[] = [];
  const server: Server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      asked.push(req.url ?? "");
      if (req.url === "/v1/ops" && opsStatus !== 200) {
        res.writeHead(opsStatus, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/v1/ops") {
        const now = Date.now();
        res.end(JSON.stringify({
          v: 1, observedAt: new Date(now).toISOString(), alertsTruncated: false, alerts: [],
          passes: [{
            name: JOB, stale: true, severity: "warning", ageSeconds: 7 * 3600, staleAfterSeconds: 6 * 3600,
            lastDoneAt: new Date(now - 7 * 3_600_000).toISOString(), lastOutcome: "failed",
            lastOutcomeAt: new Date(now - 600_000).toISOString(), failureStreak: 2,
            lastErrorClass: "PostgresError", recorded: true,
          }],
        }));
        return;
      }
      res.end(JSON.stringify({
        entitlements: {
          syncEnabled: true, canAddMailbox: true, aiEnabled: true, mailboxLimit: null, storageBytesLimit: null,
        },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`, asked,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

/** Polls until `read` answers non-null, or `ms` passes. */
async function waitFor<T>(read: () => Promise<T | null>, ms = 10_000): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** The worker driver's pass row: proof a pass ran, so an absence after it means something. */
const passesRecorded = async (db: ReturnType<typeof makeDb>): Promise<true | null> =>
  (await db.select().from(alertPassRuns).where(eq(alertPassRuns.driver, "worker"))).length > 0 ? true : null;

describe("the plane's ops watch on the worker", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_plane_ops"); }, 60_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); }, ISOLATED_DB_RESET_BUDGET_MS);

  const boot = (logger: Logger, extra: Record<string, unknown>) => startWorker({
    databaseUrl: DB, pollIntervalMs: 60_000, sentDomain: "app.ohmail.app",
    keyProvider: KP, logger, environment: "test", alertIntervalMs: 150, mailboxRetryMs: 60_000,
    ...extra,
  });

  it("shard 0 with an entitlements program: the watch is on, each pass reads, and a stalled pass is on the board", async () => {
    const plane = await fakePlane();
    closers.push(plane.close);
    const { logger, lines } = collectingLogger();
    const worker = await boot(logger, {
      instanceId: "wkr-planeops-1", entitlements: { url: plane.url, secret: "x".repeat(24) },
    });
    closers.push(() => worker.stop());
    const db = makeDb(DB);
    const row = await waitFor(async () => {
      const [r] = await db.select().from(alertState).where(eq(alertState.alertKey, `plane_pass_stale:${JOB}`));
      return r && plane.asked.filter((p) => p === "/v1/ops").length > 1 ? r : null;
    });
    expect(row, "the stalled pass reached alert_state through the worker's own pass").not.toBeNull();
    expect(row!.resolvedAt).toBeNull();
    expect(lines().filter((l) => l.event === "plane_ops_watch")).toEqual([expect.objectContaining({ state: "on" })]);
    expect(lines().filter((l) => l.event === "plane_ops_state"), "written on change, not per pass").toEqual([
      expect.objectContaining({ level: "info", state: "read" }),
    ]);
    expect(lines().filter((l) => "droppedFields" in l), "the logger census refused a field").toEqual([]);
  }, 30_000);

  it("a plane that refuses /v1/ops: the state line is a warn naming the status, written once", async () => {
    const plane = await fakePlane(503);
    closers.push(plane.close);
    const { logger, lines } = collectingLogger();
    const worker = await boot(logger, {
      instanceId: "wkr-planeops-4", entitlements: { url: plane.url, secret: "x".repeat(24) },
    });
    closers.push(() => worker.stop());
    const said = () => lines().filter((l) => l.event === "plane_ops_state")
      .map((l) => [l.level, l.state, l.status ?? null]);
    const read = await waitFor(async () =>
      (said().length > 0 && plane.asked.filter((p) => p === "/v1/ops").length > 3 ? true : null));
    expect(read, "passes read the refusing plane").toBe(true);
    expect(said(), "written on change, not per pass").toEqual([["warn", "refused", 503]]);
    expect(lines().filter((l) => "droppedFields" in l), "the logger census refused a field").toEqual([]);
  }, 30_000);

  it("a shard > 0 never dials /v1/ops, and says its watch is off", async () => {
    const plane = await fakePlane();
    closers.push(plane.close);
    const { logger, lines } = collectingLogger();
    const worker = await boot(logger, {
      instanceId: "wkr-planeops-2", shardIndex: 1, shards: 2,
      entitlements: { url: plane.url, secret: "x".repeat(24) },
    });
    closers.push(() => worker.stop());
    expect(await waitFor(() => passesRecorded(makeDb(DB))), "a pass ran").toBe(true);
    expect(plane.asked).not.toContain("/v1/ops");
    expect(lines().filter((l) => l.event === "plane_ops_watch")).toEqual([expect.objectContaining({ state: "off" })]);
  }, 30_000);

  it("a worker that meters nothing reads no plane and says so once", async () => {
    const { logger, lines } = collectingLogger();
    const worker = await boot(logger, { instanceId: "wkr-planeops-3" });
    closers.push(() => worker.stop());
    expect(await waitFor(() => passesRecorded(makeDb(DB))), "a pass ran").toBe(true);
    expect(lines().filter((l) => l.event === "plane_ops_watch")).toEqual([expect.objectContaining({ state: "off" })]);
    expect(lines().filter((l) => l.event === "plane_ops_state")).toEqual([]);
  }, 30_000);
});
