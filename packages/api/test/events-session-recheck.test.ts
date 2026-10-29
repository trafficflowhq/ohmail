import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps, type ChangeWakeHub, type SseConfig } from "@trafficflow/api";
import { refreshTokens, sessions } from "@trafficflow/db";
import { generateToken, hashToken, type Db } from "@trafficflow/services";
import { createLogger, type Logger } from "@trafficflow/core/mail";
import { resetSseCounters } from "../src/routes/events.js";
import { makeDeps, seedDevice, seedSession, seedSessionFor, req, FIXED_NOW, type SeededSession } from "./helpers.js";

/**
 * AN OPEN `/events` STREAM ENDS WITH ITS SESSION (SEC3-AUTH-4). Every read the stream makes is ONE
 * statement that also asks whether the admitted session's row is still there, this account's and
 * unrevoked, so every door that ends a session ends its stream at the next poll. Each case below
 * drives a real door and names it: sign-out (both doors), device removal, sign-out everywhere, the
 * web-session sweep, the reaper and erasure. Two controls pin the key to the ROW: a refresh rotation
 * and an elapsed access window both leave the stream open. A failed read closes with a 30 s hint.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps, sse?: SseConfig): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null, ...(sse ? { sse } : {}) });

const POLL_MS = 200;
/** No heartbeat and a long lifetime: inside a case, only the session check can end a stream. */
const SSE: SseConfig = { heartbeatMs: 3_600_000, pollMs: POLL_MS, lifetimeMs: 60_000 };
const DAY = 24 * 60 * 60 * 1000;
const SECRET = "s".repeat(32);
const RULE = JSON.stringify({ kind: "sender", match: "x@y.example", destination: "INBOX" });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, capMs: number): Promise<void> {
  const end = Date.now() + capMs;
  while (!ok() && Date.now() < end) await sleep(5);
}

interface Watched {
  /** Statements this stream's own handle ran: the admission, the first read, one per poll. */
  reads(): number;
  text(): string;
  closedAt(): number | null;
  /** Until the stream ends or `ms` passes, whichever comes first. */
  settle(ms: number): Promise<void>;
  stop(): Promise<void>;
}
const watching: Watched[] = [];

afterEach(async () => {
  for (const w of watching.splice(0)) await w.stop();
  resetSseCounters();
});

/**
 * Open a stream on `token` over a handle that counts the statements it runs, and return once the
 * stream is in its poll loop. Only this request sees the counting handle, so the doors a case
 * drives are not counted against the stream.
 */
async function watch(deps: ApiDeps, token: string): Promise<Watched> {
  let reads = 0;
  const db = new Proxy(deps.db, {
    get(target, prop) {
      const v: unknown = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      const fn = v as (...a: unknown[]) => unknown;
      if (prop === "select") return (...a: unknown[]) => { reads += 1; return fn.apply(target, a); };
      return fn.bind(target);
    },
  }) as Db;
  const res = await H(req("GET", "/events", { bearer: token }), { ...deps, db }, SSE);
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  let closedAt: number | null = null;
  const ended = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      text += dec.decode(value, { stream: true });
    }
  })().catch(() => undefined).finally(() => { closedAt ??= Date.now(); });
  const w: Watched = {
    reads: () => reads,
    text: () => text,
    closedAt: () => closedAt,
    settle: async (ms) => { await Promise.race([ended, sleep(ms)]); },
    stop: async () => { await reader.cancel().catch(() => undefined); await ended; },
  };
  watching.push(w);
  await until(() => reads >= 3 || closedAt !== null, 20 * POLL_MS);
  expect(closedAt, "the stream ended before its first poll").toBeNull();
  return w;
}

/**
 * THE BOUND, read two ways once the door has answered: closed within two poll intervals by the
 * clock, and at most ONE statement issued after the door's answer — the first poll able to see the
 * revocation ends the stream. The second reading does not depend on how loaded the machine is.
 */
async function expectEndWithinTwoPolls(streams: Watched[], door: () => Promise<Response>, status: number): Promise<void> {
  const res = await door();
  expect(res.status).toBe(status);
  const t0 = Date.now();
  const before = streams.map((w) => w.reads());
  await Promise.all(streams.map((w) => w.settle(2 * POLL_MS)));
  streams.forEach((w, i) => {
    expect(w.closedAt(), "the stream outlived its session by two poll intervals").not.toBeNull();
    expect(w.closedAt()! - t0).toBeLessThanOrEqual(2 * POLL_MS);
    expect(w.reads() - before[i]!).toBeLessThanOrEqual(1);
  });
}

/** Still open AND still polling: two more reads and no end. */
async function expectStillLive(w: Watched): Promise<void> {
  const r = w.reads();
  await until(() => w.reads() >= r + 2 || w.closedAt() !== null, 10 * POLL_MS);
  expect(w.closedAt(), "a stream whose session is live was closed").toBeNull();
  expect(w.reads()).toBeGreaterThanOrEqual(r + 2);
}

/** A refresh row in the session's OWN family, as a sign-in leaves one. */
async function refreshFor(db: Db, s: SeededSession): Promise<string> {
  const [row] = await db.select({ familyId: sessions.familyId }).from(sessions).where(eq(sessions.id, s.sessionId));
  const token = generateToken();
  await db.insert(refreshTokens).values({
    accountId: s.accountId, userId: s.userId, sessionId: s.sessionId, familyId: row!.familyId,
    tokenHash: hashToken(token), expiresAt: new Date(FIXED_NOW.getTime() + 90 * DAY), createdAt: FIXED_NOW,
  });
  return token;
}

describe("every door that ends a session ends its open stream within two polls", () => {
  it("sign-out, POST /auth/logout: the signed-out session's stream ends; the same user's other session stays open", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const other = await seedSessionFor(db, { accountId: s.accountId, userId: s.userId, now: FIXED_NOW });
    const ended = await watch(deps, s.token);
    const twin = await watch(deps, other.token);
    await expectEndWithinTwoPolls([ended], () => H(req("POST", "/auth/logout", { bearer: s.token, body: "{}" }), deps), 204);
    await expectStillLive(twin);
  }, 20_000);

  it("sign-out, POST /auth/refresh/logout (the web's door, by refresh token): that family's stream ends; the other stays open", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const refresh = await refreshFor(db, s);
    const other = await seedSessionFor(db, { accountId: s.accountId, userId: s.userId, now: FIXED_NOW });
    const ended = await watch(deps, s.token);
    const twin = await watch(deps, other.token);
    await expectEndWithinTwoPolls([ended],
      () => H(req("POST", "/auth/refresh/logout", { body: JSON.stringify({ refreshToken: refresh }) }), deps), 204);
    await expectStillLive(twin);
  }, 20_000);

  it("device removal, DELETE /devices/:id: the removed device's stream ends; the caller's own stays open", async () => {
    const { db, deps } = await makeDeps();
    const me = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const dev = await seedDevice(db, { accountId: me.accountId, userId: me.userId });
    const phone = await seedSessionFor(db, { accountId: me.accountId, userId: me.userId, now: FIXED_NOW, deviceId: dev });
    const ended = await watch(deps, phone.token);
    const twin = await watch(deps, me.token);
    await expectEndWithinTwoPolls([ended], () => H(req("DELETE", `/devices/${dev}`, { bearer: me.token }), deps), 204);
    await expectStillLive(twin);
  }, 20_000);

  it("sign-out everywhere, POST /auth/logout { allDevices }: every stream of the user ends; another account's stays open", async () => {
    const { db, deps } = await makeDeps();
    const me = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const mine = await seedSessionFor(db, { accountId: me.accountId, userId: me.userId, now: FIXED_NOW });
    const stranger = await seedSession(db, { now: FIXED_NOW });
    const a = await watch(deps, me.token);
    const b = await watch(deps, mine.token);
    const twin = await watch(deps, stranger.token);
    await expectEndWithinTwoPolls([a, b],
      () => H(req("POST", "/auth/logout", { bearer: me.token, body: JSON.stringify({ allDevices: true }) }), deps), 204);
    await expectStillLive(twin);
  }, 20_000);

  it("sign-out of every other web session, POST /devices/revoke-web-sessions: the other session's stream ends; the caller's stays open", async () => {
    const { db, deps } = await makeDeps();
    const me = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const other = await seedSessionFor(db, { accountId: me.accountId, userId: me.userId, now: FIXED_NOW });
    const ended = await watch(deps, other.token);
    const twin = await watch(deps, me.token);
    await expectEndWithinTwoPolls([ended],
      () => H(req("POST", "/devices/revoke-web-sessions", { bearer: me.token, body: "{}" }), deps), 200);
    await expectStillLive(twin);
  }, 20_000);

  it("the reaper, GET /internal/sessions/reap: a reaped web session's stream ends; a paired device's stays open", async () => {
    const { db, deps } = await makeDeps();
    const armed = { ...deps, alerts: { secret: SECRET, sinks: [] } } as ApiDeps;
    const me = await seedSession(db, { now: FIXED_NOW });
    await db.update(sessions).set({ lastSeenAt: new Date(FIXED_NOW.getTime() - 91 * DAY), refreshExpiresAt: new Date(FIXED_NOW.getTime() - DAY) })
      .where(eq(sessions.id, me.sessionId));
    const dev = await seedDevice(db, { accountId: me.accountId, userId: me.userId, kind: "web" });
    const paired = await seedSessionFor(db, { accountId: me.accountId, userId: me.userId, now: FIXED_NOW, deviceId: dev });
    await db.update(sessions).set({ lastSeenAt: new Date(FIXED_NOW.getTime() - 400 * DAY) }).where(eq(sessions.id, paired.sessionId));
    const ended = await watch(deps, me.token);
    const twin = await watch(deps, paired.token);
    let reaped: unknown;
    await expectEndWithinTwoPolls([ended], async () => {
      const res = await H(new Request("http://localhost/internal/sessions/reap", { headers: { authorization: `Bearer ${SECRET}` } }), armed);
      reaped = ((await res.clone().json()) as { reaped?: number }).reaped;
      return res;
    }, 200);
    expect(reaped).toBe(1);
    await expectStillLive(twin);
  }, 20_000);

  it("erasure, DELETE /account: the row is deleted, not revoked, and the stream ends; another account's stays open", async () => {
    const { db, deps } = await makeDeps();
    const me = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const stranger = await seedSession(db, { now: FIXED_NOW });
    const ended = await watch(deps, me.token);
    const twin = await watch(deps, stranger.token);
    await expectEndWithinTwoPolls([ended], () => H(req("DELETE", "/account", { bearer: me.token }), deps), 200);
    expect(await db.select().from(sessions).where(eq(sessions.id, me.sessionId))).toHaveLength(0);
    await expectStillLive(twin);
  }, 20_000);
});

describe("the check reads the session ROW: a rotation and an elapsed access window leave the stream open", () => {
  it("a refresh rotation, POST /auth/refresh, updates the same row: the stream outlives the access token it was opened with", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const refresh = await refreshFor(db, s);
    const w = await watch(deps, s.token);
    const res = await H(req("POST", "/auth/refresh", { body: JSON.stringify({ refreshToken: refresh }) }), deps);
    expect(res.status).toBe(200);
    const { tokens } = (await res.json()) as { tokens: { accessToken: string } };
    // The rotation replaced that token: a new request on it is refused, and the stream is not.
    expect((await H(req("GET", "/devices", { bearer: s.token }), deps)).status).toBe(401);
    await expectStillLive(w);
    expect((await H(req("POST", "/rules", { bearer: tokens.accessToken, body: RULE }), deps)).status).toBe(201);
    await until(() => w.text().includes("event: sync"), 10 * POLL_MS);
    expect(w.text()).toMatch(/event: sync\ndata: \{"seq":\d+\}/);
  }, 20_000);

  it("an access window that elapses mid-stream changes nothing the check reads: the stream stays open and carries wakes", async () => {
    const { db, deps, clock } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, accessExpiresAt: new Date(FIXED_NOW.getTime() + 1_000) });
    const writer = await seedSessionFor(db, { accountId: s.accountId, userId: s.userId, now: FIXED_NOW });
    const w = await watch(deps, s.token);
    clock.advance(10 * 60_000);
    expect((await H(req("GET", "/devices", { bearer: s.token }), deps)).status).toBe(401);
    await expectStillLive(w);
    expect((await H(req("POST", "/rules", { bearer: writer.token, body: RULE }), deps)).status).toBe(201);
    await until(() => w.text().includes("event: sync"), 10 * POLL_MS);
    expect(w.text()).toMatch(/event: sync\ndata: \{"seq":\d+\}/);
  }, 20_000);
});

/** A wake hub the test pushes by hand, counting who is subscribed. */
function handHub(): { hub: ChangeWakeHub; push(seq: bigint): void; subscribers(): number } {
  const subs = new Set<(seq: bigint) => void>();
  return {
    hub: { subscribe: (_account, cb) => { subs.add(cb); return () => { subs.delete(cb); }; } },
    push: (seq) => { for (const cb of [...subs]) cb(seq); },
    subscribers: () => subs.size,
  };
}

describe("pushed wakes ride the same recheck; the poll is the floor", () => {
  it("a stream taking pushed wakes still ends within two polls of its sign-out, costs no read per push, and takes none after", async () => {
    const { db, deps } = await makeDeps();
    const h = handHub();
    const d = { ...deps, changeWake: h.hub };
    const s = await seedSession(db, { now: FIXED_NOW });
    const w = await watch(d, s.token);
    h.push(1_000_000n);
    await until(() => w.text().includes('"seq":1000000'), 10 * POLL_MS);
    expect(w.text()).toContain('data: {"seq":1000000}');
    let seq = 2_000_000n;
    const pusher = setInterval(() => { h.push(seq); seq += 1n; }, 20);
    try {
      await expectEndWithinTwoPolls([w], () => H(req("POST", "/auth/logout", { bearer: s.token, body: "{}" }), d), 204);
    } finally {
      clearInterval(pusher);
    }
    expect(h.subscribers()).toBe(0);
    const after = w.text();
    h.push(9_000_000n);
    expect(w.text()).toBe(after);
  }, 20_000);
});

/** A stub `Db` answering the route's one statement; the session is preset, so nothing else reads. */
function pollDb(onRead: () => Promise<Array<{ max: string | null; live?: unknown }>>): Db {
  return { select: () => ({ from: () => ({ where: () => onRead() }) }) } as unknown as Db;
}
const PRESET: ApiDeps["session"] = {
  accountId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  sessionId: "33333333-3333-3333-3333-333333333333",
  lastTwofaAt: null, scope: "full", via: "bearer", emailVerifiedAt: FIXED_NOW,
};
const HS = (d: ApiDeps, sse: SseConfig): Promise<Response> =>
  app.handle(req("GET", "/events"), { ...d, session: PRESET, idempotency: null, sse });
async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += dec.decode(value, { stream: true });
  }
}
/** The `retry:` values a stream carried, in order. The browser honours the last one. */
const retries = (text: string): string[] => [...text.matchAll(/^retry: (\d+)$/gm)].map((m) => m[1]!);

describe("a failed read closes with a 30 s reconnect hint; every other close keeps the 3 s one", () => {
  it("the poll's failure arm writes retry: 30000 before it closes", async () => {
    const { deps } = await makeDeps();
    let calls = 0;
    const db = pollDb(async () => {
      calls += 1;
      if (calls > 1) throw new Error("connection terminated unexpectedly");
      return [{ max: null, live: true }];
    });
    const text = await drain(await HS({ ...deps, db }, { heartbeatMs: 3_600_000, pollMs: 10, lifetimeMs: 10_000 }));
    expect(retries(text)).toEqual(["3000", "30000"]);
    expect(text).toContain("event: sync_failed");
  }, 20_000);

  it("the first read's failure arm writes retry: 30000 before it closes", async () => {
    const { deps } = await makeDeps();
    const db = pollDb(async () => { throw new Error("no connection"); });
    const text = await drain(await HS({ ...deps, db }, { heartbeatMs: 3_600_000, pollMs: 10, lifetimeMs: 10_000 }));
    expect(retries(text)).toEqual(["3000", "30000"]);
    expect(text).toContain("event: sync_failed");
  }, 20_000);

  it("controls: the lifetime's close and the session's close keep the 3 s hint, and send no sync_failed", async () => {
    const { deps } = await makeDeps();
    const lifetime = await drain(await HS({ ...deps, db: pollDb(async () => [{ max: null, live: true }]) },
      { heartbeatMs: 3_600_000, pollMs: 10, lifetimeMs: 100 }));
    let calls = 0;
    const revoked = await drain(await HS({ ...deps, db: pollDb(async () => { calls += 1; return [{ max: null, live: calls < 3 }]; }) },
      { heartbeatMs: 3_600_000, pollMs: 10, lifetimeMs: 10_000 }));
    for (const text of [lifetime, revoked]) {
      expect(retries(text)).toEqual(["3000"]);
      expect(text).not.toContain("sync_failed");
    }
    expect(calls).toBe(3);
  }, 20_000);

  it("a session already gone at the first read closes the stream at once, with no poll", async () => {
    const { deps } = await makeDeps();
    let calls = 0;
    const db = pollDb(async () => { calls += 1; return [{ max: "7", live: false }]; });
    const text = await drain(await HS({ ...deps, db }, { heartbeatMs: 3_600_000, pollMs: 10, lifetimeMs: 10_000 }));
    expect(calls).toBe(1);
    expect(text).toBe("retry: 3000\n\n");
  }, 20_000);

  it("an answer that is neither a boolean true nor the integer 1 reads as not live: text spellings, 0, 2, 1n, null and absent all close", async () => {
    const { deps } = await makeDeps();
    for (const live of ["f", "t", "true", "1", 0, 2, 1n, null, undefined] as unknown[]) {
      let calls = 0;
      const db = pollDb(async () => { calls += 1; return [{ max: null, live: live as boolean }]; });
      const text = await drain(await HS({ ...deps, db }, { heartbeatMs: 3_600_000, pollMs: 10, lifetimeMs: 2_000 }));
      expect(calls, `live: ${String(live)}`).toBe(1);
      expect(text).toBe("retry: 3000\n\n");
    }
  }, 20_000);
});

describe("the read stays ONE statement per poll, as at the base", () => {
  it("the first read is one statement and each poll adds exactly one", async () => {
    const { deps } = await makeDeps();
    let statements = 0;
    const db = pollDb(async () => { statements += 1; return [{ max: null, live: true }]; });
    vi.useFakeTimers();
    try {
      const res = await HS({ ...deps, db }, { heartbeatMs: 3_600_000, pollMs: 1_000, lifetimeMs: 3_600_000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(statements).toBe(1);
      for (let i = 1; i <= 5; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
        expect(statements).toBe(1 + i);
      }
      await res.body!.cancel();
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
});

describe("the SQLite shape: the dialect answers exists as the integer 1", () => {
  it("live as 1 reads as live: the stream polls on and carries a polled frame", async () => {
    const { deps } = await makeDeps();
    let calls = 0;
    const db = pollDb(async () => { calls += 1; return [{ max: calls > 2 ? "9" : "5", live: 1 }]; });
    const text = await drain(await HS({ ...deps, db }, { heartbeatMs: 3_600_000, pollMs: 10, lifetimeMs: 300 }));
    expect(calls, "the first read closed a live session's stream").toBeGreaterThan(3);
    expect(text).toContain('event: sync\ndata: {"seq":9}');
  }, 20_000);
});

/** Read a stream until it ends or `ms` passes; whether it ended is read at the deadline. */
async function readFor(res: Response, ms: number): Promise<{ ended: boolean; text: string }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const state = { ended: false, text: "" };
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { state.ended = true; return; }
      state.text += dec.decode(value, { stream: true });
    }
  })().catch(() => undefined);
  await Promise.race([pump, sleep(ms)]);
  const ended = state.ended;
  if (!ended) await reader.cancel().catch(() => undefined);
  await pump;
  return { ended, text: state.text };
}

/** Every SQL text the PGlite client behind `db` receives, from now on. */
function sqlSent(db: Db): string[] {
  const seen: string[] = [];
  const client = (db as unknown as { $client: { query: (q: string, ...r: unknown[]) => unknown } }).$client;
  const real = client.query.bind(client);
  client.query = (q: string, ...r: unknown[]) => { seen.push(q); return real(q, ...r); };
  return seen;
}

const presetOf = (accountId: string, sessionId: string, userId: string): ApiDeps["session"] => ({
  accountId, userId, sessionId, lastTwofaAt: null, scope: "full", via: "bearer", emailVerifiedAt: FIXED_NOW,
});

describe("the subquery is qualified, and its account predicate holds", () => {
  it("the database receives one statement text per read, its session columns named with their table", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const seen = sqlSent(db);
    const res = await app.handle(req("GET", "/events"),
      { ...deps, session: presetOf(s.accountId, s.sessionId, s.userId), idempotency: null, sse: SSE });
    await until(() => seen.length >= 3, 20 * POLL_MS);
    await res.body!.cancel();
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seen).size, "a read ran more than one statement text").toBe(1);
    const stmt = seen[0]!;
    expect(stmt).toContain('"sessions"."id" = $');
    expect(stmt).toContain('"sessions"."account_id" = $');
    expect(stmt).toContain('"sessions"."revoked_at" is null');
    expect(stmt).not.toMatch(/where "id"|and "account_id"|and "revoked_at"/);
  }, 20_000);

  it("another account's live session id reads not live: that stream ends at its first read; the same id under its own account stays open", async () => {
    const { db, deps } = await makeDeps();
    const a = await seedSession(db, { now: FIXED_NOW });
    const b = await seedSession(db, { now: FIXED_NOW });
    const crossed = await app.handle(req("GET", "/events"),
      { ...deps, session: presetOf(a.accountId, b.sessionId, a.userId), idempotency: null, sse: SSE });
    const read = await readFor(crossed, 2 * POLL_MS);
    expect(read.ended, "a session of another account kept this account's stream open").toBe(true);
    expect(read.text).toBe("retry: 3000\n\n");
    await expectStillLive(await watch(deps, b.token));
  }, 20_000);
});

describe("a pushed frame rides the last read that found the session live", () => {
  it("a poll read held behind a busy pool, then answering signed out: no pushed frame later than two poll intervals after the last live read, and no read per push", async () => {
    const { deps } = await makeDeps();
    const h = handHub();
    const P = 100;
    let reads = 0;
    let firstReadAt = 0;
    const hold: { release?: (rows: Array<{ max: string | null; live: boolean }>) => void } = {};
    const db = pollDb(async () => {
      reads += 1;
      if (reads === 1) { firstReadAt = Date.now(); return [{ max: "5", live: true }]; }
      return new Promise((r) => { hold.release = r; });
    });
    const res = await HS({ ...deps, db, changeWake: h.hub }, { heartbeatMs: 3_600_000, pollMs: P, lifetimeMs: 10_000 });
    const out = readFor(res, 30 * P);
    const pushedAt = new Map<bigint, number>();
    let seq = 10n;
    await until(() => firstReadAt > 0, 10 * P);
    while (Date.now() < firstReadAt + 4 * P) {
      pushedAt.set(seq, Date.now());
      h.push(seq);
      seq += 1n;
      await sleep(10);
    }
    expect(reads, "a push cost a read, or the poll did not wait on the busy pool").toBe(2);
    hold.release!([{ max: "5", live: false }]);
    const { ended, text } = await out;
    expect(ended, "the held read answering signed out did not end the stream").toBe(true);
    const delivered = new Set([...text.matchAll(/data: \{"seq":(\d+)\}/g)].map((m) => BigInt(m[1]!)));
    const early = [...pushedAt].filter(([, at]) => at <= firstReadAt + 2 * P - 20).map(([n]) => n);
    const late = [...pushedAt].filter(([, at]) => at > firstReadAt + 2 * P).map(([n]) => n);
    expect(early.length).toBeGreaterThan(5);
    expect(late.length).toBeGreaterThan(5);
    expect(early.filter((n) => !delivered.has(n)), "a fresh read's pushed frame was dropped").toEqual([]);
    expect(late.filter((n) => delivered.has(n)), "a pushed frame went out on a stale read").toEqual([]);
  }, 20_000);
});

/** The real hardened logger, writing into `raw`. */
function realLogger(): { logger: Logger; raw: string[]; lines: () => Array<Record<string, unknown>> } {
  const raw: string[] = [];
  const logger = createLogger({ service: "api", level: "debug", sink: (l) => { raw.push(l); } });
  return { logger, raw, lines: () => raw.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe("a failed read logs one sse_read_failed line: its error class and nothing else", () => {
  const SECRET_TEXT = `password=hunter2 account ${PRESET!.accountId} session ${PRESET!.sessionId}`;

  for (const arm of ["first read", "poll"] as const) {
    it(`the ${arm}'s failure arm: one warn line, the class only, no message text and no ids`, async () => {
      const { deps } = await makeDeps();
      const { logger, raw, lines } = realLogger();
      let calls = 0;
      const db = pollDb(async () => {
        calls += 1;
        if (arm === "first read" || calls > 1) throw new Error(SECRET_TEXT);
        return [{ max: null, live: true }];
      });
      await drain(await HS({ ...deps, db, logger }, { heartbeatMs: 3_600_000, pollMs: 10, lifetimeMs: 10_000 }));
      const mine = lines().filter((l) => l.event === "sse_read_failed");
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ level: "warn", errorClass: "Error" });
      expect(Object.keys(mine[0]!).sort()).toEqual(["errorClass", "event", "level", "requestId", "service", "ts"]);
      for (const leak of ["hunter2", PRESET!.accountId, PRESET!.sessionId]) expect(raw.join("\n")).not.toContain(leak);
    }, 20_000);
  }

  it("a thrown STRING is logged by its class alone: its text, which the err slot would carry, stays out", async () => {
    const { deps } = await makeDeps();
    const { logger, raw, lines } = realLogger();
    const db = pollDb(async () => { throw SECRET_TEXT; });
    await drain(await HS({ ...deps, db, logger }, { heartbeatMs: 3_600_000, pollMs: 10, lifetimeMs: 10_000 }));
    const mine = lines().filter((l) => l.event === "sse_read_failed");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ errorClass: "String" });
    expect(Object.keys(mine[0]!)).not.toContain("errorText");
    for (const leak of ["hunter2", PRESET!.accountId, PRESET!.sessionId]) expect(raw.join("\n")).not.toContain(leak);
  }, 20_000);

  it("controls: a stream that ends by its lifetime or its session logs no sse_read_failed", async () => {
    const { deps } = await makeDeps();
    const { logger, lines } = realLogger();
    await drain(await HS({ ...deps, db: pollDb(async () => [{ max: null, live: true }]), logger },
      { heartbeatMs: 3_600_000, pollMs: 10, lifetimeMs: 100 }));
    await drain(await HS({ ...deps, db: pollDb(async () => [{ max: null, live: false }]), logger },
      { heartbeatMs: 3_600_000, pollMs: 10, lifetimeMs: 10_000 }));
    expect(lines().filter((l) => l.event === "sse_read_failed")).toEqual([]);
  }, 20_000);
});
