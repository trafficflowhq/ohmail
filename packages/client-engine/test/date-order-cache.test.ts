import type { EngineMessage, Folder, TagEntity as TagDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  messagesByDateDesc,
  messagesIn,
  tagsCrossView,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * THE SHARED DATE ORDER — one whole-mirror sort per (reader, version), filtered by everyone.
 *
 * Every whole-mirror selector used to end in its own `.sort(byDateDesc)`, so one version bump
 * paid the same sort roughly eight times — the dominant term of the long task a scroll-time
 * read-mark produced on a mailbox tens of thousands deep. These tests own the cache's two
 * dangerous properties: it must actually CACHE (same array identity within a version — the
 * whole point), and it must never serve a STALE version (the failure that would show a
 * mutation's echo to some selectors and not others).
 */

let seq = 0;

function msg(o: { id: string; date: string; folder?: string; labels?: string[] }): EngineMessage {
  return {
    id: o.id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${o.id}`,
    from: { name: null, address: `${o.id}@example.com` },
    to: [],
    cc: [],
    date: o.date,
    folder: (o.folder ?? "ohmail/News") as Folder,
    snippet: `snippet ${o.id}`,
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: o.labels ?? [],
    remoteContent: "none",
    updatedAt: o.date,
  };
}

const change = (m: EngineMessage): SyncChange =>
  ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m }) as SyncChange;

async function mirrorOf(messages: EngineMessage[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(messages.map(change));
  return store;
}

/** Shuffled construction order, so the sort is doing real work. */
const pile = [
  msg({ id: "c", date: "2026-08-03T09:00:00.000Z" }),
  msg({ id: "a", date: "2026-08-09T09:00:00.000Z", folder: "INBOX" }),
  msg({ id: "d", date: "2026-08-01T09:00:00.000Z", labels: ["t1"] }),
  msg({ id: "b", date: "2026-08-07T09:00:00.000Z", labels: ["t1"] }),
  // A DATE TIE with "c" — the pair that catches an order divergence between
  // sort-the-subset and filter-the-sorted-whole.
  msg({ id: "c2", date: "2026-08-03T09:00:00.000Z" }),
];

describe("messagesByDateDesc", () => {
  it("sorts the whole mirror newest first", async () => {
    const store = await mirrorOf(pile);
    expect(messagesByDateDesc(store).map((m) => m.id)).toEqual(["a", "b", "c2", "c", "d"]);
  });

  it("CACHES within a version — same reader, same version, same array identity", async () => {
    const store = await mirrorOf(pile);
    const first = messagesByDateDesc(store);
    expect(messagesByDateDesc(store)).toBe(first);
  });

  it("never serves a stale version: a bump re-derives and the new row is present, in place", async () => {
    const store = await mirrorOf(pile);
    const before = messagesByDateDesc(store);
    await store.applyChanges([change(msg({ id: "e", date: "2026-08-08T09:00:00.000Z" }))]);
    const after = messagesByDateDesc(store);
    expect(after).not.toBe(before);
    expect(after.map((m) => m.id)).toEqual(["a", "e", "b", "c2", "c", "d"]);
    // …and the stale copy was not mutated in place (a filter of it elsewhere must stay sane).
    expect(before.map((m) => m.id)).toEqual(["a", "b", "c2", "c", "d"]);
  });

  it("messagesIn is the shared order filtered — including the tie pair's relative order", async () => {
    const store = await mirrorOf(pile);
    expect(messagesIn(store, "ohmail/News" as Folder).map((m) => m.id)).toEqual(["b", "c2", "c", "d"]);
    expect(messagesIn(store, "INBOX" as Folder).map((m) => m.id)).toEqual(["a"]);
  });

  it("tagsCrossView rides the shared order per tag", async () => {
    const store = await mirrorOf(pile);
    await store.applyChanges([
      { type: "tag", op: "create", id: "t1", seq: ++seq, updatedAt: "2026-08-09T09:00:00.000Z", entity: { id: "t1", name: "one", hue: "moss" } as unknown as TagDTO } as SyncChange,
    ]);
    const groups = tagsCrossView(store);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.messages.map((m) => m.id)).toEqual(["b", "d"]);
  });
});

describe("the repair path (order-invariant bumps skip the sort)", () => {
  it("a field-only update keeps the order and serves the UPDATED entities", async () => {
    const store = await mirrorOf(pile);
    messagesByDateDesc(store); // prime
    const updated = { ...msg({ id: "b", date: "2026-08-07T09:00:00.000Z", labels: ["t1"] }), unread: true };
    await store.applyChanges([
      { type: "message", op: "update", id: "b", seq: ++seq, updatedAt: updated.updatedAt, entity: updated } as SyncChange,
    ]);
    const after = messagesByDateDesc(store);
    expect(after.map((m) => m.id)).toEqual(["a", "b", "c2", "c", "d"]);
    // The repaired order must carry the NEW row, not the cached copy — a stale entity here
    // would show a mutation's echo to some selectors and not others.
    expect(after.find((m) => m.id === "b")!.unread).toBe(true);
  });

  it("a DATE change falls through to the sort and re-orders", async () => {
    const store = await mirrorOf(pile);
    messagesByDateDesc(store); // prime
    const moved = msg({ id: "d", date: "2026-08-10T09:00:00.000Z" });
    await store.applyChanges([
      { type: "message", op: "update", id: "d", seq: ++seq, updatedAt: moved.updatedAt, entity: moved } as SyncChange,
    ]);
    expect(messagesByDateDesc(store).map((m) => m.id)).toEqual(["d", "a", "b", "c2", "c"]);
  });

  it("a SORT-INSTANT change falls through to the sort and re-orders (FIX-020)", async () => {
    // The repair path used to verify membership and `date` alone, so a delta that brought or
    // moved `sortAt` while the header stood was "repaired" into the stale order.
    const store = await mirrorOf(pile);
    messagesByDateDesc(store); // prime
    const clamped = { ...msg({ id: "d", date: "2026-08-01T09:00:00.000Z" }), sortAt: "2026-08-10T09:00:00.000Z" };
    await store.applyChanges([
      { type: "message", op: "update", id: "d", seq: ++seq, updatedAt: clamped.updatedAt, entity: clamped } as SyncChange,
    ]);
    expect(messagesByDateDesc(store).map((m) => m.id)).toEqual(["d", "a", "b", "c2", "c"]);
  });

  it("a removal falls through to the sort", async () => {
    const store = await mirrorOf(pile);
    messagesByDateDesc(store); // prime
    await store.applyChanges([
      { type: "message", op: "delete", id: "b", seq: ++seq, updatedAt: "2026-08-10T09:00:00.000Z" } as SyncChange,
    ]);
    expect(messagesByDateDesc(store).map((m) => m.id)).toEqual(["a", "c2", "c", "d"]);
  });
});
