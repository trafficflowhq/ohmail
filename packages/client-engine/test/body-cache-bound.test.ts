import type { EngineMessage, MessageBodyRecord, MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  BODY_CACHE_MAX,
  EAGER_BODIES_MAX,
  MemoryMirrorStore,
  OhmailEngine,
  RENDERED_PINS,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * ═══ THE HYDRATED BODIES ARE BOUNDED, AND READING DOES NOT GROW WITHOUT LIMIT ════════════════
 *
 * A `message_body` is client-local, so `/sync` can never remove one, and before the desktop's
 * mirror became a window nothing removed one at all: a reading session's bodies grew for as long as
 * the window stayed open. Each is a whole mail — 57 KB measured on realistic HTML with an inline
 * image — so the eager pass's batch alone is megabytes
 * (the project's design notes).
 *
 * The bound is {@link BODY_CACHE_MAX}, and the test reads the shipped constant rather than a copy.
 * It is the EAGER window and deliberately not {@link RENDERED_PINS}: an evicted body is an absent
 * record, which the next open re-fetches, and `prefetchRecentBodies` asks for the newest
 * {@link EAGER_BODIES_MAX} after every settled drain — so a smaller bound would have the pass and
 * the evictor chase each other for ever. That relationship is asserted below, because it is the
 * reason the number is what it is.
 */

const NOW = new Date("2026-09-11T20:38:00.000Z");

function msg(id: string, i: number): EngineMessage {
  const date = new Date(NOW.getTime() - i * 60_000).toISOString();
  return {
    id,
    accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "sender@example.test" },
    to: [], cc: [], date, folder: "INBOX", snippet: `snippet ${id}`, unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  };
}

/**
 * An engine over `n` messages whose bodies are all available — over `store`, which the caller may
 * hand back to a second engine: that pair IS a restart, and the store is what survives one.
 */
async function engineOver(n: number, store: MemoryMirrorStore = new MemoryMirrorStore()) {
  let seq = 0;
  let served = false;
  const ids = Array.from({ length: n }, (_, i) => `m${i}`);
  const adapter = {
    sync: async (): Promise<SyncResponse> => {
      const creates: SyncChange[] = served ? [] : ids.map((id, i) => {
        const m = msg(id, i);
        return { type: "message", op: "create", id, seq: ++seq, updatedAt: m.updatedAt, entity: m };
      });
      served = true;
      return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: `c${seq}`, hasMore: false, serverTime: NOW.toISOString() };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async (id: string) => ({ text: `FULL ${id}`, html: `<p>${id}</p>`, loadedRemoteContent: false }),
    fetchBodies: async (batch: string[]) =>
      batch.map((id) => ({ messageId: id, text: `FULL ${id}`, html: `<p>${id}</p>`, loadedRemoteContent: false })),
  } as never;
  const engine = new OhmailEngine({ adapter, store, now: () => NOW, eagerBodies: true });
  await engine.start();
  await engine.syncOnce();
  return { engine, ids, store, adapter };
}

/**
 * The mail and the bodies a previous session left on disk, newest first. The last `failedTail`
 * ids — the OLDEST mail — carry a `failed` record instead: records that hold no mail at all.
 */
async function persistedSession(
  n: number, failedTail = 0,
): Promise<{ store: MemoryMirrorStore; ids: string[] }> {
  const store = new MemoryMirrorStore();
  const ids = Array.from({ length: n }, (_, i) => `m${i}`);
  let seq = 0;
  const creates: SyncChange[] = ids.map((id, i) => {
    const m = msg(id, i);
    return { type: "message", op: "create", id, seq: ++seq, updatedAt: m.updatedAt, entity: m };
  });
  await store.applyResponse({
    changes: { creates, updates: [], moves: [], deletes: [] },
    cursor: `c${seq}`, hasMore: false, serverTime: NOW.toISOString(),
  });
  await store.commitLocal(
    ids.map((id, i) => ({
      type: "message_body", id,
      entity: (i >= n - failedTail
        ? { messageId: id, state: "failed", text: "", error: "500", failedAt: NOW.getTime() - 1_000 }
        : { messageId: id, state: "ready", text: `FULL ${id}`, html: null }) satisfies MessageBodyRecord,
    })),
    [],
  );
  return { store, ids };
}

/** Answers nothing: the reload cases are about what the LOAD restored, not about the network. */
const quiet = {
  sync: async (): Promise<SyncResponse> => ({
    changes: { creates: [], updates: [], moves: [], deletes: [] },
    cursor: "c0", hasMore: false, serverTime: NOW.toISOString(),
  }),
  mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
} as never;

const bodiesHeld = (engine: OhmailEngine): number =>
  engine.read().list<MessageBodyRecord>("message_body").length;

describe("the hydrated body cache is bounded", () => {
  it("opening far more messages than the bound leaves the bound, not the opens", async () => {
    // Deliberately over the ceiling, and by more than one batch.
    const over = BODY_CACHE_MAX + 120;
    const { engine, ids } = await engineOver(over);

    for (const id of ids) await engine.hydrateBody(id, { urgent: true });

    expect(bodiesHeld(engine)).toBeLessThanOrEqual(BODY_CACHE_MAX);
    // And it really did read them all — a bound that passed by fetching nothing proves nothing.
    expect(bodiesHeld(engine)).toBeGreaterThan(0);
  });

  /**
   * WHAT GIVES WAY IS THE OLDEST MAIL, NOT THE LONGEST-AGO READ. This case read the opposite until
   * 0.19.1 — it asserted a write-recency LRU, which is what made the eager pass drop the newest
   * bodies it had just fetched and re-fetch them for ever (`body-cache-evicts-by-date.test.ts`
   * holds the settle). The ids here are opened NEWEST first, so the two orders disagree about
   * every one of them and the assertion can only be satisfied by the date.
   */
  it("keeps the newest mail whatever order it was read in, and drops the oldest", async () => {
    const over = BODY_CACHE_MAX + 40;
    const { engine, ids } = await engineOver(over);
    for (const id of ids) await engine.hydrateBody(id, { urgent: true });

    const reader = engine.read();
    // The newest mail, read first and so longest ago of all of them, is still here.
    expect(reader.get<MessageBodyRecord>("message_body", ids[0]!)?.state).toBe("ready");
    // The oldest mail the reader is no longer holding is gone...
    expect(reader.get<MessageBodyRecord>("message_body", ids[over - RENDERED_PINS - 1]!)).toBeUndefined();
    // ...while the last {@link RENDERED_PINS} opened stay, whatever their date. That hold is the
    // only thing between an old message somebody is reading and an eviction for being old.
    expect(reader.get<MessageBodyRecord>("message_body", ids[over - 1]!)?.state).toBe("ready");
  });

  /**
   * AN EVICTED BODY IS RE-READABLE. The eviction is a DELETE, not a tombstone: an absent record is
   * "never asked" and the next open fetches it again. A tombstone would read as "asked, and there
   * is nothing", and the mail would render empty for ever.
   */
  it("re-reads an evicted body when it is opened again", async () => {
    const over = BODY_CACHE_MAX + 20;
    const { engine, ids } = await engineOver(over);
    for (const id of ids) await engine.hydrateBody(id, { urgent: true });

    // Whichever the trim took — named by the store rather than by a rank, so the case stays about
    // the delete and not about the order the case above pins.
    const reader = engine.read();
    const evicted = ids.find((id) => reader.get("message_body", id) === undefined);
    expect(evicted).toBeDefined();

    await engine.hydrateBody(evicted!, { urgent: true });
    expect(engine.read().get<MessageBodyRecord>("message_body", evicted!)?.state).toBe("ready");
  });

  /**
   * THE REASON THE NUMBER IS WHAT IT IS. A bound below the eager window would be re-filled by
   * `prefetchRecentBodies` after every settled drain, so the evictor and the pass would chase each
   * other for ever. This is the assertion that refuses that change.
   */
  it("is at least the eager window, or the eager pass would refill what the trim drops", () => {
    expect(BODY_CACHE_MAX).toBeGreaterThanOrEqual(EAGER_BODIES_MAX);
    expect(BODY_CACHE_MAX).toBeGreaterThan(RENDERED_PINS);
  });

  it("an eager pass settles exactly at the bound and the trim drops nothing it will re-ask", async () => {
    const { engine } = await engineOver(EAGER_BODIES_MAX + 200);
    engine.prefetchRecentBodies();
    await engine.eagerBodiesIdle();
    const first = bodiesHeld(engine);
    expect(first).toBeLessThanOrEqual(BODY_CACHE_MAX);

    // A second settled pass must not churn: nothing to re-ask, nothing to drop.
    engine.prefetchRecentBodies();
    await engine.eagerBodiesIdle();
    expect(bodiesHeld(engine)).toBe(first);
  });
});

/**
 * ═══ AND THE BODIES A RELOAD RESTORED ARE COUNTED TOWARD IT ══════════════════════════════════
 *
 * `store.load()` brings every persisted `message_body` back into the mirror. Until 0.19.0 nothing
 * added those ids to the held set the trim evicts from, so the bound was paid only by what the
 * SESSION fetched: one session persisted up to {@link BODY_CACHE_MAX}, the next restored them
 * uncounted and filled the bound again, and the persisted set grew by a bound per restart — the
 * unbounded shape this file closes, across reloads instead of within one session.
 */
describe("the bodies a reload restores count toward the bound", () => {
  it("trims a store left over the bound, the oldest mail first, publishing once", async () => {
    const K = 5;
    const { store, ids } = await persistedSession(BODY_CACHE_MAX + K);
    expect(store.list("message_body").length).toBe(BODY_CACHE_MAX + K);

    const engine = new OhmailEngine({ adapter: quiet, store, now: () => NOW });
    let notifies = 0;
    engine.subscribe(() => { notifies += 1; });
    await engine.hydrate();

    expect(store.list("message_body").length).toBe(BODY_CACHE_MAX);
    // ONE trim for the whole restored set — its publish, and hydrate's own. Never one per body.
    expect(notifies).toBe(2);

    const reader = engine.read();
    // The K oldest by MESSAGE DATE are the ones gone — `ids` is newest first.
    for (const id of ids.slice(-K)) expect(reader.get("message_body", id)).toBeUndefined();
    expect(reader.get<MessageBodyRecord>("message_body", ids[0]!)?.state).toBe("ready");
    expect(reader.get<MessageBodyRecord>("message_body", ids[BODY_CACHE_MAX - 1]!)?.state).toBe("ready");
  });

  /** The ordinary boot: under the bound, the trim finds nothing to do and nobody loses a body. */
  it("evicts nothing from a store under the bound", async () => {
    const under = BODY_CACHE_MAX - 4;
    const { store, ids } = await persistedSession(under);

    const engine = new OhmailEngine({ adapter: quiet, store, now: () => NOW });
    let notifies = 0;
    engine.subscribe(() => { notifies += 1; });
    await engine.hydrate();

    expect(notifies).toBe(1); // hydrate's publish alone: the trim committed nothing
    expect(store.list("message_body").length).toBe(under);
    const reader = engine.read();
    expect(reader.get<MessageBodyRecord>("message_body", ids[under - 1]!)?.state).toBe("ready");
  });

  /**
   * ONLY A RECORD THAT HOLDS MAIL OCCUPIES A SLOT — the hydrate side of `holdBody`'s rule. A
   * `failed` record holds nothing, so counting one would have the bound paid by records holding
   * nothing and evict a real body in their place.
   */
  it("counts the bodies that hold mail, not the records that hold none", async () => {
    const failed = 5;
    const { store } = await persistedSession(BODY_CACHE_MAX + failed, failed);

    const engine = new OhmailEngine({ adapter: quiet, store, now: () => NOW });
    await engine.hydrate();

    // The ready bodies are exactly the bound: nothing is owed, and nothing is dropped.
    expect(store.list("message_body").length).toBe(BODY_CACHE_MAX + failed);
  });

  /**
   * THE SEQUENCE THE DEFECT NEEDED: fill the bound, reload, then read older mail. Uncounted, the
   * restored thousand let the second session fetch its own thousand on top.
   */
  it("a restart plus a second session's reading stays at one bound, not two", async () => {
    const { engine, ids, store, adapter } = await engineOver(BODY_CACHE_MAX + 40);
    engine.prefetchRecentBodies();
    await engine.eagerBodiesIdle();
    expect(store.list("message_body").length).toBe(BODY_CACHE_MAX);

    // The restart: a new engine over the store the first session left behind.
    const next = new OhmailEngine({ adapter, store, now: () => NOW });
    await next.hydrate();
    expect(store.list("message_body").length).toBe(BODY_CACHE_MAX);

    // And it reads mail the first session's window never held.
    const older = ids.slice(BODY_CACHE_MAX, BODY_CACHE_MAX + 6);
    for (const id of older) await next.hydrateBody(id, { urgent: true });

    expect(store.list("message_body").length).toBe(BODY_CACHE_MAX);
    const reader = next.read();
    for (const id of older) expect(reader.get<MessageBodyRecord>("message_body", id)?.state).toBe("ready");
  });
});
