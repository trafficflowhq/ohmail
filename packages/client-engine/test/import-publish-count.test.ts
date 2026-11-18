import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  BACKLOG_PUBLISH_PAGES,
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * ═══ HOW MANY TIMES A FIRST IMPORT PUBLISHES ═══════════════════════════════════════════════
 *
 * Every publish makes the shell re-derive the whole mirror and re-render, which is the most
 * expensive thing the renderer does — measured in a real browser renderer at megabytes of
 * resident peak per re-render over a full window, independent of how many rows the
 * window holds. A first import did one per backlog page, which is hundreds of them for a change
 * the reader could not act on between pages.
 *
 * COUNT VERSION MOVES, NOT NOTIFIES. `subscribe` fires on every `notify()`, but the shell reads
 * the mirror's VERSION through `useSyncExternalStore`, so a notify over an unchanged version costs
 * nothing. Counting notifies made a 303-to-153 cut look like a fix while no reader re-rendered
 * once fewer; this file counts what a reader counts.
 *
 * Every guard below was watched RED against a named mutation and the implementation restored.
 */

const NOW = new Date("2026-09-12T12:00:00.000Z");
const DAY = 86_400_000;

let seq = 0;

function msg(id: string, daysOld: number): EngineMessage {
  const date = new Date(NOW.getTime() - daysOld * DAY).toISOString();
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "sender@example.test" },
    to: [], cc: [], date, folder: "INBOX", snippet: "snippet", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  };
}

function create(id: string, daysOld: number): SyncChange {
  return { type: "message", op: "create", id, seq: ++seq, updatedAt: NOW.toISOString(), entity: msg(id, daysOld) };
}

interface Rig {
  engine: OhmailEngine;
  store: MemoryMirrorStore;
  /** Publishes that MOVED the version — what `useEngineVersion` re-renders on. */
  publishes: () => number;
  pages: () => number;
}

/**
 * A publish counter that counts what a READER counts. `subscribe` fires on every `notify()`, but
 * `useSyncExternalStore` re-renders only when the snapshot VALUE moves — so a notify over an
 * unchanged version costs the shell nothing and must not be counted as one that did.
 */
function rigOf(
  feed: SyncChange[],
  opts: {
    page?: number;
    eagerBodies?: boolean;
    fetchBodies?: (ids: string[]) => Promise<Array<Record<string, unknown>>>;
    fetchBody?: (id: string) => Promise<{ text: string; html: null; loadedRemoteContent: boolean } | null>;
  } = {},
): Rig {
  const page = opts.page ?? 10;
  const rest = [...feed];
  let pages = 0;
  const adapter = {
    sync: async (): Promise<SyncResponse> => {
      pages += 1;
      const slice = rest.splice(0, page);
      return {
        changes: { creates: slice, updates: [], moves: [], deletes: [] },
        cursor: String(seq), hasMore: rest.length > 0, serverTime: NOW.toISOString(),
      };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: opts.fetchBody
      ?? (async (id: string) => ({ text: `FULL ${id}`, html: null, loadedRemoteContent: false })),
    ...(opts.fetchBodies ? { fetchBodies: opts.fetchBodies } : {}),
  } as unknown as EngineAdapter;
  const store = new MemoryMirrorStore();
  const engine = new OhmailEngine({
    adapter, store, now: () => NOW,
    ...(opts.eagerBodies === true ? { eagerBodies: true } : {}),
  });
  let seen = -1;
  let moved = 0;
  engine.subscribe(() => {
    const v = engine.read().version();
    if (v !== seen) { seen = v; moved += 1; }
  });
  return { engine, store, publishes: () => moved, pages: () => pages };
}

describe("what a first import publishes", () => {
  it("costs a reader ONE re-render for a settle, whatever the settle notifies", async () => {
    /**
     * A MEASUREMENT OF VERSION MOVES. `useEngineVersion` re-renders on the version, not on the
     * notify, so counting notifies made a 303-to-153 cut look like a fix when no reader re-rendered
     * once fewer. The settle's notifies are one now too (`one-notify-per-poll.test.ts`), for the
     * other reader: freshness moves with the stamp and no version, and React 19 committed the page
     * and the stamp as two renders. A lane looking for the renderer's peak counts both.
     */
    const rig = rigOf([create("m0", 400), create("m1", 399)], { page: 10 });
    await rig.engine.syncOnce();
    expect(rig.pages()).toBe(1);
    expect(rig.store.entries("message").length).toBe(2);
    expect(rig.publishes()).toBe(1);
  });

  it("publishes once per group of backlog pages, not once per page", async () => {
    /**
     * THE CHANGE, and the number it is written against: a backlog in pages of ten is 19 backlog
     * pages and a settle. At one publish per page that is 20 whole-shell re-renders; grouped it is
     * two (pages 8 and 16) plus the settle's.
     */
    const rig = rigOf(Array.from({ length: 200 }, (_, i) => create(`b${i}`, 400 - i)), { page: 10 });
    await rig.engine.syncOnce();
    expect(rig.pages()).toBe(20);
    expect(BACKLOG_PUBLISH_PAGES).toBe(8);
    // WATCHED RED by `pagesThisDrain % 1` in `drain()`: 20.
    expect(rig.publishes()).toBe(Math.floor(19 / BACKLOG_PUBLISH_PAGES) + 1);
    // AND NOT ONE ROW FEWER. Grouping is a statement about when a reader is told, never about
    // what it is told — every message of the backlog is in the mirror at the settle.
    expect(rig.store.entries("message").length).toBe(200);
  });

  it("publishes at the settle even when the backlog ends mid-group", async () => {
    /**
     * THE POSITIVE CONTROL for the grouping: a catch-up shorter than one group publishes nothing
     * on the way in, so the settle is the only thing standing between the reader and a mirror that
     * filled in silence.
     *
     * TWO publishes hold this up, not one — the settle's own and the freshness announce below it —
     * and removing either alone leaves it green. Named rather than hidden: it is watched red by
     * removing BOTH, which is what "the settle tells the reader" actually means here.
     */
    const rig = rigOf(Array.from({ length: 50 }, (_, i) => create(`b${i}`, 400 - i)), { page: 10 });
    await rig.engine.syncOnce();
    expect(rig.pages()).toBe(5);
    expect(rig.publishes()).toBe(1);
    expect(rig.store.entries("message").length).toBe(50);
  });

});
