/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncChange,
  threadOf,
} from "@ohmail/client-engine";
import { useMessageAttachments } from "../app/shell/attachments.js";

/**
 * ═══ THE THREAD'S LISTS ARE LOADED, NOT ONLY THE FOCUSED MESSAGE'S ═════════════════════════
 *
 * The found defect (a live account): the reader's own SENT reply — worker-ingested from the
 * Sent folder, two files extracted and stamped server-side — rendered inside its open thread
 * with no attachments anywhere, because the strip's data has to be ASKED for
 * (`engine.loadAttachments` fills state that `itemsOf` merely reads) and the only asker was
 * keyed on the SELECTED id. Every sibling's list sat at the silent default for the life of the
 * view. `MessageCard` now renders the strip (held by `conversation.test.ts`); this file holds
 * the other half — that somebody actually asks — against the REAL hook over a REAL engine.
 *
 * ── WHY THE ASKER IS THE HOOK AND NOT THE CARD ─────────────────────────────────────────────
 *
 * The card is mounted twice while the reader is open (the mounted-twice rule the whole message
 * chrome exists for), so a card-owned ask would need a card-owned release, and an unmount-time
 * release from one mount revokes object URLs the other mount is still showing. One owner —
 * `useMessageAttachments`, mounted once in `AppShell` — asks for the whole conversation and
 * releases the whole conversation.
 *
 * ── THE TWO LIFECYCLE TRAPS PINNED HERE ────────────────────────────────────────────────────
 *
 *  1. A WITHIN-thread selection move keeps the same conversation ids, so an effect keyed on
 *     the id list alone would never re-run — while the selected-id effect's cleanup has already
 *     released everything. The re-ask after such a move is asserted below.
 *  2. Selecting AWAY must release every list the selection asked for — the focused message AND
 *     the siblings — or a session spent reading threads accumulates every fetched byte for the
 *     life of the tab (the "ohmail stores no attachment bytes" cost, rebuilt in the browser).
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(engine: OhmailEngine, messageId: string | null): Promise<void> {
  if (!root) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(h(Harness, { engine, messageId }));
  });
  // One settled microtask queue: `loadAttachments` resolves, the calendar pass declines, and
  // the notify-driven re-render lands, before anything below reads engine state.
  await act(async () => { await Promise.resolve(); });
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

afterEach(unmount);

/** The chrome as of the LAST render — how a test presses the group verb the way a panel does. */
let latestChrome: ReturnType<typeof useMessageAttachments>;

/** `MessagePane`'s own wiring — the hook, nothing else; the strip's render is held elsewhere. */
function Harness({ engine, messageId }: { engine: OhmailEngine; messageId: string | null }) {
  latestChrome = useMessageAttachments(engine, messageId, { shell: "none", conversationOf: (id: string) => threadOf(engine.read(), id), onDownloadAllFailed: () => {} });
  return null;
}

/** The minimum a mirror row needs for `threadOf` and this seam: identity, thread, order. */
function seed(id: string, threadId: string | null, date: string): EngineMessage {
  return {
    id,
    accountId: "a",
    mailboxId: "mb",
    threadId,
    messageIdHeader: null,
    subject: `s-${id}`,
    from: { name: null, address: `${id}@example.invalid` },
    to: [],
    cc: [],
    date,
    folder: "INBOX",
    snippet: "",
    unread: false,
    hasAttachments: true,
    attachmentCount: 1,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: date,
  } as unknown as EngineMessage;
}

/** A three-message thread — m3 is the newest (the one an inbox press opens) — plus a loner. */
const ROWS = [
  seed("m1", "t1", "2026-08-24T09:00:00.000Z"),
  seed("m2", "t1", "2026-08-25T09:00:00.000Z"),
  seed("m3", "t1", "2026-08-26T09:00:00.000Z"),
  seed("solo", null, "2026-08-26T10:00:00.000Z"),
];

interface Rig {
  engine: OhmailEngine;
  /** Every id `listAttachments` was asked for, in order — the seam's observable act. */
  asked: string[];
  /** Queue one message for the NEXT `syncOnce` — how a test lands a drain on the open thread. */
  enqueueSync: (m: EngineMessage) => void;
  /** Resolve every list read currently in the air. Returns how many it released. */
  settleLists: () => number;
  /** How many list reads are in the air RIGHT NOW, and the highest that has ever been. */
  inFlight: () => number;
  maxInFlight: () => number;
  /** Resolve every byte fetch currently in the air. */
  settleBytes: () => number;
}

async function engineWith(rows: EngineMessage[] = ROWS, opts: { defer?: boolean } = {}): Promise<Rig> {
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges(
    rows.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
  const asked: string[] = [];
  let flying = 0;
  let maxFlying = 0;
  const listWaiters: Array<() => void> = [];
  const byteWaiters: Array<() => void> = [];
  const pending: EngineMessage[] = [];
  const adapter: EngineAdapter = {
    sync: async () => ({
      changes: {
        creates: pending.splice(0, pending.length).map((m): SyncChange => ({
          type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
        })),
        updates: [], moves: [], deletes: [],
      },
      cursor: String(seq), hasMore: false, serverTime: "2026-08-26T12:00:00.000Z",
    }),
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    listAttachments: async (messageId: string) => {
      asked.push(messageId);
      flying += 1;
      maxFlying = Math.max(maxFlying, flying);
      if (opts.defer) await new Promise<void>((res) => listWaiters.push(res));
      flying -= 1;
      return [{ id: `att-${messageId}`, messageId, filename: `${messageId}.png`, contentType: "image/png", sizeBytes: 7, inline: false, contentId: null }];
    },
    fetchAttachment: async () => {
      if (opts.defer) await new Promise<void>((res) => byteWaiters.push(res));
      return new Blob(["x"], { type: "image/png" });
    },
  };
  const drain = (w: Array<() => void>): number => {
    const held = w.splice(0, w.length);
    for (const release of held) release();
    return held.length;
  };
  return {
    engine: new OhmailEngine({ store, adapter }),
    asked,
    enqueueSync: (m) => pending.push(m),
    settleLists: () => drain(listWaiters),
    inFlight: () => flying,
    maxInFlight: () => maxFlying,
    settleBytes: () => drain(byteWaiters),
  };
}

const countOf = (asked: string[], id: string): number => asked.filter((a) => a === id).length;

describe("opening a message loads its whole conversation's attachment lists", () => {
  it("asks for EVERY thread member's list, once each — the sibling strips' data exists to read", async () => {
    const { engine, asked } = await engineWith();
    await mount(engine, "m3");

    // THE GUARD for the found defect. Delete the sibling-loading effect in
    // `useMessageAttachments` and this drops to `["m3"]` — the sent reply's panel back to
    // rendering nothing, exactly as shipped.
    expect([...asked].sort()).toEqual(["m1", "m2", "m3"]);

    // Once each, though two triggers overlap on the selected id (the selected-id effect and the
    // conversation sweep): the release-set guard makes the overlap idempotent.
    for (const id of ["m1", "m2", "m3"]) expect(countOf(asked, id)).toBe(1);

    // And the answer is READABLE where the sibling strip reads it — engine state, not a value
    // threaded through props.
    const held = engine.attachmentsOf("m1");
    expect(held.state).toBe("ready");
    expect(held.state === "ready" && held.items[0]!.filename).toBe("m1.png");
  });

  it("re-asks after a WITHIN-thread selection move — same conversation key, released state", async () => {
    const { engine, asked } = await engineWith();
    await mount(engine, "m3");
    await mount(engine, "m2");

    // The selection change released the whole set (cleanup) — the trap is an effect keyed on
    // the conversation's ids alone, which would compare equal and leave every strip empty for
    // a reader who pressed an older message on the same thread. The re-ask is the proof the
    // key includes the selection.
    expect(countOf(asked, "m1")).toBe(2);
    expect(engine.attachmentsOf("m1").state).toBe("ready");
  });

  it("selecting AWAY releases the SIBLINGS' lists too, not only the focused message's", async () => {
    const { engine, asked } = await engineWith();
    await mount(engine, "m3");
    expect(engine.attachmentsOf("m1").state).toBe("ready");

    await mount(engine, "solo");

    // Back to the silent default — the held list is gone, which is what "released" means for
    // metadata (for fetched bytes it is the object-URL revoke riding the same call). A loner
    // has no conversation (`threadOf` answers `[]`), so only its own list was asked for.
    expect(engine.attachmentsOf("m1").state).toBe("loading");
    expect(engine.attachmentsOf("m2").state).toBe("loading");
    expect(engine.attachmentsOf("m3").state).toBe("loading");
    expect(countOf(asked, "solo")).toBe(1);
    expect([...asked].sort()).toEqual(["m1", "m2", "m3", "solo"]);
  });

  it("unmounting releases everything the selection asked for", async () => {
    const { engine } = await engineWith();
    await mount(engine, "m3");
    await unmount();

    for (const id of ["m1", "m2", "m3"]) expect(engine.attachmentsOf(id).state).toBe("loading");
  });
});

/** A wider thread, for the bounds: ten members, one loner beside it. */
const WIDE = [
  ...Array.from({ length: 10 }, (_, i) =>
    seed(`w${i + 1}`, "tw", `2026-08-2${i < 5 ? 0 : 1}T0${i % 5}:00:00.000Z`)),
  seed("solo2", null, "2026-08-26T10:00:00.000Z"),
];

const flush = async (): Promise<void> => {
  // One settled microtask queue per round — a deferred resolve schedules continuations that
  // themselves schedule (the engine's write-back, then the seam's `.then`).
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};

describe("the review round's three lifecycle bounds", () => {
  it("a list that lands AFTER the selection left is re-released, never kept", async () => {
    // The engine does not cancel on release: the late outcome is written back to its held map
    // regardless, and before this guard the seam then treated it as current — state (and, for a
    // calendar part, fetched BYTES) retained forever, with the cleanup already spent. The guard
    // re-releases anything whose id the release set no longer wants. Mutation: drop the
    // `loaded.current.has(id)` check in `ask` — every assertion below reads "ready" and goes red.
    const rig = await engineWith(ROWS, { defer: true });
    await mount(rig.engine, "m3");
    expect(rig.asked.length).toBeGreaterThan(0);

    await unmount(); // releases all, clears the set — the three reads are still in the air
    rig.settleLists();
    await flush();

    for (const id of ["m1", "m2", "m3"]) {
      expect(rig.engine.attachmentsOf(id).state, `${id} kept a list its selection never saw`).toBe("loading");
    }
  });

  it("sibling list reads are a fixed crew, never one volley per thread member", async () => {
    // Ten members: the selected id's own ask plus a crew of SIBLING_LIST_CONCURRENCY may fly at
    // once — never all ten. Mutation: replace the worker crew with the plain loop this bounds —
    // maxInFlight reads 10 and the assertion goes red.
    const rig = await engineWith(WIDE, { defer: true });
    await mount(rig.engine, "w1");

    expect(rig.inFlight(), "the whole thread went out as one volley").toBeLessThanOrEqual(5);

    // Drain in rounds until every member has been asked — the crew keeps taking from the queue.
    for (let round = 0; round < 12 && new Set(rig.asked).size < 10; round++) {
      rig.settleLists();
      await flush();
    }
    expect(new Set(rig.asked).size, "the crew stopped before the queue drained").toBe(10);
    expect(rig.maxInFlight(), "concurrency exceeded the crew plus the selected ask").toBeLessThanOrEqual(5);
  });

  it("two panels' download-alls are tracked separately — starting B does not un-spin A", async () => {
    // The scalar this pins against held only the LAST press: `downloadingAll(A)` flipped false
    // the moment B started, offering A's button mid-flight — a second press, duplicate saves.
    // Mutation: restore the scalar — the joint assertion below goes red.
    (globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () =>
      `blob:test-${Math.random()}`;
    (globalThis.URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};

    const rig = await engineWith(ROWS, { defer: true });
    await mount(rig.engine, "m3");
    // The whole crew flies at once: both siblings' reads are in the air BEFORE anything
    // settles — this is also the pin on the under-spawn (a worker takes its first id
    // synchronously, so a crew sized off the live queue length spawned one worker for two
    // siblings; watched happen).
    expect(rig.inFlight(), "the crew under-spawned").toBe(3);
    rig.settleLists();
    await flush();
    expect(rig.engine.attachmentsOf("m1").state).toBe("ready");
    expect(rig.engine.attachmentsOf("m2").state).toBe("ready");

    await act(async () => {
      latestChrome!.downloadAll("m1");
      latestChrome!.downloadAll("m2");
    });
    await flush();
    expect(latestChrome!.downloadingAll("m1"), "A went idle the moment B started").toBe(true);
    expect(latestChrome!.downloadingAll("m2")).toBe(true);

    rig.settleBytes();
    await flush();
    rig.settleBytes(); // a second wave, in case the first save queued another fetch
    await flush();
    expect(latestChrome!.downloadingAll("m1")).toBe(false);
    expect(latestChrome!.downloadingAll("m2")).toBe(false);
  });
});

describe("the queue survives the thread growing mid-drain", () => {
  it("a sibling enqueued but not yet ASKED when a drain re-keys the sweep is re-queued, never stranded", async () => {
    // The replacement run's skip test is release-set membership — so an id that joined the set
    // at ENQUEUE and was then cancelled before its worker reached it looked already-owned for
    // ever: no worker left to take it, no run willing to re-queue it, its strip on the silent
    // loading default until the selection moved (review finding). Membership moves to DEQUEUE;
    // an unstarted id holds no engine state to release, so the set loses nothing by waiting.
    // Mutation: move `loaded.current.add(id)` back to the enqueue loop — the count below stops
    // short of 11 and this goes red.
    const rig = await engineWith(WIDE, { defer: true });
    await mount(rig.engine, "w1");
    // Selected ask plus the crew of four; five siblings enqueued, unasked.
    expect(rig.inFlight()).toBe(5);

    // A drain lands an ELEVENTH member on the open thread → conversationKey changes → the
    // sweep's cleanup cancels the old crew mid-queue and the replacement run rebuilds it.
    rig.enqueueSync(seed("w11", "tw", "2026-08-22T00:00:00.000Z"));
    await act(async () => { await rig.engine.syncOnce(); });
    await flush();

    // THE CAP HOLDS ACROSS THE RE-KEY. A crew spawned per effect generation kept its budget
    // only within its own run: the replacement crew joined the four workers still awaiting
    // their reads and nine lists flew at once — the exact burst the cap exists to prevent,
    // recreated by the requeue that fixed the stranding (review finding). The queue and the
    // crew are shared across generations now. Mutation: spawn a fresh crew per effect run —
    // this reads 9 and goes red.
    expect(rig.maxInFlight(), "the replacement crew stacked onto the standing one").toBeLessThanOrEqual(5);

    for (let round = 0; round < 16 && new Set(rig.asked).size < 11; round++) {
      rig.settleLists();
      await flush();
    }
    expect(new Set(rig.asked).size, "the cancelled tail was stranded as already-owned").toBe(11);
    expect(rig.maxInFlight()).toBeLessThanOrEqual(5);
  });
});

describe("the crew survives an ENGINE swap without serving the old world", () => {
  it("a worker that outlives the swap asks the NEW engine, and the old engine's late answers release", async () => {
    // The crew outlives effect generations by design — that is the concurrency bound — so it
    // also outlives the ENGINE its pump ran under (desktop mailbox switch, live→demo). A
    // worker holding the old `ask` closure dequeued the NEW queue's ids, marked them owned,
    // and sent them to the discarded engine: the new strips stranded loading forever, and on
    // live→demo that is a network request from inside the demo (review finding). Workers ask
    // through a ref now, and a completion whose engine is no longer the hook's answers with a
    // release against the engine that was asked. Mutation: have the worker `await ask(id)`
    // instead of `await askRef.current(id)` — the new engine's asks land on the old adapter
    // and every assertion below goes red.
    const a = await engineWith(WIDE, { defer: true });
    const b = await engineWith(ROWS, { defer: true });

    await mount(a.engine, "w1");
    expect(a.inFlight(), "the drain never started on the first engine").toBe(5);

    // Swap the engine mid-drain: the four crew workers are still awaiting A's reads.
    await mount(b.engine, "m3");
    // Release A's reads so its workers resume and take from the NEW queue.
    a.settleLists();
    await flush();
    b.settleLists();
    await flush();
    b.settleLists();
    await flush();

    // B's whole conversation is served, by B's own adapter.
    for (const id of ["m1", "m2", "m3"]) {
      expect(b.engine.attachmentsOf(id).state, `${id} stranded after the swap`).toBe("ready");
    }
    expect([...new Set(b.asked)].sort()).toEqual(["m1", "m2", "m3"]);
    // None of B's ids ever reached A — the old adapter saw only its own thread.
    expect(a.asked.some((id) => id.startsWith("m")), "the old engine served the new queue").toBe(false);
    // And A's late completions landed as releases on A, not as retained lists.
    for (const id of a.asked) {
      expect(a.engine.attachmentsOf(id).state, `${id} kept a list on the discarded engine`).toBe("loading");
    }
  });
});

describe("a late completion after an engine swap releases even when the IDS collide", () => {
  it("the same message id on both engines does not let the old engine keep its list", async () => {
    // The release-set check alone cannot see this case: the new selection legitimately wants
    // the id, so a late completion from the OLD engine looks current by membership — and the
    // old engine then retains its list (and would run its calendar pass) for a world nothing
    // renders any more. The completion's own engine must still be the hook's. Mutation: drop
    // `engineRef.current !== engine` from the guard in `ask` — the old engine's list below
    // reads "ready" and this goes red.
    const a = await engineWith(ROWS, { defer: true });
    const b = await engineWith(ROWS, { defer: true });

    await mount(a.engine, "m3");
    await mount(b.engine, "m3"); // same ids, different world — A's reads still in the air
    a.settleLists();
    b.settleLists();
    await flush();
    b.settleLists();
    await flush();

    expect(b.engine.attachmentsOf("m3").state).toBe("ready");
    expect(a.engine.attachmentsOf("m3").state, "the discarded engine kept a list because the id matched").toBe("loading");
  });
});
