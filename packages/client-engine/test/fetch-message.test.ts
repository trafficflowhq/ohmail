import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  HttpAdapter,
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncResponse,
} from "../src/index.js";

/**
 * ONE MESSAGE BY ID, FROM THE STORE — the door a link to evicted mail needs. `GET /messages/:id`
 * existed on both hosts and nothing in the engine asked it, so an id the window had evicted was
 * classified as nothing and the reader opened nothing on it.
 */

const NOW = new Date("2026-09-27T09:00:00.000Z");
const ID = "00000000-0000-4000-8000-000000000042";

function msg(id: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: "Kept",
    from: { name: null, address: "sender@example.test" }, to: [], cc: [], date: NOW.toISOString(),
    folder: "INBOX", snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}

const base: EngineAdapter = {
  sync: async (): Promise<SyncResponse> => ({
    changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c", hasMore: false, serverTime: NOW.toISOString(),
  }),
  mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
  withdrawSend: async () => ({ outcome: "unsupported" as const }),
  fetchBody: async () => null,
};

describe("fetchMessage", () => {
  it("an adapter with no door says so, never an empty answer", async () => {
    const engine = new OhmailEngine({ adapter: base, store: new MemoryMirrorStore(), now: () => NOW });
    expect(await engine.fetchMessage(ID)).toEqual({ state: "unavailable" });
  });

  it("answers the store's row, and writes nothing into the mirror", async () => {
    const store = new MemoryMirrorStore();
    const engine = new OhmailEngine({
      adapter: { ...base, getMessage: async (id: string) => msg(id) } as EngineAdapter, store, now: () => NOW,
    });
    expect(await engine.fetchMessage(ID)).toEqual({ state: "ready", message: msg(ID) });
    expect(store.get("message", ID), "a row with no seq was written into the mirror").toBeUndefined();
  });

  it("the store's no is `missing`, a refusal is `failed`, and neither rejects", async () => {
    const none = new OhmailEngine({
      adapter: { ...base, getMessage: async () => null } as EngineAdapter, store: new MemoryMirrorStore(), now: () => NOW,
    });
    expect(await none.fetchMessage(ID)).toEqual({ state: "missing" });
    const refused = new OhmailEngine({
      adapter: { ...base, getMessage: async () => { throw new Error("503"); } } as EngineAdapter,
      store: new MemoryMirrorStore(), now: () => NOW,
    });
    expect((await refused.fetchMessage(ID)).state).toBe("failed");
  });

  it("two asks for one id are one request", async () => {
    let asked = 0;
    const engine = new OhmailEngine({
      adapter: { ...base, getMessage: async (id: string) => { asked += 1; return msg(id); } } as EngineAdapter,
      store: new MemoryMirrorStore(), now: () => NOW,
    });
    await Promise.all([engine.fetchMessage(ID), engine.fetchMessage(ID)]);
    expect(asked).toBe(1);
  });
});

describe("the HTTP adapter's door", () => {
  const answer = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("asks `GET /messages/:id` and reads a 404 as none", async () => {
    const calls: string[] = [];
    const found = new HttpAdapter({ baseUrl: "/api", fetch: async (url) => { calls.push(url); return answer(200, msg(ID)); } });
    expect((await found.getMessage(ID))?.id).toBe(ID);
    expect(calls).toEqual([`/api/messages/${ID}`]);
    const gone = new HttpAdapter({ baseUrl: "/api", fetch: async () => answer(404, { code: "not_found" }) });
    expect(await gone.getMessage(ID)).toBeNull();
  });

  it("any other refusal throws, so the engine can tell it from none", async () => {
    const down = new HttpAdapter({ baseUrl: "/api", fetch: async () => answer(500, { code: "internal" }) });
    await expect(down.getMessage(ID)).rejects.toBeTruthy();
  });
});
