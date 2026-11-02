import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, apiRoutes, DEFAULT_SSE, type ApiDeps, type SseConfig } from "@trafficflow/api";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * A stream proves it is live by FRAMES, never by its headers: `ready` once subscribed, a named
 * `ping` heartbeat, and the two headers that keep a compressing or buffering hop from holding
 * them. The last arm reads the frames through a real EventSource, as the 0.25.17 client's
 * listener set (open, sync, error) and as the new one.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps, sse: SseConfig): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null, sse });

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** Read until `needle` appears or the stream ends; then cancel. */
async function readUntil(res: Response, needle: string): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  while (!text.includes(needle)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  await reader.cancel();
  return text;
}

describe("GET /events proves it is live by frames", () => {
  it("beats every 15 s: the web client closes a stream silent for twice that (WAKE_STREAM_SILENCE_MS)", () => {
    expect(DEFAULT_SSE.heartbeatMs).toBe(15_000);
  });

  it("sends no-transform and X-Accel-Buffering: no", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("GET", "/events", { bearer: s.token }), deps,
      { heartbeatMs: 3_600_000, pollMs: 60_000, lifetimeMs: 100 });
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    await res.body!.cancel();
  });

  it("sends a named ready frame at once, before any heartbeat, and a named ping on the heartbeat", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const started = Date.now();
    const quiet = await H(req("GET", "/events", { bearer: s.token }), deps,
      { heartbeatMs: 3_600_000, pollMs: 60_000, lifetimeMs: 1_500 });
    const first = await readUntil(quiet, "event: ready\ndata: {}\n\n");
    expect(first).toContain("event: ready\ndata: {}\n\n");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(first).not.toContain("ping");
    const beating = await H(req("GET", "/events", { bearer: s.token }), deps,
      { heartbeatMs: 20, pollMs: 60_000, lifetimeMs: 1_500 });
    expect(await readUntil(beating, "event: ping\ndata: {}\n\n")).toContain("event: ping\ndata: {}\n\n");
  });

  it("an EventSource hears ready and ping only through listeners for them; the 0.25.17 set hears sync alone", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const sse: SseConfig = { heartbeatMs: 100, pollMs: 20, lifetimeMs: 60_000 };
    // No timers decide what is heard: the change waits for both streams' ready frame (both
    // subscribed), and each stream ends once it has carried the change and three heartbeats after it.
    let subscribed = 0;
    let bothSubscribed!: () => void;
    const subscribedBoth = new Promise<void>((r) => { bothSubscribed = r; });
    const server = createServer((_in, out) => {
      void (async () => {
        const res = await H(req("GET", "/events", { bearer: s.token }), deps, sse);
        out.writeHead(res.status, Object.fromEntries(res.headers));
        const reader = res.body!.getReader();
        out.on("close", () => { void reader.cancel(); });
        const dec = new TextDecoder();
        let text = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          out.write(value);
          const was = text;
          text += dec.decode(value, { stream: true });
          if (!was.includes("event: ready\n") && text.includes("event: ready\n") && ++subscribed === 2) bothSubscribed();
          const afterChange = text.split("event: sync\n")[1];
          if (afterChange !== undefined && afterChange.split("event: ping\ndata: {}\n\n").length > 3) {
            await reader.cancel();
            break;
          }
        }
        out.end();
      })();
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
    const child = fileURLToPath(new URL("./eventsource-child.fixture.mjs", import.meta.url));
    const listen = (types: string[]): Promise<string[]> => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ["--no-warnings", "--experimental-eventsource", child, url, JSON.stringify(types), "15000"]);
      let out = "";
      p.stdout.on("data", (b: Buffer) => { out += b.toString(); });
      p.on("error", reject);
      p.on("close", (code) => {
        if (code !== 0) { reject(new Error(`child rc ${code}`)); return; }
        resolve((JSON.parse(out.trim()) as { heard: string[] }).heard);
      });
    });
    const heard = Promise.all([
      listen(["open", "sync", "error"]),
      listen(["open", "ready", "ping", "sync", "error"]),
    ]);
    // A change while both listen: one sync each.
    const endedEarly = heard.then(() => { if (subscribed < 2) throw new Error("a listener ended before both subscribed"); });
    endedEarly.catch(() => {});   // read by the race below; `heard` itself is awaited after it
    await Promise.race([subscribedBoth, endedEarly]);
    await H(req("POST", "/rules", { bearer: s.token, body: JSON.stringify({ kind: "sender", match: "x@y.example", destination: "INBOX" }) }),
      deps, sse);
    const [shipped, current] = await heard;
    // The last `error` is the stream's end, which the server writes; nothing else errs.
    expect(shipped.filter((t) => t !== "open")).toEqual(["sync", "error"]);
    expect(shipped).not.toContain("message");
    expect(current[0]).toBe("open");
    expect(current[1]).toBe("ready");
    expect(current.filter((t) => t === "ping").length).toBeGreaterThan(2);
    expect(current.filter((t) => t === "sync")).toEqual(["sync"]);
    expect(current.filter((t) => t === "error")).toEqual(["error"]);
    expect(current.at(-1)).toBe("error");
    expect(current).not.toContain("message");
  }, 20_000);
});
