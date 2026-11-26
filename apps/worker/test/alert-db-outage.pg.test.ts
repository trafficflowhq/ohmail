import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import net from "node:net";
import { StaticKeyProvider, type Logger } from "@trafficflow/core";
import type { HeartbeatGet, PostJson } from "@trafficflow/db/cloud";
import { startWorkerWithLock } from "../src/index.js";
import { isDriverWriteRace } from "../src/driver-write-race.js";
import { acquireLeaderLock, leaderLockKeyFor, type LeaderLock } from "../src/leader-lock.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "../../../packages/organizer/test/_fakeadapter.js";

/**
 * THE WORKER DRIVER WHEN THE DATABASE IS GONE, on real Postgres. The worker's pool sits behind a
 * loopback proxy that can be cut or silenced; the leader lock dials Postgres directly, so the
 * worker keeps its leadership through the outage (a pooler failing while the lock session lives,
 * as `shared-db-fault.pg.test.ts` sets it up). Its alert pass then fails at the first read, and the
 * last-resort page goes out once through the webhook transport seam, from memory; the first pass
 * after the outage sends one resolved notice. The heartbeat fires per completed pass only. A pool
 * whose sessions start read-only refuses the required leadership claim with 25006 and pages
 * before the worker exits.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
const SHARD = 0;
let DB = "";

/** A TCP pass-through in front of Postgres: `cut()` refuses, `silence()` accepts and says nothing. */
class DbProxy {
  private server: net.Server | null = null;
  private readonly live = new Set<net.Socket>();
  private mode: "pass" | "silent" = "pass";
  port = 0;
  constructor(private readonly target: number) {}

  async listen(port = 0): Promise<void> {
    const server = net.createServer((client) => {
      this.live.add(client);
      client.on("error", () => undefined);
      client.on("close", () => this.live.delete(client));
      if (this.mode === "silent") return;
      const upstream = net.createConnection({ host: "127.0.0.1", port: this.target });
      this.live.add(upstream);
      const kill = (): void => { client.destroy(); upstream.destroy(); this.live.delete(client); this.live.delete(upstream); };
      upstream.on("error", kill);
      client.on("close", kill);
      upstream.on("close", kill);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    this.port = (server.address() as net.AddressInfo).port;
    this.server = server;
  }

  private drop(): void {
    for (const s of this.live) { s.end(); setTimeout(() => { s.destroy(); }, 50).unref(); }
    this.live.clear();
  }

  cut(): void { this.server?.close(); this.server = null; this.drop(); }

  /** Connections are accepted and never answered; the live ones are dropped. */
  silence(): void { this.mode = "silent"; this.drop(); }

  async restore(): Promise<void> {
    this.mode = "pass";
    if (!this.server) await this.listen(this.port);
  }
}

function urlVia(url: string, port: number): string {
  const u = new URL(url);
  u.hostname = "127.0.0.1";
  u.port = String(port);
  return u.toString();
}

/** The webhook transport seam: every POST, its body parsed. */
function transport(): PostJson & { posts: Array<{ alerts?: Array<{ key: string }>; resolved?: Array<{ key: string }> }> } {
  const posts: Array<{ alerts?: Array<{ key: string }>; resolved?: Array<{ key: string }> }> = [];
  const post = (async (_url: string, body: string) => {
    posts.push(JSON.parse(body) as (typeof posts)[number]);
    return { status: 200 };
  }) as PostJson & { posts: typeof posts };
  post.posts = posts;
  return post;
}

function counting(counts: Map<string, number>): Logger {
  const note = (event: string): void => { counts.set(event, (counts.get(event) ?? 0) + 1); };
  const self: Logger = {
    level: "debug", child: () => self,
    debug: (e) => note(e), info: (e) => note(e), warn: (e) => note(e),
    error: note,
  };
  return self;
}

/** The same database, every session of this pool started read-only: a hosted database at its disk ceiling. */
function readOnly(url: string): string {
  const u = new URL(url);
  u.searchParams.set("default_transaction_read_only", "on");
  return u.toString();
}

async function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

const pages = (t: ReturnType<typeof transport>): number =>
  t.posts.filter((p) => p.alerts?.some((a) => a.key === "alert_db_unreadable:worker")).length;
const resolutions = (t: ReturnType<typeof transport>): number =>
  t.posts.filter((p) => p.resolved?.some((a) => a.key === "alert_db_unreadable:worker")).length;

describe("the worker's alert pass with its database gone", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_alertdb"); }, 120_000);

  const escaped: unknown[] = [];
  let parked: Array<(err: Error, origin: NodeJS.UncaughtExceptionOrigin) => void> = [];
  const closers: Array<() => Promise<void>> = [];
  let live: DbProxy | null = null;

  beforeEach(async () => {
    await truncateAll(DB);
    escaped.length = 0;
    parked = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    process.on("uncaughtException", (err, origin) => {
      if (isDriverWriteRace(err)) return;
      escaped.push(err);
      for (const l of parked) l(err, origin);
    });
  }, ISOLATED_DB_RESET_BUDGET_MS);

  afterEach(async () => {
    if (live) { try { await live.restore(); } catch { /* ignore */ } }
    for (const c of closers.splice(0).reverse()) { try { await c(); } catch { /* ignore */ } }
    live = null;
    process.removeAllListeners("uncaughtException");
    for (const l of parked) process.on("uncaughtException", l);
  }, 60_000);

  async function start(outage?: { post: ReturnType<typeof transport>; get: HeartbeatGet }): Promise<{
    proxy: DbProxy; post: ReturnType<typeof transport>; pings: () => number; counts: Map<string, number>;
  }> {
    const proxy = new DbProxy(Number(new URL(DB).port || 5432));
    await proxy.listen();
    closers.push(async () => { proxy.cut(); });
    live = proxy;
    const lock: LeaderLock | null = await acquireLeaderLock(DB, leaderLockKeyFor(SHARD));
    if (!lock) throw new Error("the shard lock was already held in this file's own database");
    closers.push(async () => { await lock.release(); });
    const post = outage?.post ?? transport();
    let n = 0;
    const get: HeartbeatGet = async () => { n++; return { status: 200 }; };
    const counts = new Map<string, number>();
    const via = urlVia(DB, proxy.port);
    const cfg: WorkerConfig = {
      databaseUrl: outage ? readOnly(via) : via, keyProvider: KP, pollIntervalMs: 60_000, sentDomain: "trafficflow.test",
      adapterFactory: new FakeAdapterFleet().factory, mailboxRetryMs: 60_000, shardIndex: SHARD,
      rosterIntervalMs: 60_000, lockHeartbeatMs: 30_000,
      alertIntervalMs: 400, alertFirstReadMs: 300,
      alertWebhookUrl: "https://hooks.example/alert", alertPost: post,
      alertHeartbeatUrl: "https://hc.example/ping/worker", alertHeartbeatGet: outage?.get ?? get,
      logger: counting(counts),
    };
    const worker = await startWorkerWithLock(cfg, lock);
    closers.push(() => worker.stop());
    return { proxy, post, pings: () => n, counts };
  }

  it("a healthy run pings once per completed pass and makes no transport call", async () => {
    const { post, pings, counts } = await start();
    await waitFor(() => pings() >= 3, 20_000, "three completed passes");
    expect(post.posts, "nothing is firing and nothing paged").toEqual([]);
    expect(counts.get("alert_pass_failed") ?? 0).toBe(0);
    expect(escaped).toEqual([]);
  }, 40_000);

  it("cut: one page on the second failed pass, then none; restored: one resolved notice", async () => {
    const { proxy, post, pings, counts } = await start();
    await waitFor(() => pings() >= 2, 20_000, "two completed passes");
    expect(post.posts).toEqual([]);
    proxy.cut();
    const pingsAtCut = pings();
    await waitFor(() => pages(post) >= 1, 20_000, "the last-resort page");
    expect(counts.get("alert_pass_failed") ?? 0, "a warm process waits for a second failure").toBeGreaterThanOrEqual(2);
    const failedAtPage = counts.get("alert_pass_failed") ?? 0;
    await waitFor(() => (counts.get("alert_pass_failed") ?? 0) >= failedAtPage + 4, 20_000, "four more failed passes");
    expect(pages(post), "once per window").toBe(1);
    expect(pings(), "no heartbeat while no pass completes").toBe(pingsAtCut);
    await proxy.restore();
    await waitFor(() => resolutions(post) >= 1, 45_000, "the resolved notice");
    await waitFor(() => pings() > pingsAtCut, 10_000, "the heartbeat after recovery");
    expect(resolutions(post)).toBe(1);
    expect(pages(post)).toBe(1);
    expect(escaped).toEqual([]);
  }, 90_000);

  it("read-only at startup: the required claim refuses and the worker pages once before exiting", async () => {
    const post = transport();
    let pings = 0;
    const get: HeartbeatGet = async () => { pings++; return { status: 200 }; };
    const failure = await start({ post, get }).catch((err: unknown) => err);
    expect(failure).toMatchObject({ op: "roster.claimHeartbeat" });
    let cause = failure;
    while (cause instanceof Error && cause.cause !== undefined) cause = cause.cause;
    expect(cause).toMatchObject({ code: "25006" });
    expect(pages(post)).toBe(1);
    expect(pings).toBe(0);
    expect(escaped).toEqual([]);
  }, 60_000);

  it("silent: the first-read deadline pages", async () => {
    const { proxy, post, pings } = await start();
    await waitFor(() => pings() >= 1, 20_000, "a completed pass");
    proxy.silence();
    await waitFor(() => pages(post) >= 1, 20_000, "the last-resort page through the deadline");
    expect(pages(post)).toBe(1);
    expect(escaped).toEqual([]);
  }, 60_000);
});
