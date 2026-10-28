import { describe, expect, it } from "vitest";
import {
  FEED_SINCE_ID,
  MemoryMirrorStore,
  feedPartition,
  waterlineIdOf,
  type EngineMessage,
  type Folder,
  type SyncChange,
  type WaterlineMeta,
} from "@ohmail/client-engine";

/**
 * THE WARM-IMPORT PARTITION — before any visit, an unread letter is new until it is read.
 *
 * A live mirror has NO waterline row until the first leave-commit writes one (`/sync` has no
 * `view_meta` entity type). Before that first visit nothing is cut: a News pile imported with
 * unread letters names them on the first visit ("8 new since you were here"), and the rail says
 * the same number. It once read "Nothing new" over them. Read state never places the line: a
 * junction at "the newest already-read message" let a read letter moved in on top zero the badge
 * over unread mail. No line is drawn.
 */

let seq = 0;

function msg(o: { id: string; date: string; unread: boolean; folder?: string }): EngineMessage {
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
    unread: o.unread,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: o.date,
  };
}

async function mirrorOf(
  messages: EngineMessage[],
  waterline?: { view: "reads" | "receipts"; meta: WaterlineMeta },
): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  const changes = messages.map((m) => ({
    type: "message",
    op: "create",
    id: m.id,
    seq: ++seq,
    updatedAt: m.updatedAt,
    entity: m,
  })) as SyncChange[];
  await store.applyChanges(changes);
  if (waterline) await store.putLocal("view_meta", waterlineIdOf(waterline.view), waterline.meta);
  return store;
}

/** The mirror after this device's first completed sync, at `iso` (the engine's drain records it). */
async function importedAt(messages: EngineMessage[], iso: string): Promise<MemoryMirrorStore> {
  const store = await mirrorOf(messages);
  await store.putLocal("view_meta", FEED_SINCE_ID, { at: iso });
  return store;
}

/** Newest-first dates — d(0) is the newest, matching `messagesIn`'s byDateDesc order. */
const d = (i: number): string => `2026-08-${String(10 - i).padStart(2, "0")}${"T"}09:00:00.000Z`;

describe("no visit yet (a mirror built from an existing mailbox)", () => {
  it("an imported pile names its unread letters on the first visit, and draws no line", async () => {
    // A warm pile, interleaved exactly as a real mailbox is; all of it predates the first sync.
    const pile = [
      msg({ id: "new1", date: d(0), unread: true }),
      msg({ id: "read1", date: d(1), unread: false }),
      msg({ id: "skip1", date: d(2), unread: true }),
      msg({ id: "read2", date: d(3), unread: false }),
    ];
    const part = feedPartition(await importedAt(pile, d(-1)), "reads");
    expect(part.waterline).toBeNull();
    // The report: "Nothing new" over unread letters present at setup. Read mail is not new.
    expect(part.newCount).toBe(2);
    expect(part.fresh.map((m) => m.id)).toEqual(["new1", "read1", "skip1", "read2"]);
  });

  it("an unread letter counts whether it came before or after the first sync", async () => {
    const pile = [
      msg({ id: "new2", date: d(0), unread: true }),
      msg({ id: "new1", date: d(1), unread: true }),
      msg({ id: "read1", date: d(2), unread: false }),
      msg({ id: "old1", date: d(3), unread: true }),
    ];
    const part = feedPartition(await importedAt(pile, d(2)), "reads");
    expect(part.newCount).toBe(3);
    expect(part.seen).toEqual([]);
    expect(part.waterline).toBeNull();
  });

  it("an all-read import is 'nothing new'", async () => {
    const pile = [
      msg({ id: "read1", date: d(0), unread: false }),
      msg({ id: "read2", date: d(1), unread: false }),
    ];
    const part = feedPartition(await importedAt(pile, d(-1)), "reads");
    expect(part.newCount).toBe(0);
    expect(part.waterline).toBeNull();
  });

  it("before the first sync completes nothing is cut (the demo's receipts, whose sync predates its mail)", async () => {
    const pile = [
      msg({ id: "u1", date: d(0), unread: true, folder: "ohmail/Receipts" }),
      msg({ id: "u2", date: d(1), unread: true, folder: "ohmail/Receipts" }),
    ];
    const part = feedPartition(await mirrorOf(pile), "receipts");
    expect(part.waterline).toBeNull();
    expect(part.fresh.map((m) => m.id)).toEqual(["u1", "u2"]);
    expect(part.seen).toEqual([]);
  });

  it("the cut is positional: [...fresh, ...seen] is the pile's display order", async () => {
    const pile = [
      msg({ id: "a", date: d(0), unread: true }),
      msg({ id: "b", date: d(1), unread: false }),
      msg({ id: "c", date: d(2), unread: true }),
    ];
    const part = feedPartition(await importedAt(pile, d(1)), "reads");
    expect([...part.fresh, ...part.seen].map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
});

describe("a committed waterline still outranks \\Seen (R10-5's model is untouched)", () => {
  it("the anchor cuts the pile even where read state disagrees", async () => {
    // The user read new1 IN THIS CLIENT mid-visit (dwell sweep) and left with the line at
    // read1: new1 is \Seen yet ABOVE the line — the line moved once, on the way out, and the
    // partition must not re-derive it from read state while an anchor stands.
    const pile = [
      msg({ id: "new1", date: d(0), unread: false }),
      msg({ id: "read1", date: d(1), unread: false }),
      msg({ id: "skip1", date: d(2), unread: true }),
    ];
    const part = feedPartition(
      await mirrorOf(pile, { view: "reads", meta: { newestSeenId: "read1" } }),
      "reads",
    );
    expect(part.waterline?.newestSeenId).toBe("read1");
    expect(part.fresh.map((m) => m.id)).toEqual(["new1"]);
    expect(part.seen.map((m) => m.id)).toEqual(["read1", "skip1"]);
  });

  it("a LOST anchor with no recorded place falls back to the first sync, never to read state", async () => {
    // A row written before the line recorded its place (`anchorAt`) and whose letter has left
    // the pile cannot be placed; `feed-partition-moved-in.test.ts` holds the recorded-place case.
    const pile = [
      msg({ id: "new1", date: d(0), unread: true }),
      msg({ id: "read1", date: d(1), unread: false }),
      msg({ id: "old1", date: d(2), unread: true }),
    ];
    const store = await importedAt(pile, d(1));
    await store.putLocal("view_meta", waterlineIdOf("reads"), { newestSeenId: "gone" });
    const part = feedPartition(store, "reads");
    expect(part.waterline).toBeNull();
    expect(part.newCount).toBe(1);
    expect(part.fresh.map((m) => m.id)).toEqual(["new1"]);
  });

  it("each view cuts ITS OWN folder only", async () => {
    // A News visit's line may not cut the receipts pile, which no visit has cut yet.
    const pile = [
      msg({ id: "rcpt1", date: d(0), unread: true, folder: "ohmail/Receipts" }),
      msg({ id: "read1", date: d(1), unread: false, folder: "ohmail/News" }),
      msg({ id: "rcpt2", date: d(2), unread: true, folder: "ohmail/Receipts" }),
    ];
    const store = await importedAt(pile, d(1));
    await store.putLocal("view_meta", waterlineIdOf("reads"), { newestSeenId: "read1" });
    const part = feedPartition(store, "receipts");
    expect(part.fresh.map((m) => m.id)).toEqual(["rcpt1", "rcpt2"]);
    expect(part.newCount).toBe(2);
  });
});
