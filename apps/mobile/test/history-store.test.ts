import type { EngineMessage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncResponse,
} from "@ohmail/client-engine";
import { hydrateOffMirror, liveMessage, openOffMirror, storeRowOf, type WorldView } from "../src/state/live";

/**
 * THE PHONE'S HISTORY AND SEARCH READ THE STORE (ARCHIVE-024): a store row is a phone row with the
 * mirror's live row preferred, a row the mirror does not hold opens in the reader with its body
 * read on open and never written, and both screens are bound to the store's doors, not the mirror.
 */

const NOW = new Date("2026-09-23T12:00:00.000Z");
const v: WorldView = { now: NOW, zone: "UTC" };
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

function msg(id: string, over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: `Subject ${id}`,
    from: { name: null, address: "x@example.test" }, to: [], cc: [], date: "2011-06-01T08:00:00.000Z",
    folder: "Archive/2011" as EngineMessage["folder"], snippet: "the first words", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2011-06-01T08:00:00.000Z", ...over,
  };
}

async function engineWith(mirror: EngineMessage[], bodies: Record<string, string>): Promise<{ engine: OhmailEngine; asked: string[] }> {
  const asked: string[] = [];
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(mirror.map((m, i) => ({ type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: m.updatedAt, entity: m })));
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async () => ({ changes: [], seq: null }),
    fetchBody: async (id: string) => {
      asked.push(id);
      return { text: bodies[id] ?? "", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null };
    },
  } as unknown as EngineAdapter;
  return { engine: new OhmailEngine({ adapter, store, now: () => NOW }), asked };
}

describe("a store row on the phone", () => {
  it("takes the mirror's live row where it has one, and a History row names its folder", async () => {
    const { engine } = await engineWith([msg("m1", { unread: true })], {});
    const row = storeRowOf(engine, msg("m1", { unread: false }), v, true);
    expect(row.unread).toBe(true);
    expect(row.historyPlace).toBe("Archive/2011");
    expect(storeRowOf(engine, msg("m2"), v, false).historyPlace).toBeUndefined();
  });

  it("the first message opens in the reader with its body read on open — never into the mirror", async () => {
    const { engine, asked } = await engineWith([], { first: "The very first message's whole text." });
    const first = msg("first", { subject: "the very first message" });
    expect(liveMessage(engine, "first", v)).toBeUndefined();
    openOffMirror(first);
    expect(liveMessage(engine, "first", v)?.subject).toBe("the very first message");
    expect(hydrateOffMirror(engine, "first")).toBe(true);
    expect(liveMessage(engine, "first", v)?.bodyState).toBe("loading");
    await new Promise((r) => setTimeout(r, 0));
    const open = liveMessage(engine, "first", v)!;
    expect(open.bodyState).toBe("full");
    expect(open.body).toBe("The very first message's whole text.");
    expect(asked).toEqual(["first"]);
    // Nothing was written: the mirror holds neither the row nor its body.
    expect(engine.read().list("message").length).toBe(0);
    expect(engine.read().list("message_body").length).toBe(0);
    // A second open of the same row asks nothing more.
    expect(hydrateOffMirror(engine, "first")).toBe(true);
    expect(asked).toEqual(["first"]);
  });

  it("a mirror row takes the engine's own body path, not the off-mirror one", async () => {
    const { engine } = await engineWith([msg("here")], {});
    openOffMirror(msg("here"));
    expect(hydrateOffMirror(engine, "here")).toBe(false);
  });
});

describe("both screens are bound to the store's doors", () => {
  it("History is the paged timeline: the walker's slots, each at its row's measured height, the year strip", () => {
    const src = read("../app/history.tsx");
    expect(src).toContain("useStoreHistory()");
    expect(src).toContain("<MailList");
    expect(src).toContain('height: m === "gone" ? 0 : heights.heightOf(i),');
    expect(src).toContain("if (heights.record(i, height)) redraw();");
    // The press goes through History's asks, which hand the walker the jump (history-asks.ts).
    expect(src).toContain("asks.jumped(h, start, viewport.current, h.length)");
    expect(src).not.toMatch(/w\.history\b|liveHistory|storeWindow/);
  });

  it("Search replaces the device's paint with the store's page and pages on scroll", () => {
    const src = read("../app/search.tsx");
    expect(src).toContain("useStoreSearch(");
    expect(src).toContain("store.loadMore()");
    expect(src).not.toContain("searchScopeDevice");
  });
});
