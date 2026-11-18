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
 * ═══ WHAT A FIRST IMPORT COSTS THE WINDOW ══════════════════════════════════════════════════
 *
 * The window suite proves the window RULE. This proves WHEN it is applied, which is a different property and was
 * the defect: `drain()` skipped `pruneToPolicy` on every page answering `hasMore`, so a windowed
 * mirror grew to the whole mailbox on the way in and evicted once, at the end. Measured over a
 * large corpus with the desktop's own options: every row held at the peak — the same
 * per-message cluster count an UNWINDOWED mirror holds (as many `array:(object elements)` in a heap
 * snapshot at that moment) — and 254 whole-mirror derivations before a single row left.
 *
 * So the peak was a function of the MAILBOX while the settled state was a function of the policy,
 * and it is the peak the renderer is charged for.
 *
 * Every guard below was watched RED against a named mutation and the implementation restored.
 */

const NOW = new Date("2026-09-12T12:00:00.000Z");
const DAY = 86_400_000;
const PAGE = 10;

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

function create(type: string, id: string, entity: unknown): SyncChange {
  return { type, op: "create", id, seq: ++seq, updatedAt: NOW.toISOString(), entity };
}

/**
 * A `/sync` that paginates the way a real backlog does — `hasMore` true until the feed is gone.
 * `onPage` runs BEFORE each page is answered, which is where the peak is sampled: it is the last
 * moment the mirror holds what the previous page left it.
 */
function paginating(
  changes: SyncChange[],
  onPage?: () => void,
  opts: { page?: number } = {},
): EngineAdapter & { pages: number } {
  const page = opts.page ?? PAGE;
  const feed = [...changes];
  const a = {
    pages: 0,
    sync: async (): Promise<SyncResponse> => {
      onPage?.();
      a.pages += 1;
      const slice = feed.splice(0, page);
      return {
        changes: { creates: slice, updates: [], moves: [], deletes: [] },
        cursor: String(seq), hasMore: feed.length > 0, serverTime: NOW.toISOString(),
      };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
  };
  return a as unknown as EngineAdapter & { pages: number };
}

/** Drive one whole backlog, sampling the mirror's row count at every page boundary. */
async function importWith(
  changes: SyncChange[],
  storePolicy?: Parameters<typeof engineOf>[2],
): Promise<{ store: MemoryMirrorStore; peak: number; settled: number; pages: number }> {
  const store = new MemoryMirrorStore();
  let peak = 0;
  const sample = (): void => {
    const n = store.entries("message").length;
    if (n > peak) peak = n;
  };
  const adapter = paginating(changes, sample);
  const engine = engineOf(adapter, store, storePolicy);
  await engine.syncOnce();
  sample();
  return { store, peak, settled: store.entries("message").length, pages: adapter.pages };
}

function engineOf(
  adapter: EngineAdapter,
  store: MemoryMirrorStore,
  storePolicy?: { mode: "full" } | { mode: "windowed"; days: number; minRows: number; maxRows?: number },
): OhmailEngine {
  return new OhmailEngine({ adapter, store, now: () => NOW, ...(storePolicy ? { storePolicy } : {}) });
}

/** A backlog of messages, all far outside any window, oldest arriving first — a since=0 log replay. */
function backlog(count = 200): SyncChange[] {
  return Array.from({ length: count }, (_, i) => create("message", `m${i}`, msg(`m${i}`, 400 - i)));
}

const WINDOW = { mode: "windowed", days: 30, minRows: 5, maxRows: 8 } as const;

// ── THE PEAK ───────────────────────────────────────────────────────────────────────────────

describe("the peak during a backlog", () => {
  /**
   * THE PROPERTY: the mirror never holds more than the window plus the page in flight. The bound
   * is `maxRows + PAGE` and not `maxRows`, and that is the one-page grace, not slack — see the
   * straddle guard below for what it buys.
   *
   * WATCHED RED by restoring the rc3 drain (`this.notify(); if (resp.hasMore) continue;` above the
   * prune): peak 200 where 18 is owed.
   */
  it("never holds more than the window plus the page in flight", async () => {
    const { peak, settled } = await importWith(backlog(), WINDOW);

    expect(peak).toBeLessThanOrEqual(WINDOW.maxRows + PAGE);
    expect(settled).toBe(WINDOW.minRows);
  });

  /**
   * THE CONTROL THAT MAKES IT MEAN SOMETHING. Same backlog, same pages, `full` — the peak IS the
   * mailbox, and nothing is evicted at any point. Without this arm the guard above would pass
   * against an engine that dropped mail for any reason at all.
   *
   * WATCHED RED by deleting `if (policy.mode !== "windowed") return false;`'s guarding effect —
   * inverting it to `=== "windowed"` evicts here and keeps everything above.
   */
  it("… while a full policy holds the whole mailbox throughout, as it must", async () => {
    const { peak, settled } = await importWith(backlog(), { mode: "full" });

    expect(peak).toBe(200);
    expect(settled).toBe(200);
  });

  /**
   * AND THE ABSENT CEILING IS STILL BOUNDED — by `days` and the floor, which is what every shipped
   * windowed client had. The peak falls to the floor here because every row is 400 days old; the
   * point is that the mid-backlog pass runs for it too, rather than being a ceiling-only path.
   *
   * WATCHED RED by gating the mid-backlog prune on `policy.maxRows !== undefined` (peak 200).
   */
  it("runs for a windowed policy that set no ceiling at all", async () => {
    const { peak } = await importWith(backlog(), { mode: "windowed", days: 30, minRows: 5 });

    expect(peak).toBeLessThanOrEqual(5 + PAGE);
  });
});

// ── THE ONE-PAGE GRACE ─────────────────────────────────────────────────────────────────────

describe("the one-page grace", () => {
  /**
   * THE STRADDLE, and the fixture is built ON the cut rather than near it: `mStraddle` is the LAST
   * change of a page and the `routing_decision` that pins it is the FIRST change of the next. A
   * fixture whose pin lands mid-page passes with or without the grace, so that green would be a
   * question and not evidence.
   *
   * The message is 400 days old and beyond both bounds, so it is a genuine victim — the pin is the
   * only thing that can save it, and the pin arrives one page late.
   *
   * WATCHED RED by deleting `if (graceAbove !== undefined && row.seq > graceAbove) continue;`:
   * mStraddle is evicted at its own page and the decision then names a message that is not there.
   */
  it("keeps a message whose pin is one page behind it", async () => {
    const feed = backlog(100);
    // Land it exactly at a page boundary: index PAGE-1 of some page ⇒ last change of that page.
    const cut = 4 * PAGE - 1;
    feed[cut] = create("message", "mStraddle", msg("mStraddle", 400));
    feed[cut + 1] = create("routing_decision", "rd1", {
      id: "rd1", messageId: "mStraddle", status: "pending_approval",
    });

    const { store } = await importWith(feed, WINDOW);

    expect(store.get("message", "mStraddle")).toBeDefined();
    // The control: the message one place EARLIER is the same age and the same distance outside the
    // window, and nothing pins it. If both survived, the grace would be keeping everything.
    expect(store.get("message", `m${cut - 1}`)).toBeUndefined();
  });

  /**
   * THE OTHER HALF: the grace is one page, not a reprieve. A message whose pin never comes is
   * evicted as soon as a later page lands — the settled set is the floor, not the floor plus every
   * row the grace ever touched.
   *
   * WATCHED RED by `row.seq > graceAbove` → `row.seq > 0` (nothing is ever evictable; settled 100).
   */
  it("evicts an unpinned message as soon as a later page lands", async () => {
    const { settled } = await importWith(backlog(100), WINDOW);

    expect(settled).toBe(WINDOW.minRows);
  });

  /**
   * RE-MATERIALIZATION, which is what the grace does NOT have to cover. An evicted message whose
   * row comes back later in the SAME backlog is whole again, because a `/sync` change carries the
   * full DTO and `apply` upserts it — the clause `store.prune`'s own comment rests on. Every
   * server writer of a pinning row except `draft` emits a paired `message` update for exactly this
   * reason, so the straddle is the only window that needed closing.
   *
   * WATCHED RED by making the prune write a tombstone instead of deleting (the update is then
   * refused by the seq guard and the row stays absent).
   */
  it("re-materializes an evicted message when a later page carries it again", async () => {
    const feed = backlog(100);
    // m0 is the oldest and goes at the first prune; 50 pages later it is updated (a tag landing).
    feed.splice(60, 0, create("message", "m0", { ...msg("m0", 400), labels: ["work"] }));

    const { store } = await importWith(feed, WINDOW);

    const back = store.get<EngineMessage>("message", "m0");
    expect(back).toBeDefined();
    expect(back?.labels).toEqual(["work"]);
  });
});

// ── CONVERGENCE IS UNTOUCHED ───────────────────────────────────────────────────────────────

describe("convergence under the mid-backlog prune", () => {
  /**
   * THE CONTRACT THE PRUNE MAY NOT BREAK (§3.3): the same page twice and a page out of order
   * converge. The prune deletes without a seq and never touches the cursor or `maxSeq`, so a
   * replayed page re-applies as an upsert and an out-of-order one is refused by the seq guard
   * exactly as before — the eviction changes WHAT is held, never WHERE the client is in the log.
   *
   * WATCHED RED by moving `maxSeq` backwards in the prune (the duplicate page then re-applies rows
   * the client had already passed and the two sets diverge).
   */
  it("a duplicated page and a reordered page land the same set as a clean run", async () => {
    const clean = await importWith(backlog(80), WINDOW);

    const feed = backlog(80);
    const dup = feed.slice(20, 20 + PAGE);       // one page, sent twice
    const messy = [...feed.slice(0, 30), ...dup, ...feed.slice(30)];
    const shuffled = await importWith(messy, WINDOW);

    expect(shuffled.settled).toBe(clean.settled);
    expect(shuffled.store.entries("message").map((e) => e.id).sort())
      .toEqual(clean.store.entries("message").map((e) => e.id).sort());
  });

  /**
   * AND THE CURSOR MOVES FORWARD ONLY. Named on its own because a prune that reset it would make
   * every client re-request its whole backlog on the next poll — a defect with no symptom on one
   * machine and a stampede on a server.
   *
   * WATCHED RED by calling `store.resetForBootstrap()` in place of `store.prune(...)`.
   */
  it("leaves the cursor and maxSeq where the drain put them", async () => {
    const store = new MemoryMirrorStore();
    const engine = engineOf(paginating(backlog(60)), store, WINDOW);
    await engine.syncOnce();

    expect(store.getCursor()).not.toBe("0");
    expect(store.maxSeq()).toBeGreaterThan(0);
    expect(Number(store.getCursor())).toBe(store.maxSeq());
  });
});

// ── THE EAGER PASS WAITS FOR THE CATCH-UP ──────────────────────────────────────────────────

describe("the eager body pass during a catch-up", () => {
  /** An adapter that records which bodies the eager pass asked for. */
  function withBodies(changes: SyncChange[]): EngineAdapter & { asked: string[]; pages: number } {
    const base = paginating(changes) as EngineAdapter & { pages: number };
    const asked: string[] = [];
    return Object.assign(base, {
      asked,
      fetchBody: async (id: string) => { asked.push(id); return { text: `FULL ${id}`, html: null, loadedRemoteContent: false }; },
      fetchBodies: async (ids: string[]) => {
        asked.push(...ids);
        return ids.map((id) => ({ messageId: id, text: `FULL ${id}`, html: null, loadedRemoteContent: false }));
      },
    });
  }

  /**
   * The pass asks for the newest `EAGER_BODIES_MAX` after every settled drain. During an import the
   * newest N keeps MOVING, so each pass fetches a batch of bodies the next one evicts — the pass
   * and the `BODY_CACHE_MAX` evictor chasing each other, which is the condition that bound was
   * chosen to prevent. Measured over a polled large import: most of the whole-mirror
   * derivations and most of the peak's memory, still held after two full collects.
   *
   * WATCHED RED by deleting `if (!this.caughtUpInOnePage) return Promise.resolve();` — the pass
   * runs mid-catch-up and `asked` is non-empty on the first assertion.
   */
  it("does not run after a drain that needed more than one page", async () => {
    const adapter = withBodies(backlog(60));
    const store = new MemoryMirrorStore();
    const engine = new OhmailEngine({
      adapter, store, now: () => NOW, storePolicy: WINDOW, eagerBodies: true,
    });

    await engine.syncOnce();
    expect(adapter.pages).toBeGreaterThan(1);
    await engine.prefetchRecentBodies();
    await engine.eagerBodiesIdle();

    expect(adapter.asked).toEqual([]);
  });

  /**
   * AND IT IS DEFERRED, NOT DROPPED — the next poll that settles inside one page runs it. Without
   * this arm the guard above would pass against an engine whose eager pass never ran at all, which
   * is the failure the opt-in flag and the ruling it implements exist to avoid.
   *
   * WATCHED RED by `this.caughtUpInOnePage = false;` at the settle (the pass never resumes).
   */
  it("runs at the next drain that settles inside one page", async () => {
    const adapter = withBodies(backlog(60));
    const store = new MemoryMirrorStore();
    const engine = new OhmailEngine({
      adapter, store, now: () => NOW, storePolicy: WINDOW, eagerBodies: true,
    });

    await engine.syncOnce();       // the catch-up: many pages
    await engine.syncOnce();       // the next poll: the feed is empty, one page, settled
    await engine.prefetchRecentBodies();
    await engine.eagerBodiesIdle();

    expect(adapter.asked.length).toBeGreaterThan(0);
    // It asked for what the window HOLDS, not for the mailbox.
    expect(adapter.asked.length).toBeLessThanOrEqual(WINDOW.minRows);
  });
});
