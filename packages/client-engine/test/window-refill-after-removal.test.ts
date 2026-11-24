import type { EngineMessage, MutationOutcome, SyncSnapshotPage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  STORE_POLICY_GENERATION,
  STORE_POLICY_GENERATION_META,
  WINDOW_REFILL_OWED_META,
  type EngineAdapter,
  type StorePolicy,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * THE REFILL A MAILBOX RECEIPT OWES A WINDOWED MIRROR, and the four ways it must not run.
 * The mirror below is the reported state: the removed mailbox's newer rows displaced
 * the kept one's two oldest, and the receipt takes the removed rows. Mutations watched red:
 * the `refillWindow()` call dropped from the settle (arms 1, 2, 5), the `news` test in
 * `noteRemovalOwesRefill` inverted (arms 1, 2, 3, 5), the tombstone half of the refill's filter
 * dropped (arm 2 alone), the policy gate dropped (arm 4 alone).
 */

const NOW = new Date("2026-09-26T08:00:00.000Z");
const DAY = 86_400_000;
let seq = 0;

function msg(id: string, mailboxId: string, daysAgo: number): EngineMessage {
  const date = new Date(NOW.getTime() - daysAgo * DAY).toISOString();
  return {
    id, accountId: "acct", mailboxId, threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: `${id}@elsewhere.test` },
    to: [], cc: [], date, folder: "INBOX", snippet: "s", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  };
}
const change = (type: string, op: SyncChange["op"], id: string, entity?: unknown): SyncChange =>
  ({ type, op, id, seq: ++seq, updatedAt: NOW.toISOString(), ...(entity !== undefined ? { entity } : {}) });

const KEPT = [msg("k1", "kept", 30), msg("k2", "kept", 29), msg("k3", "kept", 28)];
const GONE = [msg("g1", "gone", 2), msg("g2", "gone", 1)];

/** The displaced window: the removed mailbox's rows and the kept one's newest; k1 and k2 evicted. */
async function displacedMirror(): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    change("mailbox", "create", "gone", { id: "gone", address: "gone@example.test" }),
    ...[KEPT[2]!, ...GONE].map((m) => change("message", "create", m.id, m)),
  ]);
  await store.applyResponse({
    changes: { creates: [], updates: [], moves: [], deletes: [] },
    cursor: "d2FybQ", hasMore: false, serverTime: NOW.toISOString(),
  });
  await store.setMeta("lastDrainAt", NOW.toISOString());
  await store.setMeta(STORE_POLICY_GENERATION_META, STORE_POLICY_GENERATION);
  return store;
}

/** The door after the removal: the feed carries the receipt once, the snapshot the kept mail. */
function door(pages: SyncChange[][], snapshotRows: EngineMessage[], fail = { times: 0 }) {
  const asks: number[] = [];
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: pages.shift() ?? [] },
      cursor: `c${seq}`, hasMore: false, serverTime: NOW.toISOString(),
    }),
    snapshot: async (): Promise<SyncSnapshotPage> => {
      asks.push(Date.now());
      if (fail.times > 0) { fail.times -= 1; throw new Error("the door did not answer"); }
      return {
        asOfSeq: seq + 100, nextCursor: null, window: { days: 90, minRows: 5000 },
        changes: snapshotRows.map((m) => ({ ...change("message", "create", m.id, m), seq: seq + 100 })),
      };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
  } as unknown as EngineAdapter;
  return { adapter, asks };
}

const WINDOWED: StorePolicy = { mode: "windowed", days: 1, minRows: 3, maxRows: 3 };
const ids = (s: MemoryMirrorStore): string[] => s.entries<EngineMessage>("message").map((e) => e.id).sort();

describe("the refill a mailbox receipt owes a windowed mirror", () => {
  it("brings the displaced rows back and takes none of the removed mailbox's", async () => {
    const store = await displacedMirror();
    const { adapter, asks } = door([[change("mailbox", "delete", "gone")]], KEPT);
    await new OhmailEngine({ adapter, store, now: () => NOW, storePolicy: WINDOWED }).syncOnce();
    expect(ids(store)).toEqual(["k1", "k2", "k3"]);
    expect(asks.length).toBe(1);
    expect(store.getMeta(WINDOW_REFILL_OWED_META)).toBe(false);
  });

  it("never writes over a tombstone: a row the delta deleted stays deleted", async () => {
    const store = await displacedMirror();
    await store.applyChanges([change("message", "create", "k1", KEPT[0]), change("message", "delete", "k1")]);
    const { adapter } = door([[change("mailbox", "delete", "gone")]], KEPT);
    await new OhmailEngine({ adapter, store, now: () => NOW, storePolicy: WINDOWED }).syncOnce();
    expect(ids(store)).toEqual(["k2", "k3"]);
  });

  it("owes nothing for a receipt this mirror already applied", async () => {
    const store = await displacedMirror();
    await store.applyChanges([change("mailbox", "delete", "gone")]);
    const { adapter, asks } = door([[change("mailbox", "delete", "gone")]], KEPT);
    await new OhmailEngine({ adapter, store, now: () => NOW, storePolicy: WINDOWED }).syncOnce();
    expect(asks.length, "a replayed receipt walked the snapshot again").toBe(0);
  });

  it("owes nothing on a `full` mirror, which evicted nothing", async () => {
    const store = await displacedMirror();
    const { adapter, asks } = door([[change("mailbox", "delete", "gone")]], KEPT);
    await new OhmailEngine({ adapter, store, now: () => NOW, storePolicy: { mode: "full" } }).syncOnce();
    expect(asks.length).toBe(0);
    expect(store.getMeta(WINDOW_REFILL_OWED_META)).toBeUndefined();
  });

  it("stays owed when the door fails, and refills on the next drain", async () => {
    const store = await displacedMirror();
    const fail = { times: 1 };
    const { adapter, asks } = door([[change("mailbox", "delete", "gone")]], KEPT, fail);
    const engine = new OhmailEngine({ adapter, store, now: () => NOW, storePolicy: WINDOWED });
    await engine.syncOnce();
    expect(store.getMeta(WINDOW_REFILL_OWED_META)).toBe(true);
    expect(ids(store)).toEqual(["k3"]);
    await engine.syncOnce();
    expect(ids(store)).toEqual(["k1", "k2", "k3"]);
    expect(asks.length).toBe(2);
  });

  it("an ordinary drain asks for no snapshot — the positive control", async () => {
    const store = await displacedMirror();
    const { adapter, asks } = door([[change("message", "delete", "g1")]], KEPT);
    await new OhmailEngine({ adapter, store, now: () => NOW, storePolicy: WINDOWED }).syncOnce();
    expect(asks.length).toBe(0);
    expect(ids(store)).toEqual(["g2", "k3"]);
  });
});
