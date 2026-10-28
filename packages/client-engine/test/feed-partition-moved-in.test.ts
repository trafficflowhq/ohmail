import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  FEED_SINCE_ID,
  feedPartition,
  feedLineUndo,
  mutationEffects,
  waterlineIdOf,
  type EngineMessage,
  type Folder,
  type SyncChange,
  type WaterlineMeta,
  OhmailEngine,
  type EngineAdapter,
  type MutationOutcome,
  type SyncResponse,
} from "@ohmail/client-engine";

/**
 * A LETTER MOVED INTO A PILE NEVER MOVES ITS LINE. "New since you were here" is
 * decided by the person's visit to the pile, never by a letter's read flag: filing a READ letter
 * on top of News or Receipts zeroed the badge over unread letters on web and phone, and a device
 * with no line yet drew "Seen up to here" above the moved letter. Each move here is the sync
 * update the mirror receives for it — the letter's folder changes, nothing else does.
 */

let seq = 0;

function msg(o: { id: string; date: string; unread: boolean; folder: string }): EngineMessage {
  return {
    id: o.id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${o.id}`, from: { name: null, address: `${o.id}@example.com` }, to: [], cc: [],
    date: o.date, folder: o.folder as Folder, snippet: `snippet ${o.id}`, unread: o.unread,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: o.date,
  };
}

async function mirrorOf(messages: EngineMessage[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(messages.map((m) => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })) as SyncChange[]);
  return store;
}

/** The sync update a move produces: the same letter, in another folder. */
async function moveInto(store: MemoryMirrorStore, id: string, folder: string): Promise<void> {
  const m = store.get<EngineMessage>("message", id)!;
  await store.applyChanges([{
    type: "message", op: "update", id, seq: ++seq, updatedAt: m.updatedAt, entity: { ...m, folder: folder as Folder },
  }] as SyncChange[]);
}

/** A real visit's leave-commit, through the engine's own `feed_mark_seen` writer. */
async function leave(store: MemoryMirrorStore, view: "reads" | "receipts", upToId: string, messageIds: string[] = []): Promise<number> {
  const effects = mutationEffects(store, { kind: "feed_mark_seen", view, upToId, messageIds } as never, {
    now: () => new Date("2026-10-09T12:00:00.000Z"), uuid: () => "u",
  });
  for (const e of effects) if (e.type === "view_meta") await store.putLocal("view_meta", e.id, e.entity);
  return effects.length;
}

const at = (hh: number, mm = 0): string => `2026-10-09T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000Z`;
const unreadIn = (store: MemoryMirrorStore, folder: string): number =>
  store.list<EngineMessage>("message").filter((m) => m.folder === folder && m.unread).length;

/** This device's first completed sync, as the engine's drain records it. */
async function firstSync(store: MemoryMirrorStore, iso: string): Promise<void> {
  await store.putLocal("view_meta", FEED_SINCE_ID, { at: iso });
}

describe("no visit yet on this device: a read letter moved in on top", () => {
  it("Receipts: 5 unread that came after the first sync stay 5 new, and no line is drawn", async () => {
    const store = await mirrorOf([
      ...[1, 2, 3, 4, 5].map((i) => msg({ id: `rc${i}`, date: at(9, i), unread: true, folder: "ohmail/Receipts" })),
      msg({ id: "w07", date: at(11, 30), unread: false, folder: "Sent" }),
    ]);
    await firstSync(store, at(9));
    expect(feedPartition(store, "receipts").newCount).toBe(5);
    await moveInto(store, "w07", "ohmail/Receipts");
    const part = feedPartition(store, "receipts");
    expect(part.newCount).toBe(5);
    // The count agrees with the server's unread for the pile.
    expect(part.newCount).toBe(unreadIn(store, "ohmail/Receipts"));
    expect(part.waterline).toBeNull();
    expect(part.fresh.map((m) => m.id)).toEqual(["w07", "rc5", "rc4", "rc3", "rc2", "rc1"]);
  });

  it("News: a newer read letter moved in keeps both unread letters new", async () => {
    const store = await mirrorOf([
      msg({ id: "n1", date: at(11, 35), unread: true, folder: "ohmail/News" }),
      msg({ id: "n2", date: at(11, 36), unread: true, folder: "ohmail/News" }),
      msg({ id: "w09", date: at(11, 33), unread: false, folder: "INBOX" }),
      msg({ id: "w14", date: at(11, 43), unread: false, folder: "INBOX" }),
    ]);
    await firstSync(store, at(11));
    // Control: an OLDER read letter moved in sorts below the unread ones — 2 at the base too.
    await moveInto(store, "w09", "ohmail/News");
    expect(feedPartition(store, "reads").newCount).toBe(2);
    // The finding: a NEWER read letter sorts above them.
    await moveInto(store, "w14", "ohmail/News");
    const part = feedPartition(store, "reads");
    expect(part.newCount).toBe(2);
    expect(part.waterline).toBeNull();
  });

  it("an OLD read letter moved in is not new, and draws no line", async () => {
    const store = await mirrorOf([
      msg({ id: "n1", date: at(11, 35), unread: true, folder: "ohmail/News" }),
      msg({ id: "old", date: at(8), unread: false, folder: "INBOX" }),
    ]);
    await firstSync(store, at(11));
    await moveInto(store, "old", "ohmail/News");
    const part = feedPartition(store, "reads");
    expect(part.newCount).toBe(1);
    expect(part.waterline).toBeNull();
    expect(part.fresh.map((m) => m.id)).toEqual(["n1", "old"]);
  });
});

describe("an imported pile: unread is new until a visit", () => {
  it("old unread mail counts on the first visit; arrivals add to it; a visit moves the line", async () => {
    const old = Array.from({ length: 50 }, (_, i) =>
      msg({ id: `old${String(i).padStart(2, "0")}`, date: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}${"T"}08:00:00.000Z`, unread: true, folder: "ohmail/News" }));
    const store = await mirrorOf(old);
    await firstSync(store, at(9));
    let part = feedPartition(store, "reads");
    expect(part.newCount).toBe(50);
    expect(part.waterline).toBeNull();
    expect(part.seen).toEqual([]);
    await store.applyChanges([{
      type: "message", op: "create", id: "fresh", seq: ++seq, updatedAt: at(10),
      entity: msg({ id: "fresh", date: at(10), unread: true, folder: "ohmail/News" }),
    }] as SyncChange[]);
    part = feedPartition(store, "reads");
    expect(part.newCount).toBe(51);
    expect(part.fresh[0]?.id).toBe("fresh");
    await leave(store, "reads", "fresh");
    part = feedPartition(store, "reads");
    expect(part.newCount).toBe(0);
    expect(part.waterline?.newestSeenId).toBe("fresh");
  });

  it("before this device's first sync completes, nothing is cut (the count is withheld until settled)", async () => {
    const store = await mirrorOf([msg({ id: "u", date: at(9), unread: true, folder: "ohmail/News" })]);
    const part = feedPartition(store, "reads");
    expect(part.fresh.map((m) => m.id)).toEqual(["u"]);
    expect(part.waterline).toBeNull();
  });

  it("truly nothing new: an all-read pile says 0", async () => {
    const store = await mirrorOf([
      msg({ id: "r1", date: at(10), unread: false, folder: "ohmail/News" }),
      msg({ id: "r2", date: at(9), unread: false, folder: "ohmail/News" }),
    ]);
    await firstSync(store, at(8));
    const part = feedPartition(store, "reads");
    expect(part.newCount).toBe(0);
    expect(part.waterline).toBeNull();
  });
});

describe("a committed line: the visit decides, the move does not", () => {
  it("a read letter moved in above the line changes neither the line nor the count", async () => {
    const store = await mirrorOf([
      msg({ id: "a", date: at(9), unread: false, folder: "ohmail/News" }),
      msg({ id: "w", date: at(11), unread: false, folder: "INBOX" }),
    ]);
    await leave(store, "reads", "a");
    await store.applyChanges([{
      type: "message", op: "create", id: "n", seq: ++seq, updatedAt: at(10),
      entity: msg({ id: "n", date: at(10), unread: true, folder: "ohmail/News" }),
    }] as SyncChange[]);
    expect(feedPartition(store, "reads").newCount).toBe(1);
    await moveInto(store, "w", "ohmail/News");
    const part = feedPartition(store, "reads");
    expect(part.newCount).toBe(1);
    expect(part.seen[0]?.id).toBe("a");
    expect(part.waterline?.newestSeenId).toBe("a");
  });

  it("control: a real visit moves the line, and then nothing is new", async () => {
    const store = await mirrorOf([
      msg({ id: "n", date: at(10), unread: true, folder: "ohmail/News" }),
      msg({ id: "a", date: at(9), unread: false, folder: "ohmail/News" }),
    ]);
    await leave(store, "reads", "a");
    expect(feedPartition(store, "reads").newCount).toBe(1);
    await leave(store, "reads", "n");
    const part = feedPartition(store, "reads");
    expect(part.newCount).toBe(0);
    expect(part.seen[0]?.id).toBe("n");
  });

  it("the line's own letter moved OUT: the line stays where the visit put it", async () => {
    const store = await mirrorOf([
      msg({ id: "new", date: at(11), unread: true, folder: "ohmail/News" }),
      msg({ id: "a", date: at(10), unread: false, folder: "ohmail/News" }),
      msg({ id: "old", date: at(9), unread: true, folder: "ohmail/News" }),
      msg({ id: "w", date: at(12), unread: false, folder: "INBOX" }),
    ]);
    await leave(store, "reads", "a");
    expect((store.get<WaterlineMeta>("view_meta", waterlineIdOf("reads")) as { anchorAt?: string }).anchorAt)
      .toBe(at(10));
    await moveInto(store, "a", "Archive");
    await moveInto(store, "w", "ohmail/News");
    const part = feedPartition(store, "reads");
    // "new" arrived after the visit; "old" was below the line when the person left.
    expect(part.newCount).toBe(1);
    expect(part.fresh.map((m) => m.id)).toEqual(["w", "new"]);
    expect(part.seen.map((m) => m.id)).toEqual(["old"]);
    expect(part.waterline?.newestSeenId).toBe("a");
  });

  it("the recorded place keeps the pile's order among letters of the same instant", async () => {
    // byDateDesc breaks an equal instant by id, descending: z, m, a.
    const store = await mirrorOf([
      msg({ id: "z", date: at(10), unread: true, folder: "ohmail/News" }),
      msg({ id: "m", date: at(10), unread: false, folder: "ohmail/News" }),
      msg({ id: "a", date: at(10), unread: true, folder: "ohmail/News" }),
    ]);
    await leave(store, "reads", "m");
    await moveInto(store, "m", "Archive");
    const part = feedPartition(store, "reads");
    expect(part.fresh.map((x) => x.id)).toEqual(["z"]);
    expect(part.seen.map((x) => x.id)).toEqual(["a"]);
    expect(part.newCount).toBe(1);
  });

  it("a line whose letter is gone and whose place was never recorded draws none; the first sync anchors", async () => {
    const store = await mirrorOf([
      msg({ id: "w", date: at(12), unread: false, folder: "ohmail/News" }),
      msg({ id: "n", date: at(11), unread: true, folder: "ohmail/News" }),
      msg({ id: "u", date: at(9), unread: true, folder: "ohmail/News" }),
    ]);
    await firstSync(store, at(10));
    await store.putLocal("view_meta", waterlineIdOf("reads"), { newestSeenId: "gone", at: at(10) });
    const part = feedPartition(store, "reads");
    expect(part.waterline).toBeNull();
    expect(part.fresh.map((m) => m.id)).toEqual(["w", "n"]);
    expect(part.newCount).toBe(1);
  });
});

describe("the line never moves back", () => {
  it("a leave anchored below the held line keeps the line; its flips still apply", async () => {
    const store = await mirrorOf([1, 2, 3, 4, 5, 6].map((i) => msg({ id: `n${i}`, date: at(9, i), unread: true, folder: "ohmail/News" })));
    await firstSync(store, at(8));
    await leave(store, "reads", "n6");
    expect(feedPartition(store, "reads").waterline?.newestSeenId).toBe("n6");
    const n = await leave(store, "reads", "n2", ["n2", "n3"]);
    expect(feedPartition(store, "reads").waterline?.newestSeenId).toBe("n6");
    expect(feedPartition(store, "reads").fresh.map((m) => m.id)).toEqual([]);
    // Two flips and the held line restated: the verb is never refused as empty.
    expect(n).toBe(3);
  });

  it("a held line dated past the clock does not freeze the line", async () => {
    const store = await mirrorOf([
      msg({ id: "future", date: "2027-01-01T00:00:00.000Z", unread: true, folder: "ohmail/News" }),
      ...[1, 2].map((i) => msg({ id: `n${i}`, date: at(9, i), unread: true, folder: "ohmail/News" })),
    ]);
    await firstSync(store, at(8));
    await leave(store, "reads", "future");
    await leave(store, "reads", "n2");
    expect(feedPartition(store, "reads").waterline?.newestSeenId).toBe("n2");
  });

  it("only a Mark all read's Undo puts it back, exactly as it was, or takes away a line that was not there", async () => {
    const store = await mirrorOf([1, 2, 3].map((i) => msg({ id: `n${i}`, date: at(9, i), unread: true, folder: "ohmail/News" })));
    await firstSync(store, at(8));
    const apply = async (m: unknown): Promise<void> => {
      for (const e of mutationEffects(store, m as never, { now: () => new Date(at(12)), uuid: () => "u" })) {
        await store.putLocal(e.type, e.id, e.entity);
      }
    };
    const none = feedLineUndo(store, "reads");
    await leave(store, "reads", "n1");
    const held = store.get<WaterlineMeta>("view_meta", waterlineIdOf("reads"));
    const back = feedLineUndo(store, "reads");
    await leave(store, "reads", "n3");
    expect(feedPartition(store, "reads").newCount).toBe(0);
    await apply(back);
    expect(store.get<WaterlineMeta>("view_meta", waterlineIdOf("reads"))).toEqual(held);
    expect(feedPartition(store, "reads").newCount).toBe(2);
    await apply(none);
    expect(store.get("view_meta", waterlineIdOf("reads"))).toBeUndefined();
    expect(feedPartition(store, "reads").newCount).toBe(3);
  });
});

describe("the engine records this device's first completed sync, once", () => {
  const t0 = new Date("2026-10-09T09:00:00.000Z");
  function quietAdapter(): EngineAdapter {
    return {
      sync: async (params: { since: string }): Promise<SyncResponse> => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: params.since === "0" ? "AA" : params.since, hasMore: false, serverTime: t0.toISOString(),
      }),
      mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
      fetchBody: async () => null,
    } as unknown as EngineAdapter;
  }

  it("stamps the first settle and keeps it across later drains", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    const clock = { now: t0 };
    const engine = new OhmailEngine({ adapter: quietAdapter(), store, now: () => clock.now });
    expect(store.get("view_meta", FEED_SINCE_ID)).toBeUndefined();
    await engine.syncOnce();
    expect(store.get<{ at: string }>("view_meta", FEED_SINCE_ID)?.at).toBe(t0.toISOString());
    clock.now = new Date(t0.getTime() + 3_600_000);
    await engine.syncOnce();
    expect(store.get<{ at: string }>("view_meta", FEED_SINCE_ID)?.at).toBe(t0.toISOString());
  });
});
