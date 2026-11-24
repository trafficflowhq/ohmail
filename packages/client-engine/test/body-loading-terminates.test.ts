import type { EngineMessage, MessageBodyRecord, MessageBodyWire, MutationOutcome } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HttpAdapter,
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";
import { BODY_FETCH_TIMEOUT_MS } from "../src/adapters/http-adapter.js";

/**
 * ── "LOADING THE FULL MESSAGE…" HAS TO END. THAT IS THE WHOLE FILE. ─────────────────────
 *
 * `body-hydration.test.ts` proves the state MACHINE — that a 500 lands in `failed`, that a
 * failure is not re-asked automatically, that concurrent callers join one request. It proves
 * all of that against an adapter that always answers.
 *
 * The defect this file is written for is the one that appears when the adapter does NOT answer,
 * and it was invisible to every existing test because every existing double resolves. The
 * loading note was reported appearing often and sticking; the mechanism turned out to be worse
 * than a stuck spinner:
 *
 *   1. `fetch` has no deadline, so a hung request never settles.
 *   2. `fetchBodyInto` writes `{state:"loading"}` and its only exits are the two arms of a
 *      try/catch that never runs.
 *   3. `hydrateBody`'s single-flight map is cleared from that request's own `.finally`, so the
 *      entry survives for the life of the tab — and every later call, INCLUDING the Retry
 *      button's `{retry:true}`, short-circuits on `if (inFlight) return inFlight` and joins the
 *      promise that is never coming back.
 *
 * So the spinner was not merely stuck, it was unrecoverable, and no surface renders a control
 * for `loading` because `loading` was designed to be a state that ends.
 *
 * Every assertion below was watched go red against the named mutation and then restored.
 */

const NOW = new Date("2026-08-07T12:00:00.000Z");
let seq = 0;

function msg(id: string): EngineMessage {
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
    date: NOW.toISOString(),
    folder: "ohmail/News",
    snippet: `snippet of ${id}`,
    unread: true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: NOW.toISOString(),
  };
}

/** A store holding one ordinary message the engine will agree to ask about. */
async function seeded(): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  const m = msg("m1");
  await store.applyChanges([
    { type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m } as SyncChange,
  ]);
  return store;
}

/** The two calls the engine makes that are not the body read, answered quietly. */
const QUIET = {
  sync: async (): Promise<SyncResponse> => ({
    changes: { creates: [], updates: [], moves: [], deletes: [] },
    cursor: "0",
    hasMore: false,
    serverTime: NOW.toISOString(),
  }),
  mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
};

function engineOn(store: MemoryMirrorStore, adapter: Partial<EngineAdapter>): OhmailEngine {
  return new OhmailEngine({ adapter: { ...QUIET, ...adapter } as EngineAdapter, store, now: () => NOW });
}

const bodyRec = (engine: OhmailEngine, id = "m1"): MessageBodyRecord | undefined =>
  engine.read().get<MessageBodyRecord>("message_body", id);

/**
 * Let the awaited writes inside `fetchBodyInto` settle.
 *
 * ONE `await Promise.resolve()` IS NOT ENOUGH, and the reason is the thing this slice changed:
 * the `loading` write is now awaited BEFORE the adapter is called, so the fetch has not even
 * been requested after a single microtask turn. A test that checked too early read `asked === 1`
 * where it meant `2` and looked exactly like the retry being swallowed.
 */
const flush = async (turns = 12): Promise<void> => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

// ══ 1. a transport that never answers ══════════════════════════════════════════════════

describe("a body request that never settles still leaves the loading state", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("times out, lands in failed, and frees the single-flight slot so Retry can work", async () => {
    // ── THE GUARD FOR THE WHOLE DEFECT ────────────────────────────────────────────────
    //
    // The injected fetch NEVER resolves — precisely the shape (a dead proxy, a half-open
    // socket, a lambda killed between handshake and reply) that no other test in this repo
    // produces. Without the deadline this hangs in `loading` for ever.
    //
    // Mutation: drop the `withDeadline` wrapper from `HttpAdapter.fetchBody`, i.e.
    // `return this.readBody(messageId, undefined)`. Real failure text:
    //   AssertionError: expected 'loading' to be 'failed'
    let asked = 0;
    const store = await seeded();
    const http = new HttpAdapter({
      baseUrl: "",
      fetch: () => { asked++; return new Promise<Response>(() => {}); },
    });
    const engine = engineOn(store, { fetchBody: (id) => http.fetchBody(id) });

    const first = engine.hydrateBody("m1");
    await flush();
    expect(bodyRec(engine)?.state).toBe("loading");

    await vi.advanceTimersByTimeAsync(BODY_FETCH_TIMEOUT_MS + 1);
    await first;

    // The state a surface can actually render, with a Retry beside it.
    expect(bodyRec(engine)?.state).toBe("failed");
    expect(bodyRec(engine)?.error ?? "").toContain("did not answer");
    expect(asked).toBe(1);

    // ── AND THE SLOT IS FREE, WHICH IS THE HALF THAT MADE IT UNRECOVERABLE ───────────
    // A Retry that joins the dead promise is a button that does nothing. This asks again.
    const second = engine.hydrateBody("m1", { retry: true });
    await flush();
    expect(asked).toBe(2);
    await vi.advanceTimersByTimeAsync(BODY_FETCH_TIMEOUT_MS + 1);
    await second;
    expect(bodyRec(engine)?.state).toBe("failed");
  });

  it("the deadline is the same figure the sibling read route uses", () => {
    // Not a tautology — it pins the CHOICE. This was 20 s on a payload argument that
    // measurement refuted (the route answers in ~100 ms and the response is gzipped), and the
    // docblock records that. Mutation: set it back to 20_000. Real failure text:
    //   AssertionError: expected 20000 to be 12000
    expect(BODY_FETCH_TIMEOUT_MS).toBe(12_000);
  });
});

// ══ 2. loading never outlives the promise ══════════════════════════════════════════════

describe("loading is never the resting state", () => {
  it("whatever the adapter does, the record is not loading once hydrateBody resolves", async () => {
    // THE INVARIANT AS ONE PROPERTY over the four ways this can end. Mutation: delete the
    // `catch` arm's `failBody` call in `fetchBodyInto`. Real failure text:
    //   AssertionError: expected 'loading' not to be 'loading'  (for the throwing adapter)
    const cases: Array<[string, () => Promise<MessageBodyWire | null>]> = [
      ["resolves", async () => ({ text: "hi", html: "<p>hi</p>", loadedRemoteContent: false })],
      ["throws", async () => { throw new Error("500 from the server"); }],
      ["answers null", async () => null],
      ["rejects with a non-Error", async () => { throw "a bare string"; }],
    ];
    for (const [name, fetchBody] of cases) {
      const store = await seeded();
      const engine = engineOn(store, { fetchBody: fetchBody as EngineAdapter["fetchBody"] });
      await engine.hydrateBody("m1");
      expect(bodyRec(engine)?.state, `adapter that ${name}`).not.toBe("loading");
    }
  });

  it("never rejects, even when the mirror itself refuses every write", async () => {
    // `hydrateBody`'s callers are React effects and click handlers; a rejection there is an
    // unhandled promise over somebody's mailbox. The first `loading` write used to sit OUTSIDE
    // the try, so a failing IndexedDB propagated straight out.
    //
    // Mutation: move the `loading` write back above the `try` in `fetchBodyInto`. Real failure
    // text:
    //   AssertionError: promise rejected "Error: quota exceeded" instead of resolving
    const store = await seeded();
    const original = store.putLocal.bind(store);
    vi.spyOn(store, "putLocal").mockImplementation((async (kind: string, id: string, rec: unknown) => {
      if (kind === "message_body") throw new Error("quota exceeded");
      return original(kind as never, id, rec as never);
    }) as typeof store.putLocal);

    const engine = engineOn(store, {
      fetchBody: async () => ({ text: "hi", html: null, loadedRemoteContent: false }),
    });
    await expect(engine.hydrateBody("m1")).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });
});

// ══ 3. a re-read does not take the message off the screen ══════════════════════════════

describe("re-reading a body does not blank the one already on screen", () => {
  it("a ready record survives until the replacement arrives", async () => {
    // ── WHY THIS IS A DEFECT AND NOT A COSMETIC DETAIL ────────────────────────────────
    //
    // `bodyOf` answers a `loading` record with the SNIPPET, so writing the loading marker over
    // a `ready` body collapses a message the reader is looking at to one line. The re-read path
    // (a `ready` record with no `html` key, written by a build that predates the html part) is
    // exactly such a caller and it fires on a message just opened — and if the fetch then
    // hangs, the reader has LOST a body they already had.
    //
    // Mutation: drop the `held?.state !== "ready"` test, writing `loading` unconditionally.
    // Real failure text:
    //   AssertionError: expected 'loading' to be 'ready'
    const store = await seeded();
    // A pre-html record: `ready`, with no `html` key at all — the shape that forces a re-read.
    await store.putLocal("message_body", "m1", {
      messageId: "m1", state: "ready", text: "the old text", loadedRemoteContent: false,
    } as MessageBodyRecord);

    let release: ((w: MessageBodyWire) => void) | null = null;
    const engine = engineOn(store, {
      fetchBody: () => new Promise<MessageBodyWire>((res) => { release = res; }),
    });

    const inflight = engine.hydrateBody("m1");
    await flush();
    // MID-FLIGHT: the reader still has their message.
    expect(bodyRec(engine)?.state).toBe("ready");
    expect(bodyRec(engine)?.text).toBe("the old text");

    release!({ text: "the new text", html: "<p>new</p>", loadedRemoteContent: false });
    await inflight;
    expect(bodyRec(engine)?.state).toBe("ready");
    expect(bodyRec(engine)?.html).toBe("<p>new</p>");
  });

  it("but a message with nothing to show still says it is loading", async () => {
    // The other half — dropping the loading marker altogether would leave a first open silent.
    // Mutation: remove the `loading` write entirely. Real failure text:
    //   AssertionError: expected undefined to be 'loading'
    const store = await seeded();
    let release: ((w: MessageBodyWire) => void) | null = null;
    const engine = engineOn(store, {
      fetchBody: () => new Promise<MessageBodyWire>((res) => { release = res; }),
    });
    const inflight = engine.hydrateBody("m1");
    await flush();
    expect(bodyRec(engine)?.state).toBe("loading");
    release!({ text: "hi", html: null, loadedRemoteContent: false });
    await inflight;
    expect(bodyRec(engine)?.state).toBe("ready");
  });
});
