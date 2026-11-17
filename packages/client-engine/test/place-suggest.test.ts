import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaceSuggestAnswer } from "@ohmail/wire";
import { HttpAdapter, MemoryMirrorStore, OhmailEngine, type EngineAdapter } from "@ohmail/client-engine";

/**
 * THE APP'S ONE CALL FOR PLACE SUGGESTIONS: a question to the account's server that a newer one
 * gives up, that is never asked while the device is offline, never queued for later and never
 * kept: the store holds nothing of it after it answered.
 */

const ZURICH: PlaceSuggestAnswer = {
  state: "ok", credit: "osm",
  places: [{ kind: "street", first: "Limmatquai", second: "8001 Zürich", country: "CH", lat: 47.3722, lon: 8.5439 }],
};

interface Seen { method: string; url: string; body: unknown; signal: AbortSignal | null }

/** An engine over the real HTTP adapter, whose `fetch` is the test's: it records and answers by hand. */
function rig(answer: (seen: Seen) => Promise<Response> = async () => Response.json(ZURICH)) {
  const seen: Seen[] = [];
  const http = new HttpAdapter({
    baseUrl: "https://api.test",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const one: Seen = {
        method: init?.method ?? "GET", url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal ?? null,
      };
      seen.push(one);
      return answer(one);
    }) as unknown as typeof globalThis.fetch,
  });
  const store = new MemoryMirrorStore();
  const engine = new OhmailEngine({ adapter: http, store });
  return { engine, store, seen };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("(9) the engine's call", () => {
  it("asks once, in the body of a POST, and hands back the server's answer", async () => {
    const r = rig();
    const out = await r.engine.suggestPlaces({ text: "Limmatquai", lang: "de", near: { lat: 47.37, lon: 8.54 }, home: "CH" });
    expect(out).toEqual(ZURICH);
    expect(r.seen.map((s) => [s.method, s.url])).toEqual([["POST", "https://api.test/calendar/places/suggest"]]);
    expect(r.seen[0]!.body).toEqual({ text: "Limmatquai", lang: "de", near: { lat: 47.37, lon: 8.54 }, home: "CH" });
  });

  it("is given up when told: the request is ended and the answer is `stopped`", async () => {
    const r = rig((s) => new Promise<Response>((_resolve, reject) => {
      s.signal?.addEventListener("abort", () => reject(new DOMException("given up", "AbortError")), { once: true });
    }));
    const leave = new AbortController();
    const pending = r.engine.suggestPlaces({ text: "Limmat" }, { signal: leave.signal });
    await vi.waitFor(() => { expect(r.seen).toHaveLength(1); });
    leave.abort();
    expect(await pending).toEqual({ state: "stopped", places: [], credit: null });
    expect(r.seen[0]!.signal?.aborted).toBe(true);
    // A question given up before it was asked is never asked.
    expect(await r.engine.suggestPlaces({ text: "Limmatq" }, { signal: AbortSignal.abort() })).toMatchObject({ state: "stopped" });
    expect(r.seen).toHaveLength(1);
  });

  it("is never made while the device is offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const r = rig();
    expect(await r.engine.suggestPlaces({ text: "Limmatquai" })).toEqual({ state: "offline", places: [], credit: null });
    expect(r.seen).toHaveLength(0);
  });

  it("keeps nothing and queues nothing: the store is as it was, after an answer and after a failure", async () => {
    let fail = false;
    const r = rig(async () => {
      if (fail) throw new TypeError("network down");
      return Response.json(ZURICH);
    });
    await r.store.load();
    const before = JSON.stringify([...r.store.snapshot()]);
    const writes = [
      vi.spyOn(r.store, "putLocal"), vi.spyOn(r.store, "setMeta"), vi.spyOn(r.store, "applyChanges"),
      vi.spyOn(r.store, "applyResponse"), vi.spyOn(r.store, "commitLocal"),
    ];
    expect((await r.engine.suggestPlaces({ text: "Limmatquai" })).state).toBe("ok");
    fail = true;
    expect(await r.engine.suggestPlaces({ text: "Limmatquai" })).toEqual({ state: "failed", places: [], credit: null });
    // Not a record, not a meta value, not an outbox row: nothing a reload could read back or send again.
    for (const w of writes) expect(w).not.toHaveBeenCalled();
    expect(JSON.stringify([...r.store.snapshot()])).toBe(before);
    expect(r.seen).toHaveLength(2);
  });

  it("a server's refusal is `failed`, never a throw", async () => {
    const r = rig(async () => Response.json({ error: { code: "validation_failed", message: "no" } }, { status: 400 }));
    expect(await r.engine.suggestPlaces({ text: "x".repeat(201) })).toEqual({ state: "failed", places: [], credit: null });
  });

  it("an answer the server did not shape as one is `failed` too", async () => {
    const r = rig(async () => Response.json({ state: "ok", places: "Limmatquai" }));
    expect(await r.engine.suggestPlaces({ text: "Limmatquai" })).toEqual({ state: "failed", places: [], credit: null });
  });

  it("an adapter with no such call is `off`, and asks nothing", async () => {
    const adapter: EngineAdapter = {
      sync: async () => { throw new Error("not asked"); },
      mutate: async () => { throw new Error("not asked"); },
      fetchBody: async () => null,
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
    };
    const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore() });
    expect(await engine.suggestPlaces({ text: "Limmatquai" })).toEqual({ state: "off", places: [], credit: null });
  });
});
