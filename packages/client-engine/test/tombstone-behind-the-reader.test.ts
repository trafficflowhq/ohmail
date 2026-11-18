import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedDbMirrorStore,
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * ═══ THE TWO ABSENCES THE MIRROR HOLDS, AND WHY ONLY ONE OF THEM IS A DELETION ══════════════
 *
 * `get` answers `undefined` for both, and they mean opposite things. A DELETE writes a tombstone
 * (`entity: null` at the deleting change's seq — apply rule 4): this device's own record that the
 * row is gone. A PRUNE writes NOTHING (`MirrorStore.prune` hard-deletes, because a tombstone
 * carrying a seq would make the seq guard refuse every later delta for that id). So a caller that
 * settles a confirmed deletion on absence alone settles it against an eviction, and the IMAP
 * mailbox — the master — is never asked.
 *
 * `isTombstoned` is the question behind the reader. It reads the record and remembers nothing, so
 * the bound is the mirror's own: there is no recent-tombstone ledger with a lifetime of its own.
 *
 * ── MUTATION-WATCHED, each restored by copying the pristine file back and `cmp` ─────────────
 *   · `isTombstoned` reading `rec === undefined || rec.entity === null` → all five red;
 *   · `isTombstoned` answering `false` always → all five red;
 *   · `entries()` no longer skipping tombstones, so the eviction pass can pick one up → (3) red
 *     on the tombstone, which is the only mutation that reaches the second half of that case;
 *   · the eviction pass evicting nothing → (3) red on the LIVE row, which is what tells "the
 *     window produced this state" from "the assertion would pass over an unpruned mirror";
 *   · a side ledger remembering tombstones → (5) red on the post-prune read.
 */

const NOW = new Date("2026-08-07T12:00:00.000Z");
const DAY = 86_400_000;

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * DAY).toISOString();
}

let seq = 0;

function msg(id: string, date: string): EngineMessage {
  return {
    id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name: null, address: "sender@example.test" },
    to: [],
    cc: [],
    date,
    folder: "INBOX",
    snippet: "snippet",
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: {
      sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false,
    },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: date,
  };
}

function create(id: string, entity: EngineMessage): SyncChange {
  return { type: "message", op: "create", id, seq: ++seq, updatedAt: NOW.toISOString(), entity };
}

function update(id: string, entity: EngineMessage): SyncChange {
  return { type: "message", op: "update", id, seq: ++seq, updatedAt: NOW.toISOString(), entity };
}

/** The server's own delete — what a message that went actually leaves in the mirror. */
function remove(id: string): SyncChange {
  return { type: "message", op: "delete", id, seq: ++seq, updatedAt: NOW.toISOString() } as SyncChange;
}

function adapterOf(): EngineAdapter {
  return {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: String(seq),
      hasMore: false,
      serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
  } as unknown as EngineAdapter;
}

async function seeded(changes: SyncChange[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(changes);
  return store;
}

/** One drain over the shipped windowed policy, which is what runs `pruneToPolicy`. */
async function drainWindowed(store: MemoryMirrorStore, minRows: number, days: number): Promise<void> {
  await new OhmailEngine({
    adapter: adapterOf(),
    store,
    now: () => NOW,
    storePolicy: { mode: "windowed", days, minRows },
  }).syncOnce();
}

describe("the tombstone behind the reader", () => {
  it("(1) A PRUNED ROW IS NOT A DELETED ROW — both read absent, one is a tombstone", async () => {
    const store = await seeded([create("kept", msg("kept", daysAgo(1)))]);
    await store.applyChanges([create("pruned", msg("pruned", daysAgo(2)))]);
    await store.applyChanges([create("deleted", msg("deleted", daysAgo(3)))]);
    await store.applyChanges([remove("deleted")]);
    await store.prune([{ type: "message", id: "pruned" }]);

    expect(store.get("message", "pruned"), "absent to the reader").toBeUndefined();
    expect(store.get("message", "deleted"), "absent to the reader, identically").toBeUndefined();

    expect(store.isTombstoned("message", "deleted"), "memory put that row down").toBe(true);
    expect(store.isTombstoned("message", "pruned"), "the window stopped keeping it, nothing more")
      .toBe(false);
    expect(store.isTombstoned("message", "kept"), "a live row is not a tombstone").toBe(false);
    expect(store.isTombstoned("message", "never-seen"), "and neither is a row never held")
      .toBe(false);
  });

  it("(2) IT SURVIVES THE RELOAD — the tombstone is a record, so it is on disk", async () => {
    /* A DURABLE store and a second instance over the same database, because the whole point is a
       LAUNCH: the replay runs at mount, and a fact that lived only in the process that wrote it
       would be gone by the time anything asked. `MemoryMirrorStore` persists nothing, so it
       cannot answer this at all — asking it would be a reload test that never reloads. */
    const factory = new IDBFactory();
    const a = new IndexedDbMirrorStore({ dbName: "tombstone-reload", factory });
    await a.load();
    await a.applyChanges([
      create("gone", msg("gone", daysAgo(1))),
      create("kept", msg("kept", daysAgo(1))),
      create("evicted", msg("evicted", daysAgo(1))),
    ]);
    await a.applyChanges([remove("gone")]);
    await a.prune([{ type: "message", id: "evicted" }]);
    a.close();

    const b = new IndexedDbMirrorStore({ dbName: "tombstone-reload", factory });
    await b.load();
    expect(b.isTombstoned("message", "gone"), "still down after the read").toBe(true);
    expect(b.isTombstoned("message", "evicted"), "and the eviction is still not a deletion")
      .toBe(false);
    expect(b.isTombstoned("message", "kept"), "nor is a live row").toBe(false);
    b.close();
  });

  it("(3) THE WINDOWED PRUNE PRODUCES EXACTLY THAT STATE, and never takes a tombstone", async () => {
    /* THE STATE IS THE WINDOW'S OWN, not a hand-called prune: the eviction pass is what makes a
       row absent for a reason the person had nothing to do with. And it leaves the tombstones
       alone — its victims come from `entries()`, which skips them — so the fact the replay reads
       is one the window cannot take away while it is still deciding anything. */
    const rows = Array.from({ length: 12 }, (_, i) => msg(`m${i}`, daysAgo(i * 40)));
    const store = await seeded(rows.map((m) => create(m.id, m)));
    await store.applyChanges([remove("m11")]);
    expect(store.isTombstoned("message", "m11")).toBe(true);

    await drainWindowed(store, 2, 30);

    expect(store.get("message", "m0"), "inside the floor, kept").toBeDefined();
    expect(store.get("message", "m5"), "old and past the floor — the window evicted it")
      .toBeUndefined();
    expect(store.isTombstoned("message", "m5"), "AND LEFT NO RECORD: this is not a deletion")
      .toBe(false);
    expect(store.isTombstoned("message", "m11"), "the tombstone is still here").toBe(true);
  });

  it("(4) THE SEQ GUARD IS UNTOUCHED — an update to a pruned message still converges", async () => {
    /* `store.ts`'s own reason for hard-deleting: a pruned row carrying a seq would make the guard
       refuse every later delta at or below it, and the row would be invisible for ever. This is
       the control that asking the new question did not cost that property. */
    const store = await seeded([create("m", msg("m", daysAgo(1)))]);
    await store.prune([{ type: "message", id: "m" }]);
    expect(store.isTombstoned("message", "m"), "no seq left behind to guard with").toBe(false);

    const later = { ...msg("m", daysAgo(1)), subject: "Arrived after the eviction" };
    await store.applyChanges([update("m", later)]);
    expect(
      store.get<EngineMessage>("message", "m")?.subject,
      "the next change naming the id re-materialized the row",
    ).toBe("Arrived after the eviction");

    /* AND THE OTHER DIRECTION, which is the one a tombstone owns: a delete's record DOES guard,
       so a stale delta at or below it does not resurrect the message. */
    await store.applyChanges([remove("m")]);
    const stale: SyncChange = {
      type: "message", op: "update", id: "m", seq: 1, updatedAt: NOW.toISOString(), entity: later,
    } as SyncChange;
    await store.applyChanges([stale]);
    expect(store.isTombstoned("message", "m"), "an older delta does not undo a deletion").toBe(true);
  });

  it("(5) THE QUESTION REMEMBERS NOTHING — the bound is the mirror's own", async () => {
    /* A stream of deletes far past any cap somebody would have chosen for a recent-tombstone set.
       The answer comes from the record, so take the records away and it stops saying yes — which
       is what makes the mirror's bound the whole bound. */
    const ids = Array.from({ length: 1000 }, (_, i) => `t${i}`);
    const store = await seeded(ids.map((id) => create(id, msg(id, daysAgo(1)))));
    await store.applyChanges(ids.map((id) => remove(id)));
    for (const id of ids) expect(store.isTombstoned("message", id)).toBe(true);
    expect(store.snapshot().size, "every one of them is down").toBe(0);

    await store.prune(ids.map((id) => ({ type: "message", id })));
    for (const id of ids) expect(store.isTombstoned("message", id)).toBe(false);
  });
});
