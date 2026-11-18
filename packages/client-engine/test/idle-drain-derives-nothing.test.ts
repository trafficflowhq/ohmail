import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * AN EMPTY DRAIN DERIVES NOTHING.
 *
 * The windowed prune and the eager body pass both read the WHOLE mirror and sort it, and both ran
 * at the settle of every drain — so a client with a mailbox nobody was writing to paid its own
 * size, once per poll, to be told there was nothing to evict and nothing new to fetch. Each is now
 * keyed on a change stamp; each still does the whole thing the moment one moves.
 *
 * COUNTED, not timed: the store is wrapped so every whole-mirror read is a number in this file.
 */

const NOW = new Date("2026-09-14T12:00:00.000Z");
const DAY = 86_400_000;
let seq = 0;

function msg(id: string, daysAgo: number): EngineMessage {
  const date = new Date(NOW.getTime() - daysAgo * DAY).toISOString();
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "sender@example.test" },
    to: [], cc: [], date, folder: "INBOX", snippet: "snippet", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  } as unknown as EngineMessage;
}

const create = (type: string, id: string, entity: unknown): SyncChange =>
  ({ type, op: "create", id, seq: ++seq, updatedAt: NOW.toISOString(), entity });

/** A `/sync` that answers the scripted pages and then stays EMPTY for ever — an idle mailbox. */
function adapterOf(pages: SyncChange[][]): EngineAdapter {
  const queue = [...pages];
  return {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: queue.shift() ?? [], updates: [], moves: [], deletes: [] },
      cursor: String(seq), hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
  } as unknown as EngineAdapter;
}

/**
 * The store, with every WHOLE-MIRROR read counted. `entries` is the call both passes open with and
 * the one whose cost is proportional to the mailbox; `list` is counted beside it so a pass that
 * moved to the other reader cannot go unseen.
 */
function counted(store: MemoryMirrorStore): { store: MemoryMirrorStore; walks: () => number } {
  let walks = 0;
  const proxy = new Proxy(store, {
    get(target, prop, receiver): unknown {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (prop === "entries" || prop === "list") {
        return (...args: unknown[]): unknown => {
          walks += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
  return { store: proxy, walks: () => walks };
}

/** Enough rows that "proportional to the mailbox" is a different number from "a handful". */
const LADDER = Array.from({ length: 400 }, (_, i) => msg(`m${i}`, i));

async function seeded(): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  return store;
}

const WINDOWED = { mode: "windowed", days: 90, minRows: 50, maxRows: 300 } as const;

describe("the windowed prune at an empty settle", () => {
  it("does not read the mirror when nothing arrived", async () => {
    const base = await seeded();
    const { store, walks } = counted(base);
    const engine = new OhmailEngine({
      adapter: adapterOf([LADDER.map((m) => create("message", m.id, m))]),
      store, now: () => NOW, storePolicy: WINDOWED,
    });

    await engine.syncOnce();           // the page lands; the pass runs
    const afterFirst = walks();
    expect(afterFirst).toBeGreaterThan(0);

    await engine.syncOnce();           // nothing arrived
    expect(walks()).toBe(afterFirst);

    await engine.syncOnce();           // and still nothing
    expect(walks()).toBe(afterFirst);
  });

  it("does the whole pass again the moment a row arrives", async () => {
    const base = await seeded();
    const { store, walks } = counted(base);
    const engine = new OhmailEngine({
      adapter: adapterOf([
        LADDER.map((m) => create("message", m.id, m)),
        [],
        [create("message", "late", msg("late", 0))],
      ]),
      store, now: () => NOW, storePolicy: WINDOWED,
    });

    await engine.syncOnce();
    await engine.syncOnce();
    const idle = walks();
    await engine.syncOnce();           // one message arrives
    expect(walks()).toBeGreaterThan(idle);
  });

  /**
   * A CUTLINE RE-STATED IS NOT A CUTLINE CHANGED. Every shell re-states the account's answer when
   * its own consent read settles, and the phone does it from an effect keyed on an object it
   * re-reads; bumping the age term's generation on every such call would put the whole pass back
   * on a tick through the one input that is not a record.
   */
  it("does not re-derive when the same cutline is stated again", async () => {
    const base = await seeded();
    const { store, walks } = counted(base);
    const engine = new OhmailEngine({
      adapter: adapterOf([LADDER.map((m) => create("message", m.id, m))]),
      store, now: () => NOW, storePolicy: WINDOWED,
    });
    engine.setCutline({ dormancyDays: 365, scope: "window" });
    await engine.syncOnce();
    const afterFirst = walks();

    engine.setCutline({ dormancyDays: 365, scope: "window" });   // the same answer, a fresh object
    await engine.syncOnce();
    expect(walks()).toBe(afterFirst);

    engine.setCutline({ dormancyDays: 30, scope: "window" });    // a DIFFERENT answer
    await engine.syncOnce();
    expect(walks()).toBeGreaterThan(afterFirst);
  });

  /**
   * THE DIRECTION AN OMISSION MUST FAIL IN: a `full` mirror evicts nothing and never reached the
   * pass at all, before this gate or after it.
   */
  it("leaves a full mirror exactly as it was", async () => {
    const base = await seeded();
    const { store, walks } = counted(base);
    const engine = new OhmailEngine({
      adapter: adapterOf([LADDER.map((m) => create("message", m.id, m))]),
      store, now: () => NOW,
    });
    await engine.syncOnce();
    const after = walks();
    await engine.syncOnce();
    expect(walks()).toBe(after);
    expect(base.entries<EngineMessage>("message").length).toBe(LADDER.length);
  });
});

describe("the eager body pass at an empty settle", () => {
  it("does not rank the mirror twice for the same mailbox", async () => {
    const base = await seeded();
    const { store, walks } = counted(base);
    const engine = new OhmailEngine({
      adapter: adapterOf([LADDER.map((m) => create("message", m.id, m))]),
      store, now: () => NOW, eagerBodies: true,
    });
    await engine.syncOnce();
    await engine.prefetchRecentBodies();
    await engine.eagerBodiesIdle();
    const afterFirst = walks();
    expect(afterFirst).toBeGreaterThan(0);

    await engine.prefetchRecentBodies();
    await engine.eagerBodiesIdle();
    expect(walks()).toBe(afterFirst);
  });

  it("ranks again once the mirror has moved", async () => {
    const base = await seeded();
    const { store, walks } = counted(base);
    const engine = new OhmailEngine({
      adapter: adapterOf([
        LADDER.map((m) => create("message", m.id, m)),
        [create("message", "late", msg("late", 0))],
      ]),
      store, now: () => NOW, eagerBodies: true,
    });
    await engine.syncOnce();
    await engine.prefetchRecentBodies();
    await engine.eagerBodiesIdle();
    const idle = walks();

    await engine.syncOnce();
    await engine.prefetchRecentBodies();
    await engine.eagerBodiesIdle();
    expect(walks()).toBeGreaterThan(idle);
  });
});
