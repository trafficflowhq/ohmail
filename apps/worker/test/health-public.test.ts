import { describe, it, expect, afterEach } from "vitest";
import {
  startHealthServer, publicHealth, errorTokenOf, PUBLIC_HEALTH_KEYS, type HealthSnapshot, type HealthServer, type PublicHealth,
} from "../src/health.js";

/**
 * THE WORKER'S PUBLIC HEALTH CARRIES NO COUNT. The endpoint is reachable by anyone (the platform
 * probes it), and it published how many accounts and mailboxes the service runs and when sync
 * degraded. Unauthenticated callers read the verdict and the identities; the whole snapshot answers
 * only the worker's own API-cron credential; the admin console reads the counts from its heartbeats.
 */
const SECRET = "x".repeat(32);
const snap: HealthSnapshot = {
  version: "sha", buildError: null, leader: true, standby: false, mailboxes: 9, accounts: 2, expected: 9,
  quarantined: 1, awaitingCredentials: 1, truncated: 0, escalatedMessages: 3, degraded: true,
  degradedReason: "roster_shortfall",
  unserved: { total: 2, quarantined: 1, awaitingCredentials: 1, standDown: 0, leaseUnreadable: 0, unaccounted: 0 },
  databaseFaultSeconds: null, healthy: true, unhealthyReason: null, waitingForLockSeconds: null, takingOver: false,
  waitingForDatabaseSeconds: null, waitingForDatabaseCode: null,
  lastCycleAt: "2026-09-26T00:00:00.000Z", lagSeconds: 12, kekFingerprint: "fp", kekActiveVersion: 1, kekVersionCount: 1,
  kek: { active: 1, count: 1, fingerprint: "fp" }, shard: { index: 0, shards: 1 }, alertSinks: [], pager: "dead", apiCron: [],
  parkedReader: "composed", dbTls: true, lastRotationMs: null, lastTailMs: null, tail: null,
};
const COUNTS = ["mailboxes", "accounts", "expected", "quarantined", "awaitingCredentials", "truncated", "escalatedMessages", "unserved"];

let server: HealthServer | null = null;
afterEach(async () => { await server?.close(); server = null; });

async function read(headers: Record<string, string> = {}, detailSecret: string | null = SECRET): Promise<Record<string, unknown>> {
  server = await startHealthServer({ port: 0, snapshot: () => snap, detailSecret });
  const res = await fetch(`http://127.0.0.1:${server.port}/health`, { headers });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("worker /health — public liveness, counts behind the credential", () => {
  it("an unauthenticated read carries no count and no degraded clock, and keeps the verdict", async () => {
    const body = await read();
    for (const key of [...COUNTS, "degraded", "degradedReason", "lastCycleAt", "lagSeconds", "databaseFaultSeconds"]) {
      expect(key in body, `${key} is public`).toBe(false);
    }
    expect(body).toMatchObject({ ok: true, healthy: true, version: "sha", leader: true, parkedReader: "composed", dbTls: true });
    expect(body.kek).toEqual(snap.kek);
    // The pager's own verdict is public: with every arm down it is the one signal left.
    expect(body.pager).toBe("dead");
  });

  it("the worker's own API-cron credential reads the whole snapshot", async () => {
    const body = await read({ authorization: `Bearer ${SECRET}` });
    for (const key of COUNTS) expect(key in body, `${key} missing for the credential`).toBe(true);
    expect(body.accounts).toBe(2);
  });

  it("a wrong credential, or a host with none configured, reads the public body", async () => {
    expect("accounts" in (await read({ authorization: `Bearer ${"y".repeat(32)}` }))).toBe(false);
    await server?.close(); server = null;
    expect("accounts" in (await read({ authorization: `Bearer ${SECRET}` }, null))).toBe(false);
  });

  it("an instance waiting for its database says so, and since when, to anyone", async () => {
    // What an outside watchdog reads: the word tells it a restart cannot help.
    const waiting: HealthSnapshot = {
      ...snap, leader: false, healthy: false, unhealthyReason: "waiting_for_database",
      waitingForDatabaseSeconds: 93_600, waitingForDatabaseCode: "08006",
    };
    server = await startHealthServer({ port: 0, snapshot: () => waiting, detailSecret: SECRET });
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      ok: false, healthy: false, leader: false, unhealthyReason: "waiting_for_database",
      waitingForDatabaseSeconds: 93_600, waitingForDatabaseCode: "08006",
    });
  });

  it("an error is named by its class and code: a driver's message, and the host in it, stays off the endpoint", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 10.20.30.40:5432"), { code: "ECONNREFUSED" });
    expect(errorTokenOf(refused)).toBe("Error ECONNREFUSED");
    class PostgresError extends Error { name = "PostgresError"; code = "28P01"; }
    expect(errorTokenOf(new PostgresError('password authentication failed for user "tf" at db.internal:6543')))
      .toBe("PostgresError 28P01");
    // A name or a code that is not a plain token is not published either.
    expect(errorTokenOf(Object.assign(new Error("x"), { name: "at db.internal:5432", code: "host=db.internal" }))).toBe("Error");
    expect(errorTokenOf("connect to db.internal:5432 failed")).toBe("Error");
  });

  it("the allow-list names no count, so a count added to the snapshot later stays private", () => {
    for (const key of COUNTS) expect((PUBLIC_HEALTH_KEYS as readonly string[]).includes(key), key).toBe(false);
    const open: PublicHealth = publicHealth(snap);
    expect(Object.keys(open).sort()).toEqual([...PUBLIC_HEALTH_KEYS].filter((k) => k in snap).sort());
  });
});
