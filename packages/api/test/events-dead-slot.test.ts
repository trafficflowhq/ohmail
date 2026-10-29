import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, apiRoutes, type ApiDeps, type SseConfig } from "@trafficflow/api";
import { writeWebResponse } from "@trafficflow/core/adapters/http-host";
import { createLogger } from "@trafficflow/core/mail";
import { resetSseCounters, sseLiveCounts } from "../src/routes/events.js";
import { makeDeps, seedSession, seedSessionFor, req, FIXED_NOW } from "./helpers.js";

/**
 * THE CAP COUNTS LIVE STREAMS. A stream whose frames stop being taken holds its per-account slot
 * only for two heartbeats (the client's own silence bound), not for the whole lifetime: a tab on a
 * changing network leaves dead streams behind, and before this they filled the cap of four and the
 * next live tab was refused for minutes.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps, sse: SseConfig): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null, sse });

const HB = 40;
const BOUND = 2 * HB;
/** Lifetime far beyond the test, so only the delivery bound can free a slot. */
const CFG: SseConfig = { heartbeatMs: HB, pollMs: 60_000, lifetimeMs: 60_000, maxPerAccount: 4 };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const servers: Server[] = [];
const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = [];

afterEach(async () => {
  await Promise.all(readers.splice(0).map((r) => r.cancel().catch(() => {})));
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  resetSseCounters();
});

/** Read until the ready frame, then either keep reading (a live tab) or stop (a dead one). */
async function openTab(res: Response, live: boolean): Promise<{ pings: () => number; text: () => string; ended: () => boolean }> {
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  readers.push(reader);
  const dec = new TextDecoder();
  let text = "";
  let ended = false;
  while (!text.includes("event: ready")) {
    const { done, value } = await reader.read();
    if (done) throw new Error("the stream ended before ready");
    text += dec.decode(value, { stream: true });
  }
  if (live) {
    void (async () => {
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) { ended = true; return; }
        text += dec.decode(value, { stream: true });
      }
    })();
  }
  return { pings: () => text.split("event: ping").length - 1, text: () => text, ended: () => ended };
}

const countFor = (accountId: string): number => sseLiveCounts().byAccount[accountId] ?? 0;
/** `n` more sessions (devices) of `s`'s account; their tokens. */
const devices = async (db: Parameters<typeof seedSessionFor>[0], s: { accountId: string; userId: string }, n: number): Promise<string[]> =>
  (await Promise.all(Array.from({ length: n }, () => seedSessionFor(db, { accountId: s.accountId, userId: s.userId, now: FIXED_NOW })))).map((d) => d.token);

describe("GET /events frees the slot of a stream nobody reads", () => {
  it("a stream whose frames stop being taken releases its slot within two heartbeats", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await openTab(await H(req("GET", "/events", { bearer: s.token }), deps, CFG), false);
    expect(countFor(s.accountId)).toBe(1);
    await sleep(BOUND + 3 * HB);
    expect(countFor(s.accountId), "a dead stream still holds its slot").toBe(0);
  });

  it("the cap admits a fifth device once a dead one is reaped", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const tokens = [s.token, ...(await devices(db, s, 4))];
    const open = (i: number) => H(req("GET", "/events", { bearer: tokens[i]! }), deps, CFG);
    for (let i = 0; i < 3; i++) await openTab(await open(i), true);
    await openTab(await open(3), false);
    const refused = await open(4);
    expect(refused.status, "the premise: four devices fill the cap").toBe(429);
    await sleep(BOUND + 3 * HB);
    const fifth = await open(4);
    expect(fifth.status, "a dead stream kept the fifth tab out").toBe(200);
    await openTab(fifth, true);
    expect(countFor(s.accountId)).toBe(4);
  });

  it("CONTROL: four live devices keep their slots past the bound, and a fifth is still refused", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const tokens = [s.token, ...(await devices(db, s, 4))];
    const open = (i: number) => H(req("GET", "/events", { bearer: tokens[i]! }), deps, CFG);
    const tabs = [];
    for (let i = 0; i < 4; i++) tabs.push(await openTab(await open(i), true));
    await sleep(BOUND + 4 * HB);
    expect(countFor(s.accountId)).toBe(4);
    expect(tabs.every((t) => t.pings() >= 2), "the live tabs were heard pinging").toBe(true);
    const fifth = await open(4);
    expect(fifth.status).toBe(429);
    expect((await fifth.json()).error.code).toBe("sse_too_many_streams");
  });

  it("a request whose client left (its signal aborted) frees its slot at once", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const slow: SseConfig = { ...CFG, heartbeatMs: 60_000 };
    const left = new AbortController();
    const r = new Request(req("GET", "/events", { bearer: s.token }), { signal: left.signal });
    await openTab(await H(r, deps, slow), true);
    expect(countFor(s.accountId)).toBe(1);
    left.abort();
    await sleep(0);
    expect(countFor(s.accountId), "the left stream still holds its slot").toBe(0);
  });

  it("a request already aborted when its stream opens holds no slot", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const r = new Request(req("GET", "/events", { bearer: s.token }), { signal: AbortSignal.abort() });
    const res = await H(r, deps, CFG);
    await res.body?.getReader().read().catch(() => {});
    await sleep(0);
    expect(countFor(s.accountId)).toBe(0);
  });

  it("CONTROL: a client that goes away through the self-host adapter frees its slot at once", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const slow: SseConfig = { ...CFG, heartbeatMs: 60_000 };
    const server = createServer((_in, out) => {
      void (async () => writeWebResponse(out, await H(req("GET", "/events", { bearer: s.token }), deps, slow)))();
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      const r = httpRequest({ host: "127.0.0.1", port, path: "/events" }, (res) => {
        res.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("event: ready")) { res.destroy(); resolve(); }
        });
      });
      r.on("error", (e) => { if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e); });
      r.end();
    });
    const until = Date.now() + 2_000;
    while (countFor(s.accountId) > 0 && Date.now() < until) await sleep(10);
    expect(countFor(s.accountId), "the closed socket's slot was not released").toBe(0);
  });
});

/**
 * A NAMED RE-DIAL ENDS THE STREAM IT LEFT. On Cloud the host keeps reading a stream whose client
 * has gone, so the delivery bound never trips; a tab that redials names its stream, and the server
 * ends the earlier one of that name (same account, same session) and takes its slot.
 */
describe("GET /events?stream= replaces the stream of that name", () => {
  it("a desktop door and a tab redialling four times: every dial admitted, each predecessor ended", async () => {
    const { db, deps } = await makeDeps();
    const tab = await seedSession(db, { now: FIXED_NOW });
    const desk = await seedSessionFor(db, { accountId: tab.accountId, userId: tab.userId, now: FIXED_NOW });
    const dial = (token: string, name: string) => H(req("GET", `/events?stream=${name}`, { bearer: token }), deps, CFG);
    const door = await openTab(await dial(desk.token, "cloud-door"), true);
    const tabs = [];
    for (let i = 0; i < 4; i++) {
      const res = await dial(tab.token, "0123456789abcdef0123456789abcdef");
      expect(res.status, `dial ${i + 1} was refused`).toBe(200);
      tabs.push(await openTab(res, true));
    }
    await sleep(20);
    expect(tabs.slice(0, 3).map((t) => t.ended()), "a replaced stream kept running").toEqual([true, true, true]);
    expect(tabs.slice(0, 3).every((t) => t.text().includes("retry: 30000"))).toBe(true);
    expect([tabs[3]!.ended(), door.ended()]).toEqual([false, false]);
    expect(countFor(tab.accountId)).toBe(2);
  });

  it("CONTROL: the same name from another session of the account, or from another account, ends nothing", async () => {
    const { db, deps } = await makeDeps();
    const a = await seedSession(db, { now: FIXED_NOW });
    const a2 = await seedSessionFor(db, { accountId: a.accountId, userId: a.userId, now: FIXED_NOW });
    const b = await seedSession(db, { now: FIXED_NOW });
    const open = async (token: string) => openTab(await H(req("GET", "/events?stream=same", { bearer: token }), deps, CFG), true);
    const streams = [await open(a.token), await open(a2.token), await open(b.token)];
    await sleep(20);
    expect(streams.map((t) => t.ended()), "a name reached another session's stream").toEqual([false, false, false]);
    expect([countFor(a.accountId), countFor(b.accountId)]).toEqual([2, 1]);
  });

  it("CONTROL: a 65-character name names nothing: below the cap, the session's second dial ends nothing", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const open = () => H(req("GET", `/events?stream=${"x".repeat(65)}`, { bearer: s.token }), deps, CFG);
    const tabs = [await openTab(await open(), true), await openTab(await open(), true)];
    await sleep(20);
    expect(tabs.map((t) => t.ended())).toEqual([false, false]);
    expect(countFor(s.accountId)).toBe(2);
  });
});

/**
 * A CLIENT'S RE-DIAL IS NEVER REFUSED BY ITS OWN EARLIER STREAM. A reloaded page dials under a new
 * name, and on Cloud the page it left is heard late (the abort lands after the new dial) or never.
 * At the cap, a dial supersedes the oldest stream of the session holding the most (its own on a
 * tie) when that session holds two or more; a 429 only when the cap is that many devices, one
 * stream each. Every case keeps another account's stream as a canary.
 */
describe("GET /events at the account cap supersedes a session's own earlier stream", () => {
  const SLOW: SseConfig = { ...CFG, heartbeatMs: 60_000 };
  type Tab = { status: number; text: () => string; ended: () => boolean; leave: () => void };
  async function dial(d: ApiDeps, token: string, path = "/events", sse: SseConfig = SLOW): Promise<Tab> {
    const ac = new AbortController();
    const res = await H(new Request(req("GET", path, { bearer: token }), { signal: ac.signal }), d, sse);
    if (res.status !== 200) return { status: res.status, text: () => "", ended: () => true, leave: () => ac.abort() };
    const t = await openTab(res, true);
    return { status: 200, text: t.text, ended: t.ended, leave: () => ac.abort() };
  }
  async function account(n: number) {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const other = await seedSession(db, { now: FIXED_NOW });
    const canary = await dial(deps, other.token);
    return { deps, s, tokens: [s.token, ...(await devices(db, s, n - 1))], other, canary };
  }
  /** The `sse_stream_superseded` lines a real logger writes. */
  const superseding = () => {
    const raw: string[] = [];
    const logger = createLogger({ service: "api", level: "debug", sink: (l) => { raw.push(l); } });
    const lines = () => raw.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === "sse_stream_superseded");
    return { logger, lines, raw: () => raw.join("\n") };
  };
  const canaryHolds = (c: { canary: Tab; other: { accountId: string } }): void => {
    expect(c.canary.ended(), "another account's stream was ended").toBe(false);
    expect(countFor(c.other.accountId)).toBe(1);
  };

  it("a tab reloaded twice whose old pages were never heard leaving: every dial admitted", async () => {
    const c = await account(3);
    const [w, w2, d] = c.tokens as [string, string, string];
    const order: Array<[string, string]> = [[d, "cloud-door"], [w, "page1"], [w2, "pageA"], [w, "page2"], [w, "page3"]];
    const tabs: Tab[] = [];
    for (const [token, name] of order) {
      tabs.push(await dial(c.deps, token, `/events?stream=${name}`));
      expect(countFor(c.s.accountId)).toBeLessThanOrEqual(4);
    }
    await sleep(20);
    expect(tabs.map((t) => t.status)).toEqual([200, 200, 200, 200, 200]);
    expect(tabs.map((t) => t.ended())).toEqual([false, true, false, false, false]);
    expect(tabs[1]!.text()).toContain("retry: 30000");
    expect(countFor(c.s.accountId)).toBe(4);
    canaryHolds(c);
  });

  it("two tabs reloading back to back, their old pages' aborts landing after the new dials", async () => {
    const c = await account(3);
    const [w, w2, d] = c.tokens as [string, string, string];
    const desk = await dial(c.deps, d, "/events?stream=cloud-door");
    const p1 = await dial(c.deps, w, "/events?stream=p1");
    const a1 = await dial(c.deps, w2, "/events?stream=a1");
    const p2 = await dial(c.deps, w, "/events?stream=p2");
    const a2 = await dial(c.deps, w2, "/events?stream=a2");
    expect([desk, p1, a1, p2, a2].map((t) => t.status)).toEqual([200, 200, 200, 200, 200]);
    p1.leave();
    a1.leave();
    await sleep(20);
    const live = [desk, p1, a1, p2, a2].filter((t) => !t.ended()).length;
    expect(live).toBe(3);
    expect(countFor(c.s.accountId)).toBe(live);
    expect(sseLiveCounts().total).toBe(live + 1);
    canaryHolds(c);
  });

  it("three devices over four rounds, aborts before, after or never: never a 429, exact counts", async () => {
    for (const when of ["before", "after", "never"] as const) {
      const c = await account(3);
      const [w, w2, d] = c.tokens as [string, string, string];
      let tabs = [await dial(c.deps, d, "/events?stream=cloud-door"), await dial(c.deps, w, "/events?stream=p0"), await dial(c.deps, w2, "/events?stream=q0")];
      for (let i = 1; i <= 4; i++) {
        const old = tabs;
        if (when === "before") old.forEach((t) => t.leave());
        tabs = [await dial(c.deps, d, "/events?stream=cloud-door"), await dial(c.deps, w, `/events?stream=p${i}`), await dial(c.deps, w2, `/events?stream=q${i}`)];
        expect(tabs.map((t) => t.status), `${when}, round ${i}`).toEqual([200, 200, 200]);
        expect(countFor(c.s.accountId)).toBeLessThanOrEqual(4);
        if (when === "after") old.forEach((t) => t.leave());
      }
      await sleep(20);
      expect(tabs.map((t) => t.ended()), `${when}: a current page was ended`).toEqual([false, false, false]);
      if (when !== "never") expect(countFor(c.s.accountId)).toBe(3);
      else expect(countFor(c.s.accountId)).toBe(4);
      expect(sseLiveCounts().total).toBe(countFor(c.s.accountId) + 1);
      canaryHolds(c);
      await Promise.all(readers.splice(0).map((r) => r.cancel().catch(() => {})));
      resetSseCounters();
    }
  });

  it("a session holding the whole cap dials again: admitted, its oldest stream ended", async () => {
    const c = await account(1);
    const log = superseding();
    const tabs: Tab[] = [];
    for (let i = 0; i < 5; i++) tabs.push(await dial({ ...c.deps, logger: log.logger }, c.s.token));
    await sleep(20);
    expect(tabs.map((t) => t.status)).toEqual([200, 200, 200, 200, 200]);
    expect(tabs.map((t) => t.ended())).toEqual([true, false, false, false, false]);
    expect(tabs[0]!.text()).toContain("retry: 30000");
    expect(countFor(c.s.accountId)).toBe(4);
    expect(log.lines()).toMatchObject([{ level: "info", own: true }]);
    expect(log.raw()).not.toContain(c.s.accountId);
    canaryHolds(c);
  });

  it("CONTROL: four devices with one stream each: a fifth device is refused and nothing ends", async () => {
    const c = await account(5);
    const tabs: Tab[] = [];
    for (let i = 0; i < 4; i++) tabs.push(await dial(c.deps, c.tokens[i]!));
    const fifth = await dial(c.deps, c.tokens[4]!);
    await sleep(20);
    expect(fifth.status).toBe(429);
    expect(tabs.map((t) => t.ended())).toEqual([false, false, false, false]);
    expect(countFor(c.s.accountId)).toBe(4);
    canaryHolds(c);
  });

  it("a new device takes the oldest stream of a session holding two; one-stream sessions keep theirs", async () => {
    const c = await account(4);
    const [a, b, d, e] = c.tokens as [string, string, string, string];
    const tabs = [await dial(c.deps, a), await dial(c.deps, a), await dial(c.deps, b), await dial(c.deps, d)];
    const log = superseding();
    const fifth = await dial({ ...c.deps, logger: log.logger }, e);
    await sleep(20);
    expect(fifth.status).toBe(200);
    expect(log.lines()).toMatchObject([{ own: false }]);
    expect(tabs.map((t) => t.ended())).toEqual([true, false, false, false]);
    expect(tabs[0]!.text()).toContain("retry: 30000");
    expect(countFor(c.s.accountId)).toBe(4);
    canaryHolds(c);
  });

  it("a superseding dial is admitted at the instance cap; another account is still refused 503", async () => {
    const { db, deps } = await makeDeps();
    const a = await seedSession(db, { now: FIXED_NOW });
    const b = await seedSession(db, { now: FIXED_NOW });
    const cfg: SseConfig = { ...SLOW, maxPerAccount: 2, maxPerInstance: 2 };
    const first = [await dial(deps, a.token, "/events", cfg), await dial(deps, a.token, "/events", cfg)];
    const third = await dial(deps, a.token, "/events", cfg);
    const other = await dial(deps, b.token, "/events", cfg);
    await sleep(20);
    expect([third.status, other.status]).toEqual([200, 503]);
    expect(first.map((t) => t.ended())).toEqual([true, false]);
    expect(sseLiveCounts()).toEqual({ total: 2, byAccount: { [a.accountId]: 2 } });
  });
});
