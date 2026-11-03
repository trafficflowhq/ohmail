import { describe, it, expect, afterEach } from "vitest";
import { fixturePassword } from "../../../test/support/fixture-credentials.js";
import { createApp, apiRoutes, type ApiDeps, type ChangeWakeHub, type SseConfig } from "@trafficflow/api";
import {
  UNMETERED, type AccessReadOpts, type AccessRefusal, type AccessVerdict, type EntitlementsPort,
} from "@trafficflow/db";
import type { Db } from "@trafficflow/services";
import { createLogger, type Logger } from "@trafficflow/core/mail";
import { resetSseCounters } from "../src/routes/events.js";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * AN OPEN `/events` STREAM IS ADMITTED CONTINUOUSLY. Every read the stream makes asks the door's
 * access question again, through the door's reader (`accessFor`, no options), so a suspended or
 * unpaid account's stream ends within one poll of its door refusing. Every case composes a port
 * and asserts it was ASKED: `makeDeps` wires none, and a case that steered the harness's handle
 * instead would pass for an unmetered host.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps, sse?: SseConfig): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null, ...(sse ? { sse } : {}) });

const POLL_MS = 200;
/** No heartbeat and a long lifetime: inside a case, only a read can end a stream. */
const SSE: SseConfig = { heartbeatMs: 3_600_000, pollMs: POLL_MS, lifetimeMs: 60_000 };
const RULE = JSON.stringify({ kind: "sender", match: "x@y.example", destination: "INBOX" });
const ALLOW: AccessVerdict = {
  ok: true, limits: { mailboxes: 5, storageBytes: null, canAddMailbox: true, aiEnabled: true },
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, capMs: number): Promise<void> {
  const end = Date.now() + capMs;
  while (!ok() && Date.now() < end) await sleep(5);
}

type Answer = () => AccessVerdict | Promise<AccessVerdict>;

/** A program whose answer per account the case states; every ask is counted, the door's too. */
function program() {
  const answers = new Map<string, Answer>();
  const asked = new Map<string, Array<AccessReadOpts | undefined>>();
  const allowedAt = new Map<string, number>();
  const access = async (accountId: string, opts?: AccessReadOpts): Promise<AccessVerdict> => {
    asked.set(accountId, [...(asked.get(accountId) ?? []), opts]);
    const a = answers.get(accountId);
    if (a) return a();
    allowedAt.set(accountId, Date.now());
    return ALLOW;
  };
  const port: EntitlementsPort = {
    access,
    accessOrFault: access,
    spend: async (_a, _b, key) => ({ verdict: "ok", charged: true, attempt: key }),
    release: async () => "settled" as const,
    manageLink: async () => null,
    releaseAccount: async () => "none",
  };
  return {
    port,
    asks: (id: string): number => asked.get(id)?.length ?? 0,
    optsOf: (id: string): Array<AccessReadOpts | undefined> => [...(asked.get(id) ?? [])],
    /** When the default answer last allowed this account. */
    allowedAt: (id: string): number => allowedAt.get(id) ?? 0,
    answer: (id: string, a: Answer): void => { answers.set(id, a); },
    refuse: (id: string, reason: AccessRefusal): void => { answers.set(id, () => ({ ok: false, reason })); },
  };
}

/** The bag with an entitlements composition of the case's choosing (`access-gate.test.ts`'s shape). */
async function depsWith(entitlementsPort: unknown) {
  const made = await makeDeps();
  return {
    ...made,
    deps: { ...made.deps, services: { ...made.deps.services, entitlementsPort } } as ApiDeps,
  };
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

/** `events-session-recheck.test.ts`'s reader: a stream over a statement-counting handle, returned
 *  once it is in its poll loop. Only this request sees the counting handle. */
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

/** THE BOUND, read two ways once the program's answer has moved: closed within two poll intervals
 *  by the clock, and at most ONE statement after the move — the first read able to see it ends it. */
async function expectEndWithinTwoPolls(streams: Watched[], move: () => void | Promise<void>): Promise<void> {
  const before = streams.map((w) => w.reads());
  const t0 = Date.now();
  await move();
  await Promise.all(streams.map((w) => w.settle(2 * POLL_MS)));
  streams.forEach((w, i) => {
    expect(w.closedAt(), "the stream outlived its account's refusal by two poll intervals").not.toBeNull();
    expect(w.closedAt()! - t0).toBeLessThanOrEqual(2 * POLL_MS);
    expect(w.reads() - before[i]!).toBeLessThanOrEqual(1);
  });
}

/** Still open AND still polling: `n` more reads and no end. */
async function expectStillLive(w: Watched, n = 2): Promise<void> {
  const r = w.reads();
  await until(() => w.reads() >= r + n || w.closedAt() !== null, (n + 8) * POLL_MS);
  expect(w.closedAt(), "a stream whose account is admitted was closed").toBeNull();
  expect(w.reads()).toBeGreaterThanOrEqual(r + n);
}

/** A wake hub the test pushes by hand, counting who is subscribed. */
function handHub(): { hub: ChangeWakeHub; push(seq: bigint): void; subscribers(): number } {
  const subs = new Set<(seq: bigint) => void>();
  return {
    hub: { subscribe: (_account, cb) => { subs.add(cb); return () => { subs.delete(cb); }; } },
    push: (seq) => { for (const cb of [...subs]) cb(seq); },
    subscribers: () => subs.size,
  };
}

/** The `retry:` values a stream carried, in order. The browser honours the last one. */
const retries = (text: string): string[] => [...text.matchAll(/^retry: (\d+)$/gm)].map((m) => m[1]!);

/** The real hardened logger, writing into `raw`. */
function realLogger(): { logger: Logger; raw: string[]; lines: () => Array<Record<string, unknown>> } {
  const raw: string[] = [];
  const logger = createLogger({ service: "api", level: "debug", sink: (l) => { raw.push(l); } });
  return { logger, raw, lines: () => raw.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe("a refused account's open stream ends within two polls of its door refusing", () => {
  for (const reason of ["suspended", "payment_required"] as const) {
    it(`${reason}: the stream ends within two polls, one read after the program's answer moved; another account's stays open`, async () => {
      const prog = program();
      const { db, deps } = await depsWith(prog.port);
      const s = await seedSession(db, { now: FIXED_NOW });
      const other = await seedSession(db, { now: FIXED_NOW });
      const ended = await watch(deps, s.token);
      const twin = await watch(deps, other.token);
      expect(prog.asks(s.accountId), "the composition never asked the program").toBeGreaterThanOrEqual(1);
      await expectEndWithinTwoPolls([ended], () => prog.refuse(s.accountId, reason));
      const twinAsks = prog.asks(other.accountId);
      await expectStillLive(twin);
      expect(prog.asks(other.accountId), "the open stream stopped asking about its account").toBeGreaterThan(twinAsks);
    }, 20_000);
  }

  it("the close is retry: 30000, then ONE ordinary sync frame carrying the stream's seq, then the end; no sync_failed", async () => {
    const prog = program();
    const { db, deps } = await depsWith(prog.port);
    const { logger, lines } = realLogger();
    const d = { ...deps, logger };
    const s = await seedSession(db, { now: FIXED_NOW });
    const w = await watch(d, s.token);
    expect(prog.asks(s.accountId)).toBeGreaterThanOrEqual(1);
    expect((await H(req("POST", "/rules", { bearer: s.token, body: RULE }), deps)).status).toBe(201);
    await until(() => /event: sync\ndata: \{"seq":\d+\}/.test(w.text()), 10 * POLL_MS);
    const seq = /data: \{"seq":(\d+)\}/.exec(w.text())?.[1];
    expect(seq, "the change never reached the stream").toBeDefined();
    await expectEndWithinTwoPolls([w], () => prog.refuse(s.accountId, "suspended"));
    const text = w.text();
    expect(text.slice(text.indexOf("retry: 30000"))).toBe(`retry: 30000\n\nevent: sync\ndata: {"seq":${seq}}\n\n`);
    expect(retries(text)).toEqual(["3000", "30000"]);
    expect(text).not.toContain("sync_failed");
    expect(lines().filter((l) => l.event === "sse_read_failed" || l.event === "sse_access_unreadable")).toEqual([]);
  }, 20_000);

  it("the invariant: once the program refuses, GET /sync on the same deps answers 402 subscription_required AND the stream is closed", async () => {
    const prog = program();
    const { db, deps } = await depsWith(prog.port);
    const s = await seedSession(db, { now: FIXED_NOW });
    const w = await watch(deps, s.token);
    expect(prog.asks(s.accountId)).toBeGreaterThanOrEqual(1);
    const got: { door?: Response } = {};
    await expectEndWithinTwoPolls([w], async () => {
      prog.refuse(s.accountId, "suspended");
      got.door = await H(req("GET", "/sync?since=0", { bearer: s.token }), deps);
    });
    expect(got.door!.status).toBe(402);
    const body = (await got.door!.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("subscription_required");
    expect(body.error.details?.reason).toBe("suspended");
  }, 20_000);

  it("the first read asks too: an account refused between the door and the first read is closed at that read", async () => {
    const prog = program();
    const { db, deps } = await depsWith(prog.port);
    const s = await seedSession(db, { now: FIXED_NOW });
    let asks = 0;
    prog.answer(s.accountId, () => (++asks === 1 ? ALLOW : { ok: false, reason: "suspended" }));
    const res = await H(req("GET", "/events", { bearer: s.token }), deps, SSE);
    expect(res.status, "the door admitted on its own answer").toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return true;
        text += dec.decode(value, { stream: true });
      }
    })();
    const ended = await Promise.race([pump, sleep(POLL_MS).then(() => false)]);
    if (!ended) await reader.cancel().catch(() => undefined);
    expect(ended, "the first read did not end a refused account's stream").toBe(true);
    expect(text).toBe('retry: 3000\n\nretry: 30000\n\nevent: sync\ndata: {"seq":0}\n\n');
    expect(asks).toBe(2);
  }, 20_000);
});

describe("a pushed frame rides only a read whose account was admitted", () => {
  it("none goes out while the refusing answer is in flight past two poll intervals, and none after the refused read", async () => {
    const prog = program();
    const { db, deps } = await depsWith(prog.port);
    const h = handHub();
    const d = { ...deps, changeWake: h.hub };
    const s = await seedSession(db, { now: FIXED_NOW });
    const w = await watch(d, s.token);
    expect(prog.asks(s.accountId)).toBeGreaterThanOrEqual(1);
    h.push(1_000_000n);
    await until(() => w.text().includes('"seq":1000000'), 10 * POLL_MS);
    expect(w.text(), "a pushed frame on an admitted stream did not go out").toContain('data: {"seq":1000000}');

    // The program's next answer is a refusal that takes several poll intervals to arrive.
    const hold: { release?: (v: AccessVerdict) => void; at: number } = { at: 0 };
    prog.answer(s.accountId, () => { hold.at = Date.now(); return new Promise<AccessVerdict>((r) => { hold.release = r; }); });
    const lastAllowAt = prog.allowedAt(s.accountId);
    const pushedAt = new Map<bigint, number>();
    let seq = 2_000_000n;
    const pusher = setInterval(() => { pushedAt.set(seq, Date.now()); h.push(seq); seq += 1n; }, 10);
    try {
      await until(() => hold.at > 0, 10 * POLL_MS);
      expect(hold.at, "the stream's next read never asked the program").toBeGreaterThan(0);
      await until(() => Date.now() > hold.at + 3 * POLL_MS, 10 * POLL_MS);
      hold.release!({ ok: false, reason: "suspended" });
      await w.settle(2 * POLL_MS);
    } finally {
      clearInterval(pusher);
      hold.release?.({ ok: false, reason: "suspended" });
    }
    expect(w.closedAt(), "the refusal arriving did not end the stream").not.toBeNull();
    const delivered = new Set([...w.text().matchAll(/data: \{"seq":(\d+)\}/g)].map((m) => BigInt(m[1]!)));
    const late = [...pushedAt].filter(([, at]) => at > lastAllowAt + 2 * POLL_MS).map(([n]) => n);
    expect(late.length).toBeGreaterThan(5);
    expect(late.filter((n) => delivered.has(n)), "a pushed frame rode a read whose account was being refused").toEqual([]);
    expect(h.subscribers()).toBe(0);
    const after = w.text();
    h.push(9_000_000n);
    expect(w.text()).toBe(after);
  }, 20_000);
});

describe("controls: an admitted account, a port that throws, and a host with no program", () => {
  it("an allowing program across five polls: the stream stays open and asks once per poll on top of the door's, with no options", async () => {
    const prog = program();
    const { db, deps } = await depsWith(prog.port);
    const s = await seedSession(db, { now: FIXED_NOW });
    const w = await watch(deps, s.token);
    // The door's own ask is behind this count, so every ask after it is the stream's.
    const asks0 = prog.asks(s.accountId);
    expect(asks0, "the door did not ask").toBeGreaterThanOrEqual(1);
    // Six more reads: each of the first five has its ask done before the next read is issued.
    await expectStillLive(w, 6);
    expect(prog.asks(s.accountId) - asks0, "the stream did not ask at every poll").toBeGreaterThanOrEqual(5);
    expect(prog.optsOf(s.accountId).filter((o) => o !== undefined), "an ask carried options").toEqual([]);
  }, 20_000);

  it("a port that throws: the stream stays open and logs ONE sse_access_unreadable line, its error class and nothing else", async () => {
    const prog = program();
    const { db, deps } = await depsWith(prog.port);
    const { logger, raw, lines } = realLogger();
    const s = await seedSession(db, { now: FIXED_NOW });
    const w = await watch({ ...deps, logger }, s.token);
    const secret = `password=${fixturePassword("events-access")} account ${s.accountId} session ${s.sessionId}`;
    let thrown = 0;
    prog.answer(s.accountId, () => {
      if (thrown === 0) { thrown += 1; throw new Error(secret); }
      return ALLOW;
    });
    await until(() => thrown > 0, 10 * POLL_MS);
    expect(thrown, "the stream never asked the throwing port").toBe(1);
    await expectStillLive(w, 3);
    const mine = lines().filter((l) => l.event === "sse_access_unreadable");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ level: "warn", errorClass: "Error" });
    expect(Object.keys(mine[0]!).sort()).toEqual(["errorClass", "event", "level", "requestId", "service", "ts"]);
    expect(lines().filter((l) => l.event === "sse_read_failed")).toEqual([]);
    for (const leak of [fixturePassword("events-access"), s.accountId, s.sessionId]) expect(raw.join("\n")).not.toContain(leak);
  }, 20_000);

  it("the default harness (no composition; its handle, set to refuse, feeds only the mailbox service) and a host declaring UNMETERED: both streams stay open", async () => {
    const plain = await makeDeps();
    plain.access.refuse("suspended");
    const a = await seedSession(plain.db, { now: FIXED_NOW });
    const unmetered = await depsWith(UNMETERED);
    const b = await seedSession(unmetered.db, { now: FIXED_NOW });
    const wa = await watch(plain.deps, a.token);
    const wb = await watch(unmetered.deps, b.token);
    await Promise.all([expectStillLive(wa, 5), expectStillLive(wb, 5)]);
  }, 20_000);
});
