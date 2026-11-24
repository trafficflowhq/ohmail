import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger } from "@trafficflow/core";
import { acquireLeaderLock, type LeaderLock } from "../../server/src/clock-lock.js";
import { apiClocksLead } from "../src/api-clocks-lead.js";
import { API_CLOCKS_LEADER_KEY, type ApiCronTarget } from "../src/api-cron.js";
import { startWorker } from "../src/index.js";
import { ISOLATED_DB_RESET_BUDGET_MS, openAdmin, prepareIsolatedDb, truncateAll } from "./_isolateddb.js";

/**
 * WHO DRIVES A PASS, READ FROM THE LOCK ITSELF, on real Postgres: the lock is taken here the way
 * the API program takes it (its own `acquireLeaderLock`), and the worker's reading and its schedule
 * are asked what they see. No stand-in has `pg_locks`.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
let DB = "";
let owned: OwnedDb;
const held: LeaderLock[] = [];
const closers: Array<() => Promise<void>> = [];

async function waitFor(pred: () => boolean | Promise<boolean>, ms: number, step = 25): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return true;
    await new Promise((r) => { setTimeout(r, step); });
  }
  return false;
}

async function lead(url: string, key?: bigint): Promise<LeaderLock> {
  const lock = await acquireLeaderLock(url, key);
  if (lock === null) throw new Error("the lock under test was already held");
  held.push(lock);
  return lock;
}

describe("whether an API program leads its own clocks", () => {
  beforeAll(async () => {
    DB = await prepareIsolatedDb("trafficflow_worker_apiclocks");
    owned = makeOwnedDb(DB);
  }, 120_000);
  afterEach(async () => {
    for (const c of closers.splice(0)) await c().catch(() => undefined);
    for (const l of held.splice(0)) await l.release().catch(() => undefined);
    await truncateAll(DB);
  }, ISOLATED_DB_RESET_BUDGET_MS);
  afterAll(async () => { await owned?.close(); });

  it("is read true while a copy holds the clocks' lock, and false the moment it lets go", async () => {
    expect(await apiClocksLead(owned.db)).toBe(false);
    const lock = await lead(DB);
    expect(await apiClocksLead(owned.db)).toBe(true);
    await lock.release();
    expect(await apiClocksLead(owned.db)).toBe(false);
  });

  it("another key, and the same key in another database of the server, are not it", async () => {
    await lead(DB, API_CLOCKS_LEADER_KEY + 1n);
    expect(await apiClocksLead(owned.db), "a neighbouring key read as the clocks' lock").toBe(false);

    const admin = await openAdmin({ max: 1 });
    closers.push(() => admin.end({ timeout: 5 }));
    await admin`select pg_advisory_lock(${API_CLOCKS_LEADER_KEY.toString()}::bigint)`;
    expect(await apiClocksLead(owned.db), "a lock held in another database read as this one's").toBe(false);

    // CONTROL: the reading was live all along.
    await lead(DB);
    expect(await apiClocksLead(owned.db)).toBe(true);
  });

  describe("the worker's schedule beside it", () => {
    const ROW = { everyMs: 250, firstDelayMs: 50, timeoutMs: 5_000, jitterMs: 0 };
    /** One row the API drives itself and one it never does, at a test's cadence. */
    const TARGETS: readonly ApiCronTarget[] = [
      { target: "sessions_reap", route: "/internal/sessions/reap", apiDrives: true, ...ROW },
      { target: "smtp_size", route: "/internal/mailboxes/smtp-size", apiDrives: false, ...ROW },
    ];

    async function fakeApi(): Promise<{ origin: string; asked: (route: string) => number }> {
      const paths: string[] = [];
      const server: Server = createServer((req, res) => {
        paths.push(req.url ?? "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
      await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
      closers.push(() => new Promise<void>((resolve) => { server.close(() => { resolve(); }); server.closeAllConnections(); }));
      const { port } = server.address() as AddressInfo;
      return { origin: `http://127.0.0.1:${port}`, asked: (route) => paths.filter((p) => p === route).length };
    }

    it("leaves the API's row alone while a copy leads, keeps poking its own, and takes the row back when the lock is let go", async () => {
      const api = await fakeApi();
      const lines: Array<Record<string, unknown>> = [];
      const said = (event: string): Array<Record<string, unknown>> => lines.filter((l) => l.event === event);
      const lock = await lead(DB);
      const worker = await startWorker({
        databaseUrl: DB, keyProvider: KP, pollIntervalMs: 60_000, sentDomain: "trafficflow.test",
        instanceId: "wkr-apiclocks", environment: "test",
        logger: createLogger({ service: "worker", level: "info", sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) }),
        apiCron: { baseUrl: api.origin, secret: "s".repeat(32), schedule: { targets: TARGETS, random: () => 0 } },
      });
      closers.push(() => worker.stop());

      // The API's row is decided once the lock has been read; the report is read after that, not after a count of pokes.
      expect(await waitFor(() => said("api_cron_left_to_api").length > 0, 10_000), "the lock was never read").toBe(true);
      expect(await waitFor(() => api.asked("/internal/mailboxes/smtp-size") >= 3, 10_000), "the worker's own row was not poked").toBe(true);
      expect(api.asked("/internal/sessions/reap"), "a pass had two clocks").toBe(0);
      expect(worker.stats().apiCron.map((row) => row.target)).toEqual(["smtp_size"]);
      expect(said("api_cron_left_to_api").map((l) => [l.route, l.droppedFields])).toEqual([["/internal/sessions/reap", undefined]]);

      await lock.release();
      expect(await waitFor(() => api.asked("/internal/sessions/reap") >= 1, 10_000), "a pass was left with no clock").toBe(true);
      // A row taken back is in the report at once; its outcome is written when its poke has answered.
      expect(await waitFor(() => worker.stats().apiCron.find((row) => row.target === "sessions_reap")?.outcome === "ok", 5_000),
        "the row taken back never reported its poke").toBe(true);
      expect(worker.stats().apiCron.map((row) => [row.target, row.outcome])).toEqual([["sessions_reap", "ok"], ["smtp_size", "ok"]]);
      expect(said("api_cron_resumed").map((l) => [l.route, l.droppedFields])).toEqual([["/internal/sessions/reap", undefined]]);
      expect(said("api_cron_left_to_api")).toHaveLength(1);
    }, 60_000);
  });
});
