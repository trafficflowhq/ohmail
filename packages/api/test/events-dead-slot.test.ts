import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, apiRoutes, type ApiDeps, type SseConfig } from "@trafficflow/api";
import { writeWebResponse } from "@trafficflow/core/adapters/http-host";
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

describe("GET /events frees the slot of a stream nobody reads", () => {
  it("a stream whose frames stop being taken releases its slot within two heartbeats", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await openTab(await H(req("GET", "/events", { bearer: s.token }), deps, CFG), false);
    expect(countFor(s.accountId)).toBe(1);
    await sleep(BOUND + 3 * HB);
    expect(countFor(s.accountId), "a dead stream still holds its slot").toBe(0);
  });

  it("the cap admits a fifth tab once a dead one is reaped", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const open = () => H(req("GET", "/events", { bearer: s.token }), deps, CFG);
    for (let i = 0; i < 3; i++) await openTab(await open(), true);
    await openTab(await open(), false);
    const refused = await open();
    expect(refused.status, "the premise: four streams fill the cap").toBe(429);
    await sleep(BOUND + 3 * HB);
    const fifth = await open();
    expect(fifth.status, "a dead stream kept the fifth tab out").toBe(200);
    await openTab(fifth, true);
    expect(countFor(s.accountId)).toBe(4);
  });

  it("CONTROL: four live tabs keep their slots past the bound, and the fifth is still refused", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const open = () => H(req("GET", "/events", { bearer: s.token }), deps, CFG);
    const tabs = [];
    for (let i = 0; i < 4; i++) tabs.push(await openTab(await open(), true));
    await sleep(BOUND + 4 * HB);
    expect(countFor(s.accountId)).toBe(4);
    expect(tabs.every((t) => t.pings() >= 2), "the live tabs were heard pinging").toBe(true);
    const fifth = await open();
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

  it("CONTROL: a 65-character name names nothing, and the fifth dial is refused", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const open = () => H(req("GET", `/events?stream=${"x".repeat(65)}`, { bearer: s.token }), deps, CFG);
    for (let i = 0; i < 4; i++) await openTab(await open(), true);
    const fifth = await open();
    expect(fifth.status).toBe(429);
    expect((await fifth.json()).error.code).toBe("sse_too_many_streams");
  });
});
