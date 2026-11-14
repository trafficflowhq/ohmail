/**
 * THE BRIDGE, OVER DOUBLES OF BOTH SIDES. The page's client (`web/src/bridge.ts`) against a native
 * double that joins pieces the way the native module does and answers through the same framing the
 * app's native side uses. A body crosses whole in both directions whatever its size; an answer of
 * another epoch never reaches this page; a request the page stops waiting for is cancelled.
 */
import { describe, expect, it } from "vitest";
import { PIECE_BYTES, readRequest } from "../src/shell/bridge-kinds";
import { framesOf, Joiner } from "../src/shell/framing";
import { BridgeRefused, createBridge } from "../web/src/bridge";
import type { PagePort } from "../web/src/port";

/** A native double: joins what the page posts, answers with `reply`, frames what it sends. */
function nativeDouble(epoch: string, reply: (req: Record<string, unknown>) => object | null) {
  const toPage = new Set<(text: string) => void>();
  const seen: Record<string, unknown>[] = [];
  const joiner = new Joiner(epoch);
  let frames = 0;
  const deliver = (text: string) => queueMicrotask(() => toPage.forEach((take) => take(text)));
  const port: PagePort = {
    post(text) {
      frames += 1;
      let m = JSON.parse(text) as Record<string, unknown>;
      if (m.kind === "piece" || m.kind === "joined") {
        const whole = joiner.take(m);
        if (whole === null) return;
        m = JSON.parse(whole) as Record<string, unknown>;
      }
      const req = readRequest(m);
      if ("refused" in req) throw new Error(`the guard refused a page request: ${req.refused}`);
      seen.push(m);
      const answer = reply(m);
      if (answer === null) return;
      const text2 = JSON.stringify({ ...answer, id: m.id, epoch: (answer as { epoch?: string }).epoch ?? epoch });
      for (const f of framesOf(text2, m.id as number, epoch)) deliver(f);
    },
    listen(take) {
      toPage.add(take);
      return () => toPage.delete(take);
    },
  };
  return { port, seen, frames: () => frames, send: deliver };
}

/** Every byte value, over and over, to `n` bytes. */
function everyByte(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = i % 256;
  return out;
}
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const bytesOf = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

describe("the bridge between the page and the native side", () => {
  it("carries a 1 MB body of every byte value to native and back, whole", async () => {
    const sent = everyByte(1024 * 1024);
    const native = nativeDouble("e1", (req) => ({
      ok: true, status: 200, headers: [["content-type", "application/octet-stream"]],
      body: (req.body as { as: string; b64: string }),
    }));
    const bridge = createBridge(native.port, "e1");
    const answer = await bridge.request("http", {
      scope: "p0", method: "PUT", path: "/files/a1", headers: [["content-type", "application/octet-stream"]],
      body: { as: "b64", b64: b64(sent) },
    });
    expect(native.frames()).toBeGreaterThan(Math.ceil((sent.length * 4) / 3 / PIECE_BYTES));
    expect(native.seen[0]).toMatchObject({ kind: "http", path: "/files/a1" });
    expect(answer.status).toBe(200);
    const back = answer.body;
    expect(back?.as).toBe("b64");
    expect(bytesOf((back as { b64: string }).b64)).toEqual(sent);
  });

  it("drops an answer or an event of another epoch; this page's own arrive", async () => {
    const native = nativeDouble("e2", () => null);
    let now = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const bridge = createBridge(native.port, "e2", {
      setTimeout: (fn, ms) => timers.push({ at: now + ms, fn }),
      clearTimeout: () => {},
    });
    const events: string[] = [];
    bridge.on((e) => events.push(e.type));
    const asked = bridge.request("config", {}, { deadlineMs: 1000 });
    native.send(JSON.stringify({ id: 1, epoch: "e-old", ok: true, scope: "p1" }));
    native.send(JSON.stringify({ type: "network", epoch: "e-old", online: false }));
    native.send(JSON.stringify({ type: "network", epoch: "e2", online: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["network"]);
    expect(bridge.dropped()).toBe(2);
    native.send(JSON.stringify({ id: 1, epoch: "e2", ok: true, scope: "p2" }));
    await expect(asked).resolves.toMatchObject({ scope: "p2" });
  });

  it("cancels a request the page stops waiting for, by abort or by its deadline", async () => {
    const native = nativeDouble("e3", () => null);
    const fire: (() => void)[] = [];
    const bridge = createBridge(native.port, "e3", { setTimeout: (fn) => fire.push(fn), clearTimeout: () => {} });
    const stop = new AbortController();
    const aborted = bridge.request("http", { scope: "p0", method: "GET", path: "/sync", headers: [], body: null }, { signal: stop.signal });
    stop.abort();
    await expect(aborted).rejects.toEqual(new BridgeRefused("aborted"));
    expect(native.seen.at(-1)).toMatchObject({ kind: "cancel", of: 1 });

    const slow = bridge.request("http", { scope: "p0", method: "GET", path: "/sync", headers: [], body: null });
    fire.at(-1)!();
    await expect(slow).rejects.toEqual(new BridgeRefused("deadline"));
    expect(native.seen.at(-1)).toMatchObject({ kind: "cancel" });
    expect(native.seen.filter((m) => m.kind === "cancel")).toHaveLength(2);
  });

  it("turns a native refusal into a refusal the page can read", async () => {
    const native = nativeDouble("e4", () => ({ ok: false, refused: "notRelayed" }));
    const bridge = createBridge(native.port, "e4");
    await expect(bridge.request("http", { scope: "p0", method: "POST", path: "/auth/logout", headers: [], body: null }))
      .rejects.toEqual(new BridgeRefused("notRelayed"));
  });
});
