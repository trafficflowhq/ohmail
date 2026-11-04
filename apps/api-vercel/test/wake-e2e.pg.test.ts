import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { accounts, users, sessions, rules, recordChange } from "@trafficflow/db";
import { closePooledDbs, makeChangeWakeHub, makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { generateToken, hashToken } from "@trafficflow/services";
import { createLogger } from "@trafficflow/core";
import { OhmailEngine, HttpAdapter, MemoryMirrorStore } from "@ohmail/client-engine";
import { loadHostConfig, resetHostState } from "../src/config.js";
import { buildDeps, resetServices } from "../src/deps.js";
import { handleApiRequest } from "../src/handler.js";
import { loadServerConfig } from "../../server/src/config.js";
import { buildServerServices, oauthProviderFor, type ServerRuntime } from "../../server/src/deps.js";
import { handleServerRequest } from "../../server/src/handler.js";
import {
  startSyncScheduler,
  WAKE_STREAM_CLOSED,
  type WakeStreamLike,
} from "../../webapp/app/shell/sync-scheduler.js";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";

/**
 * THE WAKE CHANNEL END TO END, on real wall-clock time and real sockets:
 *
 *   recordChange (drizzle tx on real Postgres, NOTIFY at commit)
 *     → the SELF-HOSTED server (its real composition: the per-process LISTEN hub,
 *       handleServerRequest serving /events over a node http server)
 *       → an SSE stream held by the WEBAPP'S OWN SCHEDULER (the real `startSyncScheduler`,
 *         real `OhmailEngine`, real `HttpAdapter` in bearer mode)
 *         → a drain, within moments of the commit, carrying the entity into the mirror.
 *
 * And the other half of the contract, in the same world: kill the stream and the 8 s poll carries
 * the next commit with no stream ever redialed. The managed host, in its production configuration
 * (TF_SSE=1 + DATABASE_URL_SESSION), holds no stream at all: it bills every wall-clock second an
 * invocation is in flight, so `/events` answers 204 and the same scheduler delivers on its poll.
 *
 * The ONE stand-in is the `EventSource` object itself — node ships none — so the scheduler is
 * handed a minimal fetch-backed equivalent below. It implements only what the WHATWG object
 * does (open/error semantics, named events, no auth logic of its own), so what rides on top —
 * the server's frames, the scheduler's reaction, the latency — is the shipped path. The
 * browser-native half is `sync-liveness-shell.test.ts`'s subject.
 *
 * Nothing here uses fake timers: the point of the file is the CLOCK.
 */

const PG_UP = await realPgAvailable();

const writerSql = postgres(PG_TEST_URL, { max: 5 });
const writer = brandDialect(drizzle(writerSql), "pg");

/** How long each `/events` answer was in flight on the server: the held time a host pays for. */
const eventsHeldMs: number[] = [];

const ENV_KEYS = [
  "DATABASE_URL_POOLED", "DATABASE_URL_SESSION", "TF_SSE", KEY_RING_V1, "TF_SSE_LIFETIME_MS",
] as const;
const saved: Record<string, string | undefined> = {};

function nodeServerFor(handler: (req: Request) => Promise<Response>): Server {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const startedAt = Date.now();
      if ((req.url ?? "").startsWith("/events")) res.on("close", () => { eventsHeldMs.push(Date.now() - startedAt); });
      const url = `http://127.0.0.1${req.url ?? "/"}`;
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      const request = new Request(url, {
        method: req.method ?? "GET",
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : (v ?? "")]),
        ),
        ...(body && body.length > 0 ? { body, duplex: "half" } as RequestInit : {}),
      });
      void handler(request).then(async (out) => {
        res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
        if (!out.body) {
          res.end();
          return;
        }
        // PUMPED chunk by chunk, never buffered: /events is a held stream and a bridge that
        // waited for the end would hold every frame until the lifetime close.
        const reader = out.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      }).catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
  });
}

/** A fetch-backed stand-in for the browser's EventSource, shaped as `WakeStreamLike`. */
class FetchEventSource implements WakeStreamLike {
  readyState = 0;
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly aborter = new AbortController();

  constructor(url: string, headers: Record<string, string>) {
    void this.run(url, headers);
  }

  addEventListener(type: "open" | "sync" | "error", l: () => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(l);
  }

  close(): void {
    this.readyState = WAKE_STREAM_CLOSED;
    this.aborter.abort();
  }

  /**
   * The KILL, as the scheduler would see it from a real EventSource whose server refused or
   * vanished terminally: readyState CLOSED and an `error` event. `close()` alone is the
   * CLIENT hanging up (a real EventSource fires nothing for it), which tells the scheduler
   * nothing — the kill has to be the thing the wire does.
   */
  kill(): void {
    this.readyState = WAKE_STREAM_CLOSED;
    this.aborter.abort();
    this.fire("error");
  }

  private fire(type: string): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l();
  }

  private async run(url: string, headers: Record<string, string>): Promise<void> {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { ...headers, accept: "text/event-stream" },
        signal: this.aborter.signal,
      });
    } catch {
      if (this.readyState !== WAKE_STREAM_CLOSED) {
        this.readyState = WAKE_STREAM_CLOSED;
        this.fire("error");
      }
      return;
    }
    if (!res.ok || !res.body) {
      // The WHATWG object fails the connection on any non-200 and never reconnects.
      this.readyState = WAKE_STREAM_CLOSED;
      this.fire("error");
      return;
    }
    this.readyState = 1;
    this.fire("open");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.readyState === WAKE_STREAM_CLOSED) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const nl = buffer.indexOf("\n");
          if (nl < 0) break;
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          if (line === "") {
            if (eventName) this.fire(eventName);
            eventName = "";
          } else if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
          }
        }
      }
    } catch {
      /* the abort on close(), or the server going away — either way the loop is over */
    }
    if (this.readyState !== WAKE_STREAM_CLOSED) {
      // The lifetime close: a real EventSource fires `error` (readyState CONNECTING) and
      // reconnects natively. This stand-in reports the error and stays down — the scheduler's
      // fast-poll fallback is the subject at that point, not the reconnect.
      this.readyState = 0;
      this.fire("error");
    }
  }
}

async function listen(handler: (req: Request) => Promise<Response>): Promise<{ server: Server; baseUrl: string }> {
  const server = nodeServerFor(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  return { server, baseUrl: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}` };
}

/** The real browser scheduler over a real engine against `baseUrl`, counting its `/sync` drains. */
function scheduled(baseUrl: string, token: string): {
  engine: OhmailEngine; syncTimes: number[]; streams: FetchEventSource[]; stop: () => void;
} {
  const auth = { authorization: `Bearer ${token}` };
  const syncTimes: number[] = [];
  const countingFetch: typeof fetch = async (input, init) => {
    if (String(input).includes("/sync")) syncTimes.push(Date.now());
    return fetch(input as RequestInfo, init);
  };
  const engine = new OhmailEngine({
    adapter: new HttpAdapter({ baseUrl, headers: () => auth, fetch: countingFetch }),
    store: new MemoryMirrorStore(),
  });
  const streams: FetchEventSource[] = [];
  const stopScheduler = startSyncScheduler(engine, {
    report: () => {},
    visibility: null,                       // node has no visibility model
    online: null,
    wake: () => {
      const s = new FetchEventSource(`${baseUrl}/events`, auth);
      streams.push(s);
      return s;
    },
  });
  return { engine, syncTimes, streams, stop: () => { stopScheduler(); for (const s of streams) s.close(); } };
}

const hasRule = (engine: OhmailEngine, match: string): boolean =>
  engine.read().list("rule").some((r) => (r as { match?: string }).match === match);

async function seedRealSession(): Promise<{ token: string; accountId: string }> {
  const token = generateToken();
  const now = new Date();
  const [acct] = await writer.insert(accounts).values({ name: "wake-e2e" }).returning();
  const [user] = await writer.insert(users).values({
    accountId: acct!.id,
    email: `wake-e2e-${randomUUID()}@lichtgrat.example`,
    displayName: "Wake",
    emailVerifiedAt: now,
  }).returning();
  await writer.insert(sessions).values({
    accountId: acct!.id,
    userId: user!.id,
    familyId: randomUUID(),
    accessTokenHash: hashToken(token),
    accessExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    refreshExpiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
    lastTwofaAt: now,
  });
  return { token, accountId: acct!.id };
}

/** Commit one visible entity (a rule) through the REAL chokepoint, returning the commit time. */
async function commitRule(accountId: string, match: string): Promise<number> {
  await writer.transaction(async (tx) => {
    const [row] = await tx.insert(rules).values({
      accountId, kind: "sender", match, destination: "INBOX",
    }).returning();
    await recordChange(tx, { accountId, entityType: "rule", entityId: row!.id, op: "create" });
  });
  return Date.now();
}

const until = async (predicate: () => boolean, ms: number): Promise<void> => {
  const end = Date.now() + ms;
  while (!predicate() && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe.skipIf(!PG_UP)("the wake channel, end to end against real Postgres", () => {
  let managed: { server: Server; baseUrl: string };
  let selfHost: { server: Server; baseUrl: string };
  let owned: OwnedDb;
  let hub: ReturnType<typeof makeChangeWakeHub>;

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    // The production configuration: streaming on and a session-mode URL for the LISTEN.
    process.env.DATABASE_URL_POOLED = PG_TEST_URL;
    process.env.DATABASE_URL_SESSION = PG_TEST_URL;
    process.env.TF_SSE = "1";
    process.env[KEY_RING_V1] = "ab".repeat(32);
    delete process.env.TF_SSE_LIFETIME_MS;
    resetHostState();
    resetServices();
    await runMigrations(PG_TEST_URL);
    managed = await listen(handleApiRequest);

    const cfg = loadServerConfig({
      OHMAIL_ORIGIN: "http://localhost", DATABASE_URL: PG_TEST_URL, [KEY_RING_V1]: "ab".repeat(32),
      TF_BUILD_VERSION: "wake-e2e",
    } as NodeJS.ProcessEnv);
    owned = makeOwnedDb(PG_TEST_URL);
    const logger = createLogger({ service: "server", level: "error", sink: () => {} });
    hub = makeChangeWakeHub(PG_TEST_URL, logger);
    const rt: ServerRuntime = {
      cfg, db: owned.db, services: buildServerServices(cfg, owned.db), changeWake: hub,
      oauth: oauthProviderFor(cfg, owned.db), onSetupTokenMinted: () => {}, logger, alertSinks: [], alertDb: null,
    };
    selfHost = await listen((req) => handleServerRequest(req, rt));
  }, 60_000);

  afterAll(async () => {
    for (const { server } of [managed, selfHost]) {
      server?.closeAllConnections();
      server?.close();
    }
    await hub?.end();
    await owned?.close();
    await closePooledDbs().catch(() => undefined);
    await writerSql.end({ timeout: 5 });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetHostState();
    resetServices();
  });

  it("the managed host in production holds no stream: 204, no LISTEN, a commit delivered on the 8 s poll", async () => {
    const { token, accountId } = await seedRealSession();
    const deps = buildDeps(new Request(`${managed.baseUrl}/events`), loadHostConfig(process.env));
    expect(deps.changeWake, "a LISTEN hub on a host that holds no stream").toBeNull();
    const hello = await (await fetch(`${managed.baseUrl}/hello`)).json() as { features: { sse: boolean } };
    expect(hello.features.sse).toBe(false);
    const direct = await fetch(`${managed.baseUrl}/events`, { headers: { authorization: `Bearer ${token}` } });
    expect(direct.status).toBe(204);
    expect(await direct.text()).toBe("");

    eventsHeldMs.length = 0;
    const tab = scheduled(managed.baseUrl, token);
    try {
      await until(() => tab.streams.length === 1 && tab.streams[0]!.readyState === WAKE_STREAM_CLOSED && tab.syncTimes.length > 0, 10_000);
      expect(tab.streams[0]!.readyState, "the host held the stream open").toBe(WAKE_STREAM_CLOSED);
      const committedAt = await commitRule(accountId, "poll@managed.test");
      await until(() => hasRule(tab.engine, "poll@managed.test"), 12_000);
      expect(hasRule(tab.engine, "poll@managed.test"), "the poll did not carry the commit").toBe(true);
      // eslint-disable-next-line no-console
      console.info(`wake-e2e: managed commit→poll latency ${Date.now() - committedAt}ms (poll cadence 8000ms)`);
      expect(tab.streams, "the scheduler redialed a refused stream").toHaveLength(1);
    } finally {
      tab.stop();
    }
    const held = eventsHeldMs.reduce((a, b) => a + b, 0);
    expect(eventsHeldMs.length, "no /events answer was seen").toBeGreaterThan(0);
    expect(held, `the host held /events for ${held}ms`).toBeLessThan(1_000);
  }, 60_000);

  it("the self-hosted server: a committed change drains the scheduler within ~1s; killed SSE degrades to the 8s poll", async () => {
    const { token, accountId } = await seedRealSession();
    const { engine, syncTimes, streams, stop } = scheduled(selfHost.baseUrl, token);

    try {
      // The stream is open and the bootstrap drain has settled.
      await until(() => streams.length === 1 && streams[0]!.readyState === 1 && syncTimes.length > 0, 10_000);
      expect(streams[0]!.readyState, "the wake stream never opened on the self-hosted server").toBe(1);
      // Half a second for the hub's LISTEN to land: it dials lazily on the first subscribe,
      // and a commit racing that dial is legitimately caught by the poll — which would make
      // the latency assertion below measure the wrong mechanism.
      await new Promise((r) => setTimeout(r, 500));
      const drainsBefore = syncTimes.length;

      // ── PUSH: one commit, and the drain it wakes ────────────────────────────────────────
      const committedAt = await commitRule(accountId, "push@wake.test");
      await until(() => syncTimes.length > drainsBefore, 5_000);
      expect(syncTimes.length, "the commit never woke a drain").toBeGreaterThan(drainsBefore);
      const pushLatency = syncTimes[drainsBefore]! - committedAt;
      // NOTIFY delivery + LISTEN fan-out + SSE frame + scheduler tick, all local.
      expect(pushLatency, `push latency was ${pushLatency}ms`).toBeLessThan(2_000);

      // …and the entity itself arrived through the ordinary drain — data on the data path,
      // the wake on the wake path.
      await until(() => hasRule(engine, "push@wake.test"), 5_000);
      expect(hasRule(engine, "push@wake.test"), "the woken drain did not deliver the committed rule").toBe(true);
      // eslint-disable-next-line no-console
      console.info(`wake-e2e: push commit→drain latency ${pushLatency}ms`);

      // ── KILL THE STREAM: the 8s poll carries on, and nothing redials ───────────────────
      streams[0]!.kill();
      const deadAt = Date.now();
      const drainsAtKill = syncTimes.length;
      const committed2 = await commitRule(accountId, "poll@wake.test");
      await until(() => hasRule(engine, "poll@wake.test"), 15_000);
      expect(hasRule(engine, "poll@wake.test"), "the poll did not carry the mailbox once the stream died").toBe(true);
      const pollLatency = Date.now() - committed2;
      expect(pollLatency, "the fallback drain arrived faster than a poll plausibly could — was the stream really dead?")
        .toBeGreaterThan(200);
      expect(syncTimes.length, "no drain happened after the stream died").toBeGreaterThan(drainsAtKill);
      expect(streams, "the scheduler redialed a terminally failed stream").toHaveLength(1);
      // eslint-disable-next-line no-console
      console.info(`wake-e2e: post-kill poll latency ${pollLatency}ms (poll cadence 8000ms), dead for ${Date.now() - deadAt}ms`);
    } finally {
      stop();
    }
  }, 60_000);
});
