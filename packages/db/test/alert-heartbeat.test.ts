import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import net from "node:net";
import {
  alertHeartbeatFor, heartbeatLogLine, ALERT_HEARTBEAT_TIMEOUT_MS, type HeartbeatGet,
} from "../src/alert-heartbeat.js";

/**
 * The optional dead-man heartbeat: one bounded GET after a completed pass, to a check service that
 * alarms when the requests stop. Off when unset, refused when unusable, never rejecting, never
 * longer than its timeout, one request at a time, and nothing in it but the request.
 */

const URL_OK = "https://hc.example/ping/1f2e3d";

function recordingGet(answer: () => Promise<{ status: number }>): HeartbeatGet & { calls: string[] } {
  const calls: string[] = [];
  const get = ((url: string) => { calls.push(url); return answer(); }) as HeartbeatGet & { calls: string[] };
  get.calls = calls;
  return get;
}

afterEach(() => { vi.useRealTimers(); });

describe("arming", () => {
  it("unset or blank is off and never makes a request", () => {
    for (const raw of [undefined, null, "", "   "]) expect(alertHeartbeatFor(raw).state).toBe("off");
  });

  it("quotes, a non-http scheme or a non-URL is refused, named by the variable", () => {
    for (const raw of ['"https://x"', "ftp://hc.example/ping", "not a url", "https://hc.example/a b"]) {
      expect(alertHeartbeatFor(raw)).toEqual({ state: "unusable", configVar: "TF_ALERT_HEARTBEAT_URL" });
    }
  });
});

describe("the ping", () => {
  it("is a GET to the exact URL", async () => {
    const get = recordingGet(async () => ({ status: 200 }));
    const hb = alertHeartbeatFor(` ${URL_OK} `, get);
    if (hb.state !== "on") throw new Error("armed");
    expect(await hb.ping()).toEqual({ state: "ok" });
    expect(get.calls).toEqual([URL_OK]);
  });

  it("a hang ends as timeout within the bound", async () => {
    vi.useFakeTimers();
    const hb = alertHeartbeatFor(URL_OK, recordingGet(() => new Promise(() => undefined)));
    if (hb.state !== "on") throw new Error("armed");
    const p = hb.ping();
    await vi.advanceTimersByTimeAsync(ALERT_HEARTBEAT_TIMEOUT_MS);
    expect(await p).toEqual({ state: "timeout" });
  });

  it("a 503 is refused with its status; a throwing transport is unreachable", async () => {
    const refused = alertHeartbeatFor(URL_OK, recordingGet(async () => ({ status: 503 })));
    const thrown = alertHeartbeatFor(URL_OK, recordingGet(async () => { throw new TypeError("fetch failed"); }));
    if (refused.state !== "on" || thrown.state !== "on") throw new Error("armed");
    expect(await refused.ping()).toEqual({ state: "refused", status: 503 });
    expect(await thrown.ping()).toEqual({ state: "unreachable" });
  });

  it("one request at a time: a ping while one is in flight shares it", async () => {
    let release!: () => void;
    const get = recordingGet(() => new Promise((r) => { release = () => r({ status: 200 }); }));
    const hb = alertHeartbeatFor(URL_OK, get);
    if (hb.state !== "on") throw new Error("armed");
    const a = hb.ping();
    const b = hb.ping();
    release();
    expect(await a).toEqual({ state: "ok" });
    expect(await b).toEqual({ state: "ok" });
    expect(get.calls).toHaveLength(1);
    const c = hb.ping();
    release();
    await c;
    expect(get.calls).toHaveLength(2);
  });
});

describe("the real fetch", () => {
  const servers: Array<Server | net.Server> = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      (s as Server).closeAllConnections?.();
      await new Promise<void>((r) => { s.close(() => r()); });
    }
  });

  it("sends a bare GET with no body to a loopback server", async () => {
    const seen: Array<{ method?: string; url?: string; length: number }> = [];
    const s = createServer((req, res) => {
      let length = 0;
      req.on("data", (c: Buffer) => { length += c.length; });
      req.on("end", () => { seen.push({ method: req.method, url: req.url, length }); res.end("ok"); });
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const port = (s.address() as net.AddressInfo).port;
    const hb = alertHeartbeatFor(`http://127.0.0.1:${port}/ping/abc`);
    if (hb.state !== "on") throw new Error("armed");
    expect(await hb.ping()).toEqual({ state: "ok" });
    expect(seen).toEqual([{ method: "GET", url: "/ping/abc", length: 0 }]);
  });

  it("gives up on a silent server within the bound plus a second", async () => {
    const live = new Set<net.Socket>();
    const s = net.createServer((sock) => { live.add(sock); sock.on("error", () => undefined); });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const port = (s.address() as net.AddressInfo).port;
    const hb = alertHeartbeatFor(`http://127.0.0.1:${port}/`, undefined, 500);
    if (hb.state !== "on") throw new Error("armed");
    const started = Date.now();
    expect(await hb.ping()).toEqual({ state: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_500);
    for (const k of live) k.destroy();
  });
});

describe("the host's log lines", () => {
  it("only changes of state, never the URL", () => {
    const memory = { last: null as string | null };
    expect(heartbeatLogLine(memory, { state: "ok" })).toBeNull();
    expect(heartbeatLogLine(memory, { state: "timeout" })).toEqual({ event: "alert_heartbeat_failed", fields: { state: "timeout" } });
    expect(heartbeatLogLine(memory, { state: "timeout" })).toBeNull();
    expect(heartbeatLogLine(memory, { state: "refused", status: 503 }))
      .toEqual({ event: "alert_heartbeat_failed", fields: { state: "refused", status: 503 } });
    expect(heartbeatLogLine(memory, { state: "ok" })).toEqual({ event: "alert_heartbeat_restored", fields: { state: "ok" } });
  });
});
