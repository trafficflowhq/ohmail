import { describe, it, expect, afterEach } from "vitest";
import { createApp, apiRoutes, type ApiDeps, type ChangeWakeHub, type SseConfig } from "@trafficflow/api";
import {
  makeEntitlementsClient, ACCESS_TTL_MS, type CallFault, type EntitlementsFetch,
} from "@trafficflow/db/cloud";
import type { Db } from "@trafficflow/services";
import { resetSseCounters } from "../src/routes/events.js";
import { makeDeps, seedSession, req, FIXED_NOW, perRequest } from "./helpers.js";

/**
 * WHAT ASKING THE DOOR AT EVERY READ COSTS, through the REAL entitlements client (its verdict
 * cache, its one call in flight per account) over an injected wire and clock. While the program
 * answers, a held allow answers a poll with no dial, so three streams on one account dial it once
 * per TTL window between them, never once per poll; the dial that reads a refusal ends all three;
 * a slow dial holds the poll it rides, never the stream. While it FAULTS, a failed read is held
 * 5 s, under the managed host's 8 s poll, so every poll dials: pinned below as today's cost.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps, sse?: SseConfig): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null, ...(sse ? { sse } : {}) });

const P = 100;
/** No heartbeat and a long lifetime: inside a case, only a read can end a stream. */
const SSE: SseConfig = { heartbeatMs: 3_600_000, pollMs: P, lifetimeMs: 60_000 };

/** The two `/v1/access` bodies the client reads: the fields its parser requires, and no more. */
const ACTIVE = {
  entitlements: {
    syncEnabled: true, canAddMailbox: true, aiEnabled: true, mailboxLimit: 5, storageBytesLimit: null,
    reason: "active",
  },
};
const SUSPENDED = {
  entitlements: {
    syncEnabled: false, canAddMailbox: false, aiEnabled: false, mailboxLimit: 0, storageBytesLimit: 0,
    reason: "suspended",
  },
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, capMs: number): Promise<void> {
  const end = Date.now() + capMs;
  while (!ok() && Date.now() < end) await sleep(5);
}

interface Dial { path: string; at: number; answeredAt?: number }

/** The program on the wire, every dial and call fault recorded, and the clock the client reads. */
function plane() {
  let body: unknown = ACTIVE;
  let status = 200;
  let gate: (() => Promise<void>) | null = null;
  const dials: Dial[] = [];
  const faults: CallFault[] = [];
  let ms = FIXED_NOW.getTime();
  const fetchImpl: EntitlementsFetch = async (url) => {
    const dial: Dial = { path: new URL(url).pathname, at: Date.now() };
    dials.push(dial);
    if (gate) await gate();
    dial.answeredAt = Date.now();
    const answer = body;
    return { status, json: async () => answer };
  };
  const client = makeEntitlementsClient({
    baseUrl: "https://entitlements.invalid", secret: "s".repeat(32),
    fetchImpl, now: () => ms, onCallFault: (f) => { faults.push(f); },
  });
  return {
    client,
    dials: (): Dial[] => [...dials],
    faults: (): CallFault[] => [...faults],
    answer: (b: unknown): void => { body = b; },
    /** The status every later dial answers with; anything but 200 is a call fault. */
    status: (n: number): void => { status = n; },
    /** Every later dial waits on this before it answers; `null` answers at once. */
    hold: (g: (() => Promise<void>) | null): void => { gate = g; },
    advance: (d: number): void => { ms += d; },
  };
}

/** The bag with the real client as its entitlements composition. */
async function depsWith(entitlementsPort: unknown) {
  const made = await makeDeps();
  return {
    ...made,
    deps: { ...made.deps, services: { ...made.deps.services, entitlementsPort } } as ApiDeps,
  };
}

interface Watched {
  /** When each statement this stream's own handle ran was issued: the admission, then each read. */
  readTimes(): number[];
  reads(): number;
  text(): string;
  closedAt(): number | null;
  settle(ms: number): Promise<void>;
  stop(): Promise<void>;
}
const watching: Watched[] = [];

afterEach(async () => {
  for (const w of watching.splice(0)) await w.stop();
  resetSseCounters();
});

/** A stream over a handle that stamps every statement it runs (`onRead` beside each), returned once it polls. */
async function watch(deps: ApiDeps, token: string, onRead?: () => void): Promise<Watched> {
  const times: number[] = [];
  const db = new Proxy(deps.db, {
    get(target, prop) {
      const v: unknown = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      const fn = v as (...a: unknown[]) => unknown;
      if (prop === "select") return (...a: unknown[]) => { times.push(Date.now()); onRead?.(); return fn.apply(target, a); };
      return fn.bind(target);
    },
  }) as Db;
  const res = await H(req("GET", "/events", { bearer: token }), perRequest({ ...deps, db }), SSE);
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
    readTimes: () => [...times],
    reads: () => times.length,
    text: () => text,
    closedAt: () => closedAt,
    settle: async (ms) => { await Promise.race([ended, sleep(ms)]); },
    stop: async () => { await reader.cancel().catch(() => undefined); await ended; },
  };
  watching.push(w);
  await until(() => times.length >= 3 || closedAt !== null, 20 * P);
  expect(closedAt, "the stream ended before its first poll").toBeNull();
  return w;
}

/** Until every stream has run `n` more reads; each must still be open. */
async function pollsEach(streams: Watched[], n: number): Promise<void> {
  const from = streams.map((w) => w.reads());
  await until(() => streams.every((w, i) => w.reads() >= from[i]! + n), (n + 10) * P);
  streams.forEach((w, i) => {
    expect(w.closedAt(), "an admitted stream was closed").toBeNull();
    expect(w.reads()).toBeGreaterThanOrEqual(from[i]! + n);
  });
}

/** A wake hub the test pushes by hand. */
function handHub(): { hub: ChangeWakeHub; push(seq: bigint): void } {
  const subs = new Set<(seq: bigint) => void>();
  return {
    hub: { subscribe: (_account, cb) => { subs.add(cb); return () => { subs.delete(cb); }; } },
    push: (seq) => { for (const cb of [...subs]) cb(seq); },
  };
}

describe("while the program answers, a stream's access read rides the client's cache: one dial per TTL window, never one per poll", () => {
  it("three streams on one account across one TTL expiry: the door's dial, then ONE refresh they share", async () => {
    const p = plane();
    const { db, deps } = await depsWith(p.client);
    const s = await seedSession(db, { now: FIXED_NOW });
    const streams = [await watch(deps, s.token), await watch(deps, s.token), await watch(deps, s.token)];
    expect(p.dials().length, "the door did not dial once, or a stream's first read dialled").toBe(1);
    await pollsEach(streams, 5);
    expect(p.dials().length, "a poll dialled inside the TTL").toBe(1);
    p.advance(ACCESS_TTL_MS + 1);
    await pollsEach(streams, 5);
    expect(p.dials().length, "the expired allow was not re-read exactly once between the three").toBe(2);
    expect(p.dials().map((d) => d.path)).toEqual(["/v1/access", "/v1/access"]);
  }, 20_000);

  it("once the program refuses, the next dial ends every stream: all three wait on that one call and close as it answers", async () => {
    const p = plane();
    const { db, deps } = await depsWith(p.client);
    const s = await seedSession(db, { now: FIXED_NOW });
    const streams = [await watch(deps, s.token), await watch(deps, s.token), await watch(deps, s.token)];
    expect(p.dials().length).toBe(1);
    const gate: { open?: () => void } = {};
    const held = new Promise<void>((r) => { gate.open = r; });
    p.answer(SUSPENDED);
    p.hold(() => held);
    const atAdvance = streams.map((w) => w.reads());
    p.advance(ACCESS_TTL_MS + 1);
    await sleep(3 * P);
    expect(p.dials().length, "the expired allow was not re-read exactly once between the three").toBe(2);
    streams.forEach((w, i) => {
      expect(w.closedAt(), "a stream ended before the program answered").toBeNull();
      expect(w.reads() - atAdvance[i]!, "a stream read on past the call it waits on").toBeLessThanOrEqual(1);
    });
    const atAnswer = streams.map((w) => w.reads());
    const t0 = Date.now();
    gate.open!();
    await Promise.all(streams.map((w) => w.settle(P)));
    streams.forEach((w, i) => {
      expect(w.closedAt(), "a stream outlived the dial that read the refusal by a poll").not.toBeNull();
      expect(w.closedAt()! - t0).toBeLessThanOrEqual(P);
      expect(w.reads() - atAnswer[i]!, "a stream read again before it ended").toBe(0);
      const text = w.text();
      expect(text.slice(text.indexOf("retry: 30000"))).toMatch(/^retry: 30000\n\nevent: sync\ndata: \{"seq":\d+\}\n\n$/);
    });
    expect(p.dials().length).toBe(2);
  }, 20_000);
});

describe("a slow dial holds the poll it rides, never the stream", () => {
  it("a dial of three poll intervals: one read in flight, frames pushed during it dropped as stale, and the stream resumes after", async () => {
    const p = plane();
    const { db, deps } = await depsWith(p.client);
    const h = handHub();
    const s = await seedSession(db, { now: FIXED_NOW });
    const w = await watch({ ...deps, changeWake: h.hub }, s.token);
    expect(p.dials().length).toBe(1);
    p.hold(() => sleep(3 * P));
    const pushedAt = new Map<bigint, number>();
    let seq = 1_000n;
    const pusher = setInterval(() => { pushedAt.set(seq, Date.now()); h.push(seq); seq += 1n; }, 10);
    try {
      p.advance(ACCESS_TTL_MS + 1);
      await until(() => p.dials()[1]?.answeredAt !== undefined, 10 * P);
      const answered = p.dials()[1]?.answeredAt ?? Infinity;
      await until(() => w.readTimes().filter((t) => t > answered).length >= 2, 10 * P);
    } finally {
      clearInterval(pusher);
    }
    expect(w.closedAt(), "the slow dial ended the stream").toBeNull();
    const dial = p.dials()[1];
    expect(dial?.answeredAt, "the expired allow was never re-read").toBeDefined();
    const times = w.readTimes();
    const before = times.filter((t) => t <= dial!.at);
    // The poll that made the dial, and the one before it: the last read the program admitted.
    const lastAdmitted = before.at(-2)!;
    const resumedAt = times.find((t) => t > dial!.answeredAt!)!;
    expect(times.filter((t) => t > dial!.at && t < dial!.answeredAt!), "a second read went out while one was in flight").toEqual([]);
    const delivered = new Set([...w.text().matchAll(/data: \{"seq":(\d+)\}/g)].map((m) => BigInt(m[1]!)));
    const stale = [...pushedAt].filter(([, at]) => at > lastAdmitted + 2 * P && at < resumedAt).map(([n]) => n);
    expect(stale.length).toBeGreaterThan(5);
    expect(stale.filter((n) => delivered.has(n)), "a frame went out on a read older than two polls").toEqual([]);
    h.push(9_000_000n);
    await until(() => w.text().includes('"seq":9000000'), 4 * P);
    expect(w.text(), "the stream did not resume after the slow dial").toContain('data: {"seq":9000000}');
    expect(p.dials().length).toBe(2);
  }, 20_000);
});

describe("while the program faults, today's cost: the 5 s fault hold is shorter than the managed host's 8 s poll", () => {
  /** The real client, its asks counted at the call; a dial is counted on the wire inside the same call. */
  function counted(p: ReturnType<typeof plane>) {
    let asks = 0;
    const port = { ...p.client, access: (...a: Parameters<typeof p.client.access>) => { asks += 1; return p.client.access(...a); } };
    return { port, asks: (): number => asks };
  }

  it("the client's clock one managed poll (8 s) on per read: EVERY ask dials and writes a call fault, and the stream stays open", async () => {
    const p = plane();
    p.status(503);
    const c = counted(p);
    const { db, deps } = await depsWith(c.port);
    const s = await seedSession(db, { now: FIXED_NOW });
    const w = await watch(deps, s.token, () => p.advance(8_000));
    const asks0 = c.asks();
    await pollsEach([w], 8);
    expect(c.asks() - asks0, "the stream did not ask at every poll").toBeGreaterThanOrEqual(7);
    expect(p.dials().length, "a fault hold absorbed an ask: the hold now outlasts a poll").toBe(c.asks());
    expect(p.faults().length, "a dial went unrecorded as a call fault").toBe(p.dials().length);
    expect(p.faults().every((f) => f.path === "/v1/access" && f.status === 503)).toBe(true);
    expect(w.closedAt(), "a faulting program ended the stream").toBeNull();
  }, 20_000);

  it("control: the clock 1 s on per read, inside the hold: at most one dial per five asks", async () => {
    const p = plane();
    p.status(503);
    const c = counted(p);
    const { db, deps } = await depsWith(c.port);
    const s = await seedSession(db, { now: FIXED_NOW });
    const w = await watch(deps, s.token, () => p.advance(1_000));
    const asks0 = c.asks();
    await pollsEach([w], 11);
    expect(c.asks() - asks0, "the stream did not ask at every poll").toBeGreaterThanOrEqual(10);
    expect(p.dials().length, "the held fault did not answer the asks inside its 5 s").toBeLessThanOrEqual(Math.ceil(c.asks() / 5) + 1);
    expect(p.dials().length, "the hold never ran out").toBeGreaterThanOrEqual(2);
    expect(w.closedAt()).toBeNull();
  }, 20_000);
});
