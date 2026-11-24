import type { EngineMessage, MutationOutcome, SyncSnapshotPage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  CursorExpiredError,
  MemoryMirrorStore,
  OhmailEngine,
  RECEIVED_MESSAGES_META,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * ═══ HOW MUCH MAIL THIS CLIENT HAS TAKEN IN ════════════════════════════════════════════════
 *
 * `list("message").length` is what the first-run surfaces published as an import's progress, and
 * on a windowed mirror it is not one: `pruneToPolicy` evicts as the pages land, so the row count
 * stalls at the window's floor while the import runs on. Measured here at the browser's own shape
 * — `BROWSER_WINDOW`'s days and rows over a larger account whose mail predates the
 * window — the mirror climbs to its floor and then reads the floor for twenty consecutive pages while the
 * reader takes in the whole account.
 *
 * {@link OhmailEngine.receivedMessages} counts the rows at the reader's door instead. Every guard
 * below was watched RED against a named mutation of the implementation, then restored.
 */

const NOW = new Date("2026-08-07T12:00:00.000Z");
const DAY = 86_400_000;

/** The browser's window, spelled here as `apps/webapp/app/shell/store-windows.ts` spells it. */
const BROWSER_WINDOW = { mode: "windowed", days: 90, minRows: 5000, maxRows: 10000 } as const;

/** The corpus: three times the window's floor, so the pin cannot be a coincidence. */
const CORPUS = 15_000;

/** The snapshot's read point, and the seq the delta pages count up from. */
const AS_OF = 900;
const PAGE = 500;

function msg(id: string, ageDays: number): EngineMessage {
  const at = new Date(NOW.getTime() - ageDays * DAY).toISOString();
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "sender@example.test" }, to: [], cc: [],
    date: at, folder: "INBOX", snippet: "snippet", unread: false, hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: at,
  } as EngineMessage;
}

function change(m: EngineMessage, seq: number, op: "create" | "update"): SyncChange {
  return { type: "message", op, id: m.id, seq, updatedAt: m.updatedAt, entity: m };
}

function remove(id: string, seq: number): SyncChange {
  return { type: "message", op: "delete", id, seq, updatedAt: NOW.toISOString(), entity: null };
}

interface Trace {
  /** Rows the mirror HELD when each delta page was asked for. */
  held: number[];
  /** Rows the reader had TAKEN IN at the same moments. */
  received: number[];
}

interface ServerOptions {
  total?: number;
  /** Messages the server already held when the snapshot was read. */
  inSnapshot?: number;
  /** Deliver the mail again as `update`s once the creates run out — an at-least-once wire. */
  replay?: boolean;
  /** Expire the cursor once, on the delta page with this 1-based index. */
  expireOnPage?: number;
  /** After the creates, one page deleting this many of the delivered messages. */
  deleting?: number;
  /** …or this many messages this client has NEVER been delivered — see the guard that reads it. */
  deletingUnknown?: number;
  /** The tab goes away after this many delta pages: the next request never answers. */
  stopAfterPage?: number;
  onPage?: (page: number) => void;
  order?: "oldest-first" | "newest-first";
}

/**
 * THE HOSTED FIRST RUN, as the wire delivers it — and CURSOR-DRIVEN, not stateful, so a 410 that
 * sends the client back to "0" replays exactly what a server would.
 *
 * The snapshot is read while the server's own import has barely started, so it carries a handful
 * of rows or none at all: the ordinary case is a tab open when the mailbox is connected. Every
 * message the worker then ingests reaches this client as a delta `create`. That is why the
 * accumulator lives at the reader's door rather than in `runSnapshot` — on this door the snapshot
 * is the small half.
 *
 * `order` is load-bearing for the MIRROR and not for the counter, which is the point of having it:
 * `pruneToPolicy` graces the page just applied, so a stream arriving NEWEST-first hands the window
 * a freshly-graced tail every time and the mirror grows to the whole mailbox before collapsing at
 * the settle, while an importer walking the mailbox OLDEST-first pins it at the floor throughout.
 */
function hostedFirstRun(opts: ServerOptions = {}): EngineAdapter {
  const total = opts.total ?? CORPUS;
  const inSnapshot = opts.inSnapshot ?? 0;
  // `m0` is the newest and `m{total-1}` the oldest; every one of them predates the window.
  const all = Array.from({ length: total }, (_, i) => msg(`m${i}`, 400 + i / 100));
  const tail = all.slice(inSnapshot);
  const rest = (opts.order ?? "oldest-first") === "oldest-first" ? [...tail].reverse() : tail;
  const createPages = Math.ceil(rest.length / PAGE);
  const deletePages = opts.deleting !== undefined || opts.deletingUnknown !== undefined ? 1 : 0;
  const pages = (opts.replay ? createPages * 2 : createPages) + deletePages;
  let expired = false;

  /** Which page a `since` names. The snapshot's cursor is base64url of `AS_OF`; ours are decimal. */
  const pageOf = (since: string): number => {
    const n = Number(since);
    const seq = Number.isFinite(n) && since !== "" ? n : AS_OF;
    return Math.max(0, Math.round((seq - AS_OF) / PAGE));
  };

  return {
    snapshot: async (params: { cursor?: string } = {}): Promise<SyncSnapshotPage> => {
      const i = params.cursor === undefined ? 0 : Number(params.cursor);
      const slice = all.slice(0, inSnapshot).slice(i * PAGE, (i + 1) * PAGE);
      return {
        asOfSeq: AS_OF,
        changes: slice.map((m) => change(m, AS_OF, "create")),
        nextCursor: (i + 1) * PAGE < inSnapshot ? String(i + 1) : null,
        window: { days: 90, minRows: 5000 },
      };
    },
    sync: async (params: { since: string; types?: string[] }): Promise<SyncResponse> => {
      // THE RULES-FIRST PASS ASKS FOR RULES ALONE, and a harness that answered it with mail would
      // make the whole drain a rules drain — `drainRulesFirst` loops on `hasMore` and writes
      // through `applyChanges`, so no page would ever be pruned and the window would not bite
      // until the settle. Measured: thirty pages down that path before this line existed.
      if (params.types?.length === 1 && params.types[0] === "rule") {
        return {
          changes: { creates: [], updates: [], moves: [], deletes: [] },
          cursor: params.since, hasMore: false, serverTime: NOW.toISOString(),
        };
      }
      const i = pageOf(params.since);
      opts.onPage?.(i + 1);
      // THE TAB GOES AWAY MID-IMPORT: the pages already applied are on disk, this one never
      // answers, and the drain rejects. What the next engine over that mirror reads is the subject.
      if (opts.stopAfterPage !== undefined && i + 1 > opts.stopAfterPage) {
        throw new Error("the tab went away");
      }
      if (!expired && opts.expireOnPage !== undefined && i + 1 === opts.expireOnPage) {
        expired = true;
        throw new CursorExpiredError("the horizon moved");
      }
      const base0 = AS_OF + i * PAGE;
      if (deletePages === 1 && i >= (opts.replay ? createPages * 2 : createPages)) {
        // The backfill: a page that takes mail OUT of the mailbox. `deletingUnknown` names ids
        // this client was never delivered — the ordinary case on a windowed mirror, where the
        // server's own housekeeping reaches mail far below the window.
        const gone = opts.deletingUnknown !== undefined
          ? Array.from({ length: opts.deletingUnknown }, (_, k) => remove(`never-${k}`, base0 + k + 1))
          : rest.slice(0, opts.deleting).map((m, k) => remove(m.id, base0 + k + 1));
        return {
          changes: { creates: [], updates: [], moves: [], deletes: gone },
          cursor: String(AS_OF + (i + 1) * PAGE),
          hasMore: i + 1 < pages,
          serverTime: NOW.toISOString(),
        };
      }
      // Past the creates, the same mail again as `update`s at fresh seqs — the at-least-once wire.
      const wrapped = i % createPages;
      const slice = rest.slice(wrapped * PAGE, (wrapped + 1) * PAGE);
      const op = i < createPages ? "create" as const : "update" as const;
      const base = AS_OF + i * PAGE;
      return {
        changes: {
          creates: op === "create" ? slice.map((m, k) => change(m, base + k + 1, "create")) : [],
          updates: op === "update" ? slice.map((m, k) => change(m, base + k + 1, "update")) : [],
          moves: [], deletes: [],
        },
        cursor: String(AS_OF + (i + 1) * PAGE),
        hasMore: i + 1 < pages,
        serverTime: NOW.toISOString(),
      };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
  } as unknown as EngineAdapter;
}

async function freshStore(): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  return store;
}

function engineOver(store: MemoryMirrorStore, adapter: EngineAdapter): OhmailEngine {
  return new OhmailEngine({ adapter, store, now: () => NOW, storePolicy: BROWSER_WINDOW });
}

function rowsHeld(store: MemoryMirrorStore): number {
  return store.entries<EngineMessage>("message").length;
}

describe("the numerator where nothing is evicted — the narrowness control", () => {
  /**
   * WHEREVER NOTHING IS EVICTED THE TWO NUMBERS ARE THE SAME NUMBER, at every page and across a
   * delete. That is what makes this change narrow: every door with a `full` policy — the desktop's
   * own store, the demo, a mailbox smaller than the window — reads exactly what it read before.
   *
   * WATCHED RED by dropping the `if (live) this.receivedMessageRows -= 1` arm (the deletes then do
   * not count out): a count above the mirror's, at the final page and at every page after the
   * backfill.
   */
  it("equals the mirror's row count, page by page, on a policy that evicts nothing", async () => {
    const store = await freshStore();
    const seen: Array<[number, number]> = [];
    let engine: OhmailEngine;
    const adapter = hostedFirstRun({
      total: 2_000, deleting: 300,
      onPage: () => seen.push([rowsHeld(store), engine.receivedMessages()]),
    });
    engine = new OhmailEngine({ adapter, store, now: () => NOW, storePolicy: { mode: "full" } });
    await engine.syncOnce();

    expect(rowsHeld(store)).toBe(1_700); // the premise: the backfill really took mail out
    expect(engine.receivedMessages()).toBe(1_700);
    for (const [held, received] of seen) expect(received).toBe(held);
  }, 120_000);
});

describe("the import's numerator on a windowed mirror", () => {
  /**
   * THE PIN, AND THE NUMBER THAT IS NOT PINNED — the measurement this lane is about.
   *
   * WATCHED RED by `receivedMessages()` returning `this.store.list("message").length`, the mutation
   * the fix exists to undo: the received arm reads the floor and fails on the account's count.
   */
  it("holds the window's floor while it takes the whole mailbox in", async () => {
    const store = await freshStore();
    const engine = engineOver(store, hostedFirstRun());
    await engine.syncOnce();

    // The mirror pins at `minRows` exactly — every message predates `days`, so the floor is the
    // only thing keeping any row at all.
    expect(rowsHeld(store)).toBe(BROWSER_WINDOW.minRows);
    // And the reader knows it took in three times that.
    expect(engine.receivedMessages()).toBe(CORPUS);
  }, 120_000);

  /**
   * IT PASSES THE FLOOR WHILE THE IMPORT RUNS, which is the half a person sees: the old number
   * reaches the floor and stays there for the rest of the import.
   *
   * WATCHED RED by the same mutation — every sampled `received` then equals the sampled `held`.
   */
  it("climbs past the floor mid-import, while the row count does not", async () => {
    const store = await freshStore();
    const trace: Trace = { held: [], received: [] };
    let engine: OhmailEngine;
    const adapter = hostedFirstRun({
      onPage: () => {
        trace.held.push(rowsHeld(store));
        trace.received.push(engine.receivedMessages());
      },
    });
    engine = engineOver(store, adapter);
    await engine.syncOnce();

    // The row count stalls at the floor and stays there — the number a person watched not move.
    expect(Math.max(...trace.held)).toBe(BROWSER_WINDOW.minRows);
    expect(trace.held.filter((n) => n === BROWSER_WINDOW.minRows).length).toBeGreaterThan(15);
    // …while the reader's count crosses it and keeps going.
    expect(trace.received.filter((n) => n > BROWSER_WINDOW.minRows).length).toBeGreaterThan(15);
    // Monotone: a prune between two pages must never take the number back down.
    for (let i = 1; i < trace.received.length; i += 1) {
      expect(trace.received[i]).toBeGreaterThanOrEqual(trace.received[i - 1]!);
    }
  }, 120_000);

  /**
   * A DELETE FOR MAIL THIS CLIENT NEVER HELD TAKES NOTHING AWAY. On a windowed mirror the server's
   * housekeeping reaches mail far below the window, so `/sync` routinely carries deletes for rows
   * this client was never delivered and could not have counted. Subtracting for them would walk
   * the number down towards zero over a long-lived tab.
   *
   * WATCHED RED by dropping the `live` test on the delete arm — `this.receivedMessageRows -= 1`
   * unconditionally: a count short by the deletes, not the account's count.
   */
  it("takes nothing away for a delete it was never sent the message for", async () => {
    const store = await freshStore();
    const engine = engineOver(store, hostedFirstRun({ deletingUnknown: 300 }));
    await engine.syncOnce();

    expect(rowsHeld(store)).toBe(BROWSER_WINDOW.minRows);
    expect(engine.receivedMessages()).toBe(CORPUS);
  }, 120_000);

  /**
   * A REPLAYED ROW ADDS NOTHING. The delta stream is at-least-once and every message earns later
   * `update`s of its own, so a counter over raw changes would drift upward for ever — here by
   * exactly the mailbox, to twice the account.
   *
   * WATCHED RED by dropping the `this.store.get(...) === undefined` test in `countReceived`: twice the count.
   */
  it("counts a message once however many times its row arrives", async () => {
    const store = await freshStore();
    // Under the floor, so nothing is evicted and the replay lands on rows the mirror still holds.
    const engine = engineOver(store, hostedFirstRun({ total: 2_000, replay: true }));
    await engine.syncOnce();

    expect(rowsHeld(store)).toBe(2_000);
    expect(engine.receivedMessages()).toBe(2_000);
  }, 120_000);

  /**
   * A 410 WIPES THE MIRROR, SO IT WIPES THE COUNT. Every row comes back over the wire after a
   * re-bootstrap; carrying the old total through would report half as much mail again as the
   * account holds. The cursor expires on the third page, so the first pages' rows are already counted.
   *
   * WATCHED RED by deleting the `this.receivedMessageRows = 0` beside `resetForBootstrap`: the old count carried on top.
   */
  it("starts again when a re-bootstrap empties the mirror", async () => {
    const store = await freshStore();
    const seen: number[] = [];
    const engine = engineOver(store, hostedFirstRun({
      total: 2_000, expireOnPage: 3, onPage: (n) => seen.push(n),
    }));
    await engine.syncOnce();

    expect(seen).toContain(3); // the expiring page was reached
    expect(rowsHeld(store)).toBe(2_000);
    expect(engine.receivedMessages()).toBe(2_000);
  }, 120_000);
});

/** Pages of `PAGE`, so sixteen of them is far more taken in than the mirror's pinned floor. */
const STOP_AFTER = 16;
const IMPORTED = STOP_AFTER * PAGE;

/** A store that says how often the count was written down — the guard for "a page that moved nothing". */
class CountingStore extends MemoryMirrorStore {
  countWrites = 0;

  override async setMeta(key: string, value: unknown): Promise<void> {
    if (key === RECEIVED_MESSAGES_META) this.countWrites += 1;
    await super.setMeta(key, value);
  }
}

describe("the count survives the door it is counted at", () => {
  /**
   * A RELOAD MID-IMPORT. The count is a fact about the mirror and the reader is a process: while it
   * lived only in that process, a reload started it again and the import's progress fell back to
   * the mirror's row count — the window's floor, for the rest of a long import.
   *
   * WATCHED RED by deleting `await this.persistReceived()` from the delta page (nothing, then the floor), and
   * again by returning early from `restoreReceivedCount` (the same two numbers).
   */
  it("a fresh engine over the same mirror starts where the import stands", async () => {
    const store = await freshStore();
    const first = engineOver(store, hostedFirstRun({ stopAfterPage: STOP_AFTER }));
    await expect(first.syncOnce()).rejects.toThrow("the tab went away");

    // The premise: the mirror can only show the window, and the reader has taken in far more.
    expect(rowsHeld(store)).toBe(BROWSER_WINDOW.minRows);
    expect(first.receivedMessages()).toBe(IMPORTED);
    expect(store.getMeta<number>(RECEIVED_MESSAGES_META)).toBe(IMPORTED);

    // THE RELOAD: a new engine, the same mirror, nothing of the old process left.
    const reloaded = engineOver(store, hostedFirstRun());
    await reloaded.hydrate();
    expect(reloaded.receivedMessages()).toBe(IMPORTED);
    // …which is what a person sees, the row count being the floor and not the answer.
    expect(Math.max(rowsHeld(store), reloaded.receivedMessages())).toBe(IMPORTED);

    // And it CLIMBS from there: the rest of the import lands on top of what came before it.
    await reloaded.syncOnce();
    expect(rowsHeld(store)).toBe(BROWSER_WINDOW.minRows);
    expect(reloaded.receivedMessages()).toBe(CORPUS);
  }, 120_000);

  /**
   * A SECOND TAB OPENED MID-IMPORT reads the same number as the tab doing the importing. Both are
   * engines over ONE mirror; the new one has received nothing itself and can see only the window.
   *
   * WATCHED RED by the same two mutations: the cold engine reads 0, and what a person would see is
   * the window's floor.
   */
  it("a tab opened mid-import reads what the mirror has been given, not what it can show", async () => {
    const store = await freshStore();
    const importing = engineOver(store, hostedFirstRun({ stopAfterPage: STOP_AFTER }));
    await expect(importing.syncOnce()).rejects.toThrow("the tab went away");

    const coldTab = engineOver(store, hostedFirstRun());
    await coldTab.hydrate();

    expect(coldTab.receivedMessages()).toBe(importing.receivedMessages());
    expect(coldTab.receivedMessages()).toBeGreaterThan(rowsHeld(store));
    expect(coldTab.receivedMessages()).toBe(IMPORTED);
  }, 120_000);

  /**
   * A MIRROR WRITTEN BEFORE THE KEY EXISTED has nothing to read back, and its own live rows are the
   * honest start — also what keeps the arithmetic sound, since a delete counts out only for a row
   * that was LIVE and from a fresh zero one backfill would walk the count below the mailbox.
   *
   * WATCHED RED by falling back to 0 instead of the mirror's rows: a negative count, and short by the mirror after the rest.
   */
  it("a mirror with no written count starts at its own rows, never below them", async () => {
    const store = await freshStore();
    const filling = engineOver(store, hostedFirstRun({ total: 2_000 }));
    await filling.syncOnce();
    expect(rowsHeld(store)).toBe(2_000);
    // The older build: rows on disk, no count beside them.
    await store.setMeta(RECEIVED_MESSAGES_META, undefined);

    const booted = engineOver(store, hostedFirstRun({ total: 2_000, deleting: 300 }));
    await booted.hydrate();
    expect(booted.receivedMessages()).toBe(2_000);
    await booted.syncOnce();
    expect(booted.receivedMessages()).toBe(1_700);
  }, 120_000);

  /**
   * A BOOTSTRAP THE PREFIX MARKER DOES NOT NAME drops the count: the mirror it stood for is gone.
   * This is the state another tab's wipe leaves behind — meta cleared, cursor "0", a written count
   * the only survivor of a mailbox that is not there.
   *
   * WATCHED RED by deleting `if (prior !== asOfSeq) await this.resetReceived()`: the old count on top, not the new mirror's.
   */
  it("a bootstrap drops a count whose mirror is gone", async () => {
    const store = await freshStore();
    await store.setMeta(RECEIVED_MESSAGES_META, 9_000);

    const engine = engineOver(store, hostedFirstRun({ total: 2_000, inSnapshot: 500 }));
    await engine.hydrate();
    expect(engine.receivedMessages()).toBe(9_000); // the survivor, read back at boot
    await engine.syncOnce();

    expect(rowsHeld(store)).toBe(2_000);
    expect(engine.receivedMessages()).toBe(2_000);
  }, 120_000);

  /**
   * A PAGE THAT MOVED NOTHING WRITES NOTHING. The delta stream is at-least-once, so every message
   * earns later pages of its own; one durable write per page of those would be a write per poll for
   * the life of the tab.
   *
   * WATCHED RED by dropping the `=== this.persistedMessageRows` test: 8 writes, not 4.
   */
  it("writes the count down only on a page that moved it", async () => {
    const store = new CountingStore();
    await store.load();
    const sampled: number[] = [];
    const adapter = hostedFirstRun({
      total: 2_000, replay: true, onPage: () => sampled.push(store.countWrites),
    });
    const engine = new OhmailEngine({ adapter, store, now: () => NOW, storePolicy: { mode: "full" } });
    await engine.syncOnce();

    expect(engine.receivedMessages()).toBe(2_000);
    // Four writes reach the replay, one per page of creates: the bootstrap had nothing to clear.
    const beforeReplay = sampled[4];
    expect(beforeReplay).toBe(4);
    // And then the same mail again, four pages of it, which moved nothing and wrote nothing.
    expect(store.countWrites).toBe(beforeReplay);
  }, 120_000);
});
