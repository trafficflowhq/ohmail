import { performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import type { EngineMessage, MessageBodyWire, MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { BUILD_SLICE_MS, SearchIndex } from "../src/search.js";
import { OhmailEngine } from "../src/engine.js";
import { MemoryMirrorStore } from "../src/store.js";
import type { EngineAdapter } from "../src/adapters/adapter.js";
import type { SyncChange, SyncResponse } from "../src/types.js";

/**
 * THE INSTANT INDEX STOPPED FREEZING THE WINDOW.
 *
 * THE REPORT. A customer's desktop pegged its webview's CPU for minutes the moment
 * they searched. A five-second sample of every ohmail process on that machine put the Tauri host
 * and the engine's node near idle and the WINDOW flat out, with every hot frame in
 * JavaScriptCore: `LocalAllocator::allocateSlowCase`, `MarkedBlock::Handle::sweep`, `JSRopeString`
 * finishSweep, `operationRegExpMatchFastGlobalString`, `operationJSMapFindBucket` — a JavaScript
 * loop allocating rope strings out of global regex matches and filling Maps.
 *
 * THE MECHANISM, in two halves, and both are measured here:
 *
 *   1. THE INDEX READ EVERY HYDRATED BODY. `add` tokenized `${snippet} ${body}` — a rope string
 *      per message and a term set the size of the mail. Measured on a large mirror with
 *      most bodies hydrated (2026-09-13): many times the characters tokenized per build,
 *      against the bodies gone, and one build seconds of CPU against a fraction of one.
 *   2. THE WHOLE INDEX WAS REBUILT WHENEVER THE MIRROR'S VERSION MOVED — which is every drain
 *      and every body publish. So each keystroke after a bump paid a whole build: typing one
 *      seven-letter word with the mirror moving between keystrokes cost 26 767 ms of CPU on that
 *      corpus, against 570 ms after. That is the freeze, as a number.
 *
 * What this file pins is the three rules that replaced it: no body text enters the index, the
 * FIRST build past {@link SEARCH_INDEX_SYNC_MAX} is handed back to the event loop every
 * {@link BUILD_SLICE_MS}, and a version bump costs the messages that MOVED rather than the mirror.
 * The incremental half is in `search-index-incremental.test.ts` beside this one; what stays here
 * is the slicing and the freshness the two halves together deliver.
 */

const NOW = new Date("2026-09-13T12:00:00.000Z");

/** One slice is a frame; this is the bound a slice may not cross, read on the build's own clock ({@link workClock}). */
const FRAME_BUDGET_MS = 50;

/**
 * Past the engine's synchronous bound, and few enough that building two of these corpora (one of
 * them carrying a body per message) stays a suite test rather than a benchmark.
 */
const N = 5_000;

/**
 * THE SLICING CORPUS, and it is larger on purpose. The slice count is the assertion, so the walk
 * has to be several slices long on a FAST machine as well as a slow one: at its size it measured 36
 * ms and two slices here, which is one machine generation away from running inside a single slice
 * and passing the frame bound for the wrong reason.
 */
const N_SLICE = 20_000;

const BODY_BYTES = 2_000;

const TOPICS = [
  "Kiln schedule", "Invoice for July", "Shelf measurements", "Newsletter arrivals",
  "Order shipped", "Meeting moved", "Draft chapter", "Studio rent", "Workshop places", "Glaze evening",
];
const NAMES = ["Lena", "Jonas", "Mara", "Piet", "Nora", "Ivo", "Greta", "Samu"];
const WORDS = ["second", "third", "fourth", "glaze", "ladle", "pencil", "notebook", "broom", "lamp", "kettle"];

function msg(i: number): EngineMessage {
  return {
    id: `m-${i}`,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    // Varied per message so the term set is the shape a real mailbox has — a corpus of one
    // repeated subject mints its trigrams once and measures a build nobody ever pays for.
    subject: `${TOPICS[i % TOPICS.length]} ${i}`,
    from: { name: NAMES[i % NAMES.length]!, address: `${NAMES[i % NAMES.length]!.toLowerCase()}@atelier.example` },
    to: [],
    cc: [],
    date: new Date(NOW.getTime() - i * 60_000).toISOString(),
    folder: "ohmail/News",
    // "Tuesday" is in every snippet and nowhere else — the positive control's needle.
    snippet: `We looked at batch ${i} again on Tuesday and the ${WORDS[i % WORDS.length]} reads better.`,
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: {
      sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false,
    },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: NOW.toISOString(),
  } as EngineMessage;
}

/** A word that appears in no subject, no sender and no snippet — only in a body. */
const BODY_ONLY = "ZQXBRIM";

function bodyText(): string {
  let s = "";
  while (s.length < BODY_BYTES) s += "Thank you for your order and for your patience while we packed it. ";
  return `${s.slice(0, BODY_BYTES - BODY_ONLY.length - 1)} ${BODY_ONLY}`;
}

let seq = 0;

async function mirrorOf(n: number, withBodies: boolean): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  const rows: SyncChange[] = [];
  for (let i = 0; i < n; i++) {
    const m = msg(i);
    rows.push({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m });
  }
  await store.applyChanges(rows);
  if (withBodies) {
    const text = bodyText();
    for (let i = 0; i < n; i++) {
      await store.putLocal("message_body", `m-${i}`, { messageId: `m-${i}`, state: "ready", text });
    }
  }
  return store;
}

function adapterOf(): EngineAdapter {
  return {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "0", hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async (): Promise<MessageBodyWire | null> => null,
  };
}

/** The test thread's own processor time, in milliseconds: time the thread spends off the processor is not in it. */
function threadCpuMs(): number {
  const u = process.threadCpuUsage();
  return (u.user + u.system) / 1000;
}

/**
 * THE BUILD'S CLOCK, HANDED IN BY THE TEST: the test thread's own processor time
 * ({@link threadCpuMs}). A thread taken off the processor accrues none, so a loaded host cannot
 * lengthen a stretch the build never ran, while a stretch that did costly work reads its cost. A
 * wall clock counts both. The build slices by this clock and the test reads the same one, so a
 * stretch here is what the build measured between two yields. `reads` counts the build's reads;
 * `at` is the test's own reading and is not counted.
 */
function workClock(): { now: () => number; at: () => number; reads: () => number } {
  let reads = 0;
  return {
    now: () => {
      reads++;
      return threadCpuMs();
    },
    at: threadCpuMs,
    reads: () => reads,
  };
}

/**
 * A build driven through an instrumented yield, so every synchronous stretch is a number: on the
 * build's own clock when one is handed in, else on the wall clock. `wallLongest` is always the wall
 * clock's reading, kept so a run's numbers can be read beside the verdict.
 */
async function sliced(store: MemoryMirrorStore, sliceMs?: number, clock?: ReturnType<typeof workClock>): Promise<{
  index: SearchIndex | null;
  slices: number;
  longest: number;
  wallLongest: number;
  slowestStart: number;
  slowestEnd: number;
  total: number;
}> {
  const read = clock ? clock.at : () => performance.now();
  let slices = 0;
  let longest = 0;
  let wallLongest = 0;
  let last = read();
  let wallLast = performance.now();
  const t0 = wallLast;
  let slowestStart = t0;
  let slowestEnd = t0;
  const recordStretch = () => {
    const elapsed = read() - last;
    const wallEnd = performance.now();
    if (elapsed > longest) {
      longest = elapsed;
      slowestStart = wallLast;
      slowestEnd = wallEnd;
    }
    wallLongest = Math.max(wallLongest, wallEnd - wallLast);
  };
  const index = await SearchIndex.buildSliced(store, {
    ...(sliceMs !== undefined ? { sliceMs } : {}),
    ...(clock ? { now: clock.now } : {}),
    yieldTo: () =>
      new Promise<void>((r) => {
        slices++;
        recordStretch();
        setTimeout(() => {
          last = read();
          wallLast = performance.now();
          r();
        }, 0);
      }),
  });
  recordStretch();
  return { index, slices, longest, wallLongest, slowestStart, slowestEnd, total: performance.now() - t0 };
}

async function slicedWithGcTrace(store: MemoryMirrorStore, clock: ReturnType<typeof workClock>) {
  const entries: PerformanceEntry[] = [];
  const observer = new PerformanceObserver((list) => entries.push(...list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  try {
    const run = await sliced(store, undefined, clock);
    if (run.longest >= FRAME_BUDGET_MS) {
      // Let the observer deliver entries from the last stretch before reading the trace.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const overlapping = [...entries, ...observer.takeRecords()]
        .filter((entry) =>
          entry.startTime < run.slowestEnd && entry.startTime + entry.duration > run.slowestStart)
        .map((entry) => ({
          offsetMs: Number((entry.startTime - run.slowestStart).toFixed(2)),
          durationMs: Number(entry.duration.toFixed(2)),
        }));
      console.log(`  Garbage collection during the longest CPU stretch: ${JSON.stringify(overlapping)}`);
    }
    return run;
  } finally {
    observer.disconnect();
  }
}

describe("no body text enters the instant index", () => {
  it("a mirror whose every message has a READY body indexes none of it", async () => {
    const store = await mirrorOf(200, true);
    const idx = SearchIndex.build(store);

    // The word is on the device — the records are `ready` and hold it — and the index has it not.
    expect(store.get("message_body", "m-0")).toMatchObject({ state: "ready" });
    expect((store.get<{ text: string }>("message_body", "m-0"))!.text).toContain(BODY_ONLY);
    expect(idx.search(BODY_ONLY).items).toHaveLength(0);
    expect(idx.search(BODY_ONLY).similar).toHaveLength(0);
    expect(idx.coverage()).toEqual({ messages: 200, full: 0 });

    // THE POSITIVE CONTROL. Every assertion above is an absence and an index of nothing would
    // satisfy all of them, so the same corpus is asked a question it must answer. "Tuesday" is
    // in every snippet, so the whole corpus answers it.
    expect(idx.search("Tuesday", { limit: 500 }).items.length).toBe(200);
    expect(idx.search("kiln", { limit: 500 }).items.length).toBe(20);
  });

  it("the bodies cost the build nothing — the same walk with and without them", async () => {
    /*
     * THE HALF THE SAMPLE POINTED AT, as a ratio rather than an argument. The two corpora differ
     * in nothing but a long `message_body` per message; before this change
     * that was the dominant term of the whole build. Asserted as a RATIO with generous slack
     * (this is a millisecond on a shared machine) — what it catches is the body pass coming
     * back, which multiplies the walk, not a drift of a tenth. Each build is timed on the test
     * thread's own processor time, the smaller of three: a thread taken off the processor accrues
     * none, so a loaded host lengthens neither side of the ratio, and the work of the walk does.
     */
    const bare = await mirrorOf(N, false);
    const laden = await mirrorOf(N, true);

    let a: SearchIndex | undefined;
    let b: SearchIndex | undefined;
    let bareMs = Infinity;
    let ladenMs = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = threadCpuMs();
      a = SearchIndex.build(bare);
      bareMs = Math.min(bareMs, threadCpuMs() - t0);
      const t1 = threadCpuMs();
      b = SearchIndex.build(laden);
      ladenMs = Math.min(ladenMs, threadCpuMs() - t1);
    }

    expect(a!.coverage()).toEqual({ messages: N, full: 0 });
    expect(b!.coverage()).toEqual({ messages: N, full: 0 });
    expect(
      ladenMs / bareMs,
      `a mirror carrying ${N} ready bodies built in ${ladenMs.toFixed(0)} ms against ` +
        `${bareMs.toFixed(0)} ms without them — the body pass looks like it is back`,
    ).toBeLessThan(2);
  });
});

describe("the build is handed back to the event loop", () => {
  it(`yields repeatedly and no synchronous stretch crosses ${FRAME_BUDGET_MS} ms`, async () => {
    const store = await mirrorOf(N_SLICE, false);
    const clock = workClock();
    const run = await slicedWithGcTrace(store, clock);

    expect(run.index).not.toBeNull();
    expect(run.index!.coverage().messages).toBe(N_SLICE);
    // Reported so a run's numbers are readable, not only its verdict.
    console.log(
      `  sliced build at ${N_SLICE}: ${run.total.toFixed(0)} ms in ${run.slices} slices, ` +
        `longest synchronous stretch ${run.longest.toFixed(1)} ms on the build's clock ` +
        `(${run.wallLongest.toFixed(1)} ms on the wall clock, which also counts the host)`,
    );

    // THE CLOCK IS THE ONE THE BUILD SLICED BY. A build that kept a clock of its own would leave
    // this one unread, and every stretch below would measure nothing.
    expect(clock.reads(), "the build never read the clock it was handed").toBeGreaterThanOrEqual(N_SLICE);

    // IT ACTUALLY SLICED. A build that ran to completion in one go would pass the bound below
    // for the wrong reason on a fast machine, so the slice count is asserted first.
    expect(run.slices, "the build never yielded — it ran to completion inside one call").toBeGreaterThan(1);
    expect(
      run.longest,
      `one stretch of the build ran ${run.longest.toFixed(1)} ms without yielding`,
    ).toBeLessThan(FRAME_BUDGET_MS);
  });

  it("the slice length is the knob it claims to be — a shorter slice yields more often", async () => {
    // Anti-decoration for {@link BUILD_SLICE_MS}: a build that ignored the number would slice
    // the same way at both settings. Two settings an order of magnitude apart, one corpus.
    const store = await mirrorOf(N_SLICE, false);
    const coarse = await sliced(store, BUILD_SLICE_MS * 8);
    const fine = await sliced(store, 1);
    expect(fine.slices).toBeGreaterThan(coarse.slices);
  });

  it("a cancelled build returns null and installs nothing", async () => {
    const store = await mirrorOf(N, false);
    let seen = 0;
    const index = await SearchIndex.buildSliced(store, {
      sliceMs: 1,
      cancelled: () => ++seen > 2,
      yieldTo: () => new Promise<void>((r) => setTimeout(r, 0)),
    });
    expect(index).toBeNull();

    // The control: the same corpus and the same slicing, with nothing cancelling it.
    const whole = await SearchIndex.buildSliced(store, { sliceMs: 1, yieldTo: () => Promise.resolve() });
    expect(whole).not.toBeNull();
    expect(whole!.coverage().messages).toBe(N);
  });
});

describe("a version bump costs the messages that moved", () => {
  /** The engine, with a clock the test moves. */
  async function engineOn(store: MemoryMirrorStore): Promise<{ engine: OhmailEngine }> {
    const engine = new OhmailEngine({ adapter: adapterOf(), store, now: () => NOW });
    return { engine };
  }

  async function addOne(store: MemoryMirrorStore, id: string, subject: string): Promise<void> {
    const m = { ...msg(999_999), id, subject };
    await store.applyChanges([
      { type: "message", op: "create", id, seq: ++seq, updatedAt: m.updatedAt, entity: m },
    ]);
  }

  it("a LARGE mirror answers `indexing` until the sliced build settles, then answers", async () => {
    const store = await mirrorOf(N, false);
    const { engine } = await engineOn(store);

    // The first search has nothing to answer from and SAYS so — an empty list with no sentence
    // would read as an empty mailbox, which is the false state this whole change is about.
    const first = engine.search("kiln");
    expect(first.items).toHaveLength(0);
    expect(first.indexing).toBe(true);
    expect(first.coverage).toEqual({ messages: 0, full: 0 });

    await engine.warmSearchIndex();

    const after = engine.search("kiln");
    expect(after.indexing).toBe(false);
    expect(after.coverage.messages).toBe(N);
    expect(after.items.length).toBeGreaterThan(0);
    expect(after.items[0]!.message.subject).toContain("Kiln");
  });

  it("mail that arrives after the build is in the VERY NEXT answer, on a large mirror", async () => {
    /*
     * THE STALENESS THE MITIGATION TRADED FOR, BOUGHT BACK. The first half of that change rebuilt at
     * most once every thirty seconds, so mail arriving inside that floor was not in the instant
     * answer until it passed. The index is incremental now, so a message costs its own indexing
     * and nothing else: no clock is moved here, nothing is awaited, and the same synchronous call
     * a keystroke makes carries the new mail.
     */
    const store = await mirrorOf(N, false);
    const { engine } = await engineOn(store);
    await engine.warmSearchIndex();
    expect(engine.search("kiln").items.length).toBeGreaterThan(0);

    await addOne(store, "fresh", "Kingfisher arrives");
    expect(engine.search("kingfisher").items.map((h) => h.message.id)).toEqual(["fresh"]);
    expect(engine.search("kingfisher").indexing).toBe(false);
  });

  it("a SMALL mirror is never made stale — it is rebuilt on every move, as it always was", async () => {
    // The floor is a trade against cost, and under the synchronous bound there is none. This is
    // the arm that keeps the demo, every fixture mount and a young mailbox answering the first
    // keystroke with mail the reader has just sent.
    const store = await mirrorOf(20, false);
    const { engine } = await engineOn(store);
    expect(engine.search("kiln").indexing).toBe(false);
    expect(engine.search("Tuesday", { limit: 100 }).items.length).toBe(20);

    await addOne(store, "fresh", "Kingfisher arrives");
    // No clock movement, no warm-up, no await: the same call that used to answer, answering.
    expect(engine.search("kingfisher").items.map((h) => h.message.id)).toEqual(["fresh"]);
  });
});
