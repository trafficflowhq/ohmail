/** @vitest-environment jsdom */
/**
 * ═══ A SCHEDULED ENGINE IS NOT A MERGING ENGINE ═══════════════════════════════════════════
 *
 * `SyncResponse` carries no account identity: the route returns the service's result bare, the
 * adapter reads only the body, and the engine writes it straight into IndexedDB
 * `ohmail-mirror:<owner>`. So whatever session the cookie jar holds decides what lands in the
 * mirror NAMED for the remembered account, and the only continuation predicate the loop had
 * knew about teardown and terminal refusals — nothing about identity.
 *
 * The confirm's own comparison covers one moment: the `owner` arm of the session check. It is
 * bounded to the retry ladder while `checking`, unbounded at `unconfirmed`, and never re-run at
 * `ready` — so a tab confirmed for A whose browser later signs into B on another tab merges B's
 * log into A's mirror for as long as it lives, and the rows persist (the mirror finds its own
 * stamp on the next open and keeps them).
 *
 * These drive the real `OhmailEngine` and the real scheduler and count what reached the
 * adapter. `createSyncGate` takes the mirror's name with NO DEFAULT, so a caller that forgets
 * to say syncs nothing rather than everything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  type EngineAdapter,
  type MutationOutcome,
  type SyncParams,
  type SyncResponse,
} from "@ohmail/client-engine";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as scan from "../../../scripts/lib/source-scan.mjs";
import {
  ForeignSessionError,
  BACKOFF_CAP_MS,
  PRESS_CONFIRM_WAIT_MS,
  POLL_MS,
  REFUSAL_SUSTAIN_MS,
  WAKE_SAFETY_POLL_MS,
  WAKE_STREAM_CLOSED,
  createSyncGate,
  registerSyncGate,
  startSyncScheduler,
  syncIdentityOf,
  type SyncStatus,
  type WakeStreamLike,
} from "../app/shell/sync-scheduler.js";

const ISO = "2026-09-05T10:00:00.000Z";
const A = "acct_A";
const B = "acct_B";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const source = (p: string): string => scan.withoutComments(readFileSync(join(ROOT, p), "utf8"));

/**
 * EVERY CAPABILITY THE ADAPTER DECLARES, READ OFF THE DECLARATION — not a list kept here.
 *
 * The hand-written list below this one was the second half of the defect it was written to catch:
 * `heldReleases`, `releaseHeld` and `fetchDraftBody` were absent from the guard AND absent from the
 * census, and a census that does not name a capability cannot report it unforwarded. Both sources
 * are parsed at their own declaration, so a capability added in either place arrives here by
 * itself and a rename fails loudly rather than shrinking the set silently.
 */
const membersOf = (src: string, decl: string): string[] => {
  const at = src.indexOf(decl);
  if (at < 0) throw new Error(`${decl} not found — this census parses nothing`);
  const brace = src.indexOf("{", at);
  const { start, end, closed } = scan.bracketSpan(src, brace, "{", "}");
  if (!closed) throw new Error(`${decl} does not close`);
  const body = src.slice(start, end);
  const names: string[] = [];
  let depth = 0;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (depth === 0) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\??\s*[(:<]/.exec(line);
      if (m) names.push(m[1]!);
    }
    depth += (raw.match(/[{([]/g) ?? []).length - (raw.match(/[})\]]/g) ?? []).length;
  }
  return [...new Set(names)];
};

/** The engine's own protocol, plus the four `GatedAdapter` names the wrapper adds to it. */
const DECLARED: readonly string[] = [
  ...membersOf(source("packages/client-engine/src/adapters/adapter.ts"), "export interface EngineAdapter"),
  ...membersOf(source("apps/webapp/app/shell/sync-scheduler.ts"), "type GatedAdapter = EngineAdapter &"),
];

/**
 * The capabilities that do NOT refuse in {@link ForeignSessionError}'s shape as a READ does, named with
 * their own reason and each asserted by name elsewhere in this file: `sync` and `snapshot` write
 * the log to disk and throw `SyncAbortedError`; `mutate` is queued under its idempotency key and
 * rejects retryably; `releaseHeld` and `dismissHeldRelease` are presses that require `holds`, so
 * they refuse in the warm open where a read does not. Everything else is a read, and the list of
 * reads is what is left.
 */
const NOT_A_READ: readonly string[] = [
  "sync", "snapshot", "mutate", "releaseHeld", "dismissHeldRelease",
  // the press, on the same rule as the two beside it: it moves the caller's own mail, so the
  // warm open that makes an unconfirmed READ correct would make this somebody else's mail moving.
  "screenUnscreened",
  // A Cancel's question decides a send key on whichever account the session holds: `mutate`'s
  // rule, and refused it ANSWERS `unreachable` (the Cancel stays owed) rather than throwing.
  "withdrawSend",
];

const emptyPage = (): SyncResponse => ({
  changes: { creates: [], updates: [], moves: [], deletes: [] },
  cursor: "c1", hasMore: false, serverTime: ISO,
});

const MSG = "m_seed";

/** One real message in the mirror — a mutation needs a target or the engine refuses it first. */
const seededPage = (): SyncResponse => ({
  changes: {
    creates: [{
      type: "message", op: "create", id: MSG, seq: 1, updatedAt: ISO,
      entity: {
        id: MSG, accountId: A, mailboxId: "mb_1", threadId: null, messageIdHeader: null,
        subject: "seed", from: { name: "Seed", address: "seed@example.invalid" },
        to: [], cc: [], date: ISO, folder: "INBOX", snippet: "seed", unread: true,
        hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null,
        labels: [], remoteContent: "none", updatedAt: ISO,
      },
    }],
    updates: [], moves: [], deletes: [],
  },
  cursor: "c0", hasMore: false, serverTime: ISO,
} as unknown as SyncResponse);

function setOwnerCookie(id: string | null): void {
  document.cookie = id === null
    ? "tf_owner=; Path=/; Max-Age=0"
    : `tf_owner=${id}; Path=/`;
}

/** A `document` whose visibility the test owns, so the loop is not at jsdom's mercy. */
function visibleDoc() {
  const listeners = new Set<() => void>();
  return {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (_t: "visibilitychange", l: () => void) => { listeners.add(l); },
    removeEventListener: (_t: "visibilitychange", l: () => void) => { listeners.delete(l); },
    fire: () => { for (const l of listeners) l(); },
  };
}

/** The live wiring: a gate for a NAMED mirror, the adapter it guards, the engine around them. */
function gated(owner: string | null, adapter: EngineAdapter, store?: MemoryMirrorStore) {
  const gate = createSyncGate(owner);
  const engine = new OhmailEngine({
    adapter: gate.guard(adapter) as EngineAdapter,
    store: store ?? new MemoryMirrorStore(),
  });
  return { engine, gate };
}

let syncCalls = 0;
let applied = 0;

function countingAdapter(pages: SyncResponse[] = []): EngineAdapter {
  return {
    sync: async (_p: SyncParams): Promise<SyncResponse> => {
      syncCalls += 1;
      applied += 1;
      return pages[Math.min(syncCalls, pages.length) - 1] ?? emptyPage();
    },
    mutate: async (): Promise<MutationOutcome> => ({ status: "applied", entities: [] } as unknown as MutationOutcome),
    fetchBody: async () => null,
  } as unknown as EngineAdapter;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(ISO));
  syncCalls = 0;
  applied = 0;
  setOwnerCookie(null);
});
afterEach(() => {
  setOwnerCookie(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

describe("the gate is built CLOSED for a named mirror", () => {
  /** 1 — unconfirmed issues nothing, and confirming opens it without a second scheduler. */
  it("issues no /sync until the storage owner is confirmed, then drains on the same loop", async () => {
    setOwnerCookie(A);
    const { engine, gate } = gated(A, countingAdapter());
    const published: SyncStatus[] = [];
    const stop = startSyncScheduler(engine, {
      gate, visibility: visibleDoc(), onStatus: (s) => published.push(s),
    });
    await settle(50);

    expect(syncCalls, "a mirror nobody has claimed merged a page").toBe(0);
    // Quiet, not alarmed: nothing is wrong, and the strip may not say a drain is running.
    expect(published.at(-1)?.bootstrapping, "the strip claimed a bootstrap that is not happening")
      .toBe(false);
    expect(published.at(-1)?.terminal, "an unconfirmed gate was reported as a stopped loop")
      .toBe(false);

    gate.confirm(A);
    await settle(50);
    expect(syncCalls, "confirming did not wake the loop that was already running").toBe(1);
    stop();
  });

  /** 2 — a confirmation naming SOMEBODY ELSE opens nothing, for a full poll cycle and more. */
  it("a confirmation for another account never opens it", async () => {
    setOwnerCookie(A);
    const { engine, gate } = gated(A, countingAdapter());
    const stop = startSyncScheduler(engine, { gate, visibility: visibleDoc() });
    gate.confirm(B);
    await settle(60_000);
    expect(syncCalls, "a mirror opened for an account it does not belong to").toBe(0);
    stop();
  });

  /** 3 — the jar naming someone else latches terminal, and its return heals. */
  it("a cookie naming another account stops the loop, and restoring it resumes", async () => {
    setOwnerCookie(A);
    const { engine, gate } = gated(A, countingAdapter());
    const published: SyncStatus[] = [];
    const doc = visibleDoc();
    const stop = startSyncScheduler(engine, {
      gate, visibility: doc, onStatus: (s) => published.push(s), report: () => {},
    });
    gate.confirm(A);
    await settle(50);
    const before = syncCalls;
    expect(before, "the control never drained, so the stop below proves nothing")
      .toBeGreaterThanOrEqual(1);

    setOwnerCookie(B);
    await settle(POLL_MS * 3);
    expect(syncCalls, "a drain ran under another account's session").toBe(before);
    expect(published.at(-1)?.terminal, "the loop kept going with the jar naming somebody else")
      .toBe(true);

    /*
     * ── AND THE MARKER COMING BACK IS NOT A CONFIRMATION ──────────────────────────────────
     *
     * This case used to end "restoring it resumes": the jar names A again, a wake fires, the
     * drain runs. Review named that expectation as the unsafe premise it is. A→B→A leaves the
     * marker reading exactly what it read before, so a comparison against the mirror's name
     * sees nothing at all — and that is precisely the window in which a response issued under B
     * lands in A's tab. What the server confirmed was "this browser is A's, NOW"; the round trip
     * ended that, and only the server can say it again.
     *
     * So the terminal latch clears (the contradiction is genuinely gone and the strip may not go
     * on saying the mailbox has stopped) and the gate sits `revoked`: quiet, hydrating, merging
     * nothing. The confirm is what reopens it.
     */
    setOwnerCookie(A);
    doc.fire();
    await settle(POLL_MS * 2);
    expect(gate.identity(), "an A-to-B-to-A round trip left the old confirmation standing")
      .toBe("revoked");
    expect(syncCalls, "a drain ran on a confirmation the jar had already outlived").toBe(before);
    expect(published.at(-1)?.terminal, "the terminal latch outlived its cause").toBe(false);

    /* The server says it again — and in the product that ask is no longer hand-written: a revoked
       gate whose marker names this mirror fires `onNeedsConfirm`, which the shell turns back into
       the confirm ladder. See the case above; this line stands in for the shell. */
    gate.confirm(A);
    await settle(POLL_MS * 2);
    expect(syncCalls, "a fresh confirmation did not reopen the gate").toBeGreaterThan(before);
    stop();
  });

  /**
   * ═══ THE WAKE STREAM IS SESSION-AUTHENTICATED TOO ════════════════════════════════════════
   *
   * `/events` is not a request and so nothing in this loop was asking the identity question for
   * it. The server emits the ANSWERING account's sequence on it, so a stale shell for A held a
   * live subscription to B's activity — content-free as mail goes, and still that account's
   * metadata arriving in a window that is not theirs, over a connection nobody in it opened.
   */
  it("does not hold a wake stream while identity does not hold", async () => {
    setOwnerCookie(A);
    let opened = 0;
    let closed = 0;
    /* `readyState` matters: the loop reads it to tell a live stream from a dead one, and a stub
       that never leaves CONNECTING is treated as one that never landed. `sync-wake.test.ts`'s
       `FakeWakeStream` is the fuller version of this. */
    const makeStream = (): WakeStreamLike => {
      opened += 1;
      const listeners = new Map<string, Set<() => void>>();
      return {
        readyState: 1,
        addEventListener: (type: string, l: () => void) => {
          const set = listeners.get(type) ?? new Set<() => void>();
          set.add(l);
          listeners.set(type, set);
          if (type === "open") queueMicrotask(() => { for (const cb of set) cb(); });
        },
        close: () => { closed += 1; },
      } as unknown as WakeStreamLike;
    };

    const { engine, gate } = gated(A, countingAdapter());
    /* CONFIRMED FIRST. The stream is refused while identity does not hold, and an unconfirmed
       gate does not hold — so opening the scheduler before the confirm would measure the
       unconfirmed refusal and call it the contradiction's. */
    gate.confirm(A);
    const stop = startSyncScheduler(engine, {
      gate, visibility: visibleDoc(), wake: makeStream, report: () => {},
    });
    await settle(POLL_MS);
    expect(opened, "the control never opened a stream, so the refusal proves nothing")
      .toBeGreaterThanOrEqual(1);

    /* The browser becomes somebody else. Advanced past the SAFETY poll, not the ordinary one: a
       tab holding a live stream relaxes its cadence to that, so `POLL_MS` here would simply mean
       no tick had happened yet and the case would read the fix as missing. */
    setOwnerCookie(B);
    await settle(WAKE_SAFETY_POLL_MS + POLL_MS);
    expect(closed, "a stale shell kept listening to another account's activity")
      .toBeGreaterThanOrEqual(1);

    const openedByNow = opened;
    await settle(WAKE_SAFETY_POLL_MS * 2);
    expect(opened, "it reconnected while the browser belonged to somebody else").toBe(openedByNow);
    stop();

    /* AND THE REFUSAL TO OPEN AT ALL, on its own. The close above is what the contradiction arm
       does; this is `connectStream`'s own check, and it needs isolating because after that close
       the loop is terminal and would not have tried to reconnect regardless — a guard that is
       only ever reached when something else has already stopped the work is a guard nobody can
       watch fail. Here the scheduler starts with the browser ALREADY belonging to somebody else. */
    opened = 0;
    setOwnerCookie(B);
    const { engine: e2, gate: g2 } = gated(A, countingAdapter());
    g2.confirm(A);
    const stop2 = startSyncScheduler(e2, {
      gate: g2, visibility: visibleDoc(), wake: makeStream, report: () => {},
    });
    await settle(WAKE_SAFETY_POLL_MS);
    expect(opened, "it opened a session-authenticated stream for an account this browser is not")
      .toBe(0);
    stop2();
  });

  /**
   * ═══ AND THE OPEN THIS WINDOW NEVER ASKED FOR ════════════════════════════════════════════
   *
   * Round eight's MEDIUM. The case above measures the SAFETY POLL closing a contradicted stream,
   * and the refusal to open one at all. Between those two sits the thing `EventSource` does by
   * itself: after a transient failure it re-dials, with whatever cookies the jar holds AT THAT
   * MOMENT rather than the ones it was opened with. The server binds the new connection to that
   * account and starts emitting its sequence.
   *
   * The safety poll does close it — eventually. A tab holding a live stream relaxes to that
   * cadence precisely because the stream is supposed to be doing the waking, so the reconnect
   * lands long before the tick. The window is the whole finding, and this case lives inside it:
   * nothing here advances a timer far enough for a tick to be the cause.
   *
   * The stub is a native `EventSource`'s behaviour and not a stand-in for it: `error` while
   * CONNECTING leaves the object alive, and the browser — not this module — fires the next
   * `open`. That is why the fix cannot be "reconnect only if identity holds": nothing in this
   * process performs the reconnect.
   */
  it("does not honour a reconnect the browser made after the jar changed hands", async () => {
    setOwnerCookie(A);
    let opened = 0;
    let closed = 0;
    let fireOpen = (): void => {};
    let fireError = (): void => {};
    const state = { readyState: 1 };

    const makeStream = (): WakeStreamLike => {
      opened += 1;
      const listeners = new Map<string, Set<() => void>>();
      const on = (type: string): Set<() => void> => listeners.get(type) ?? new Set<() => void>();
      fireOpen = () => { for (const cb of on("open")) cb(); };
      fireError = () => { for (const cb of on("error")) cb(); };
      return {
        get readyState() { return state.readyState; },
        addEventListener: (type: string, l: () => void) => {
          const set = on(type);
          set.add(l);
          listeners.set(type, set);
          if (type === "open") queueMicrotask(() => { for (const cb of set) cb(); });
        },
        close: () => { closed += 1; },
      } as unknown as WakeStreamLike;
    };

    const { engine, gate } = gated(A, countingAdapter());
    gate.confirm(A);
    const stop = startSyncScheduler(engine, {
      gate, visibility: visibleDoc(), wake: makeStream, report: () => {},
    });
    await settle(POLL_MS);
    expect(opened, "the control never opened a stream, so nothing below proves anything")
      .toBeGreaterThanOrEqual(1);
    expect(closed, "the stream was already closed before the sequence began").toBe(0);

    /* Another tab signs in. Then the connection blips — CONNECTING, not CLOSED, which is the
       state in which a real `EventSource` keeps the object and re-dials on its own. */
    setOwnerCookie(B);
    state.readyState = 0;
    const closedBefore = closed;
    fireError();
    await settle(0);
    expect(closed, "a stream that is about to re-dial under another account's cookies was left open")
      .toBeGreaterThan(closedBefore);

    /* …and the belt: had it been left open, this is the callback the browser would have fired.
       It must wake nothing, whatever else is true. */
    const drainsBefore = syncCalls;
    state.readyState = 1;
    fireOpen();
    await settle(0);
    expect(syncCalls, "a reconnect under somebody else's session drove a drain")
      .toBe(drainsBefore);
    stop();
  });

  /**
   * ═══ THE OPEN ARM, ISOLATED — BECAUSE THE ERROR ARM COVERS FOR IT ════════════════════════
   *
   * The case above cannot see the check on `open`: the error arm closes the stream first, so the
   * open handler's own `stream !== s` line returns before the identity question is reached.
   * Deleting the open check leaves that case green, which measures the PAIR and not the part —
   * and a guard whose only evidence is a test that passes without it is not evidence.
   *
   * So this drives the sequence the error arm is not in: the stream stays healthy, the jar
   * changes hands, and the next `open` arrives on its own. A server that cycles long-lived
   * streams before its platform ceiling produces exactly that shape, and whether an `error`
   * surfaces to us first is the browser's business rather than a thing this module may assume.
   */
  it("closes on an open that arrives after the jar changed hands, with no error before it", async () => {
    setOwnerCookie(A);
    let closed = 0;
    let fireOpen = (): void => {};
    const makeStream = (): WakeStreamLike => {
      const listeners = new Map<string, Set<() => void>>();
      const on = (type: string): Set<() => void> => listeners.get(type) ?? new Set<() => void>();
      fireOpen = () => { for (const cb of on("open")) cb(); };
      return {
        readyState: 1,
        addEventListener: (type: string, l: () => void) => {
          const set = on(type);
          set.add(l);
          listeners.set(type, set);
          if (type === "open") queueMicrotask(() => { for (const cb of set) cb(); });
        },
        close: () => { closed += 1; },
      } as unknown as WakeStreamLike;
    };

    /* A DRAIN THAT HAS NOT ANSWERED — and this is what makes the case measure the open arm and
       nothing else. An `open` ordinarily drives `wake()`, `wake()` drives a tick, and the tick's
       own contradiction arm closes the stream; so with a quiet loop the check under test is
       covered by the tick and deleting it changes nothing observable. While a drain is IN
       FLIGHT, `wake()` records `pendingWake` and returns without ticking — so nothing else in
       this module is in a position to close the stream, and the reconnect stands. */
    let releaseDrain = (): void => {};
    const hangingAdapter = {
      sync: async () => {
        syncCalls += 1;
        await new Promise<void>((r) => { releaseDrain = r; });
        return emptyPage();
      },
      mutate: async () => ({ status: "applied", entities: [] }),
      fetchBody: async () => null,
    } as unknown as EngineAdapter;

    const { engine, gate } = gated(A, hangingAdapter);
    gate.confirm(A);
    const stop = startSyncScheduler(engine, {
      gate, visibility: visibleDoc(), wake: makeStream, report: () => {},
    });
    await settle(POLL_MS);
    expect(syncCalls, "no drain is in flight, so the tick — not the open arm — would do the closing")
      .toBeGreaterThan(0);
    expect(closed, "the stream was closed before the sequence began — this proves nothing").toBe(0);

    setOwnerCookie(B);
    fireOpen();
    await settle(0);
    expect(closed, "a re-opened stream was honoured for an account this browser is no longer")
      .toBeGreaterThan(0);
    releaseDrain();
    await settle(0);
    stop();
  });

  /**
   * ═══ AND A FRAME ON A CONNECTION NOBODY RE-OPENED ════════════════════════════════════════
   *
   * The third of the stream's callbacks, isolated for the reason the second one had to be: with
   * a quiet loop the tick closes the stream and the check under test changes nothing. Same
   * device — a drain in flight, so `wake()` records `pendingWake` and returns.
   *
   * No reconnect happens here at all. The connection is the one opened under A and still open;
   * what changed is the jar. Closing is still the answer: identity is the question, not who
   * dialled.
   */
  it("closes on a frame that lands after the jar changed hands", async () => {
    setOwnerCookie(A);
    let closed = 0;
    let fireSync = (): void => {};
    const makeStream = (): WakeStreamLike => {
      const listeners = new Map<string, Set<() => void>>();
      const on = (type: string): Set<() => void> => listeners.get(type) ?? new Set<() => void>();
      fireSync = () => { for (const cb of on("sync")) cb(); };
      return {
        readyState: 1,
        addEventListener: (type: string, l: () => void) => {
          const set = on(type);
          set.add(l);
          listeners.set(type, set);
          if (type === "open") queueMicrotask(() => { for (const cb of set) cb(); });
        },
        close: () => { closed += 1; },
      } as unknown as WakeStreamLike;
    };

    let releaseDrain = (): void => {};
    const hangingAdapter = {
      sync: async () => {
        syncCalls += 1;
        await new Promise<void>((r) => { releaseDrain = r; });
        return emptyPage();
      },
      mutate: async () => ({ status: "applied", entities: [] }),
      fetchBody: async () => null,
    } as unknown as EngineAdapter;

    const { engine, gate } = gated(A, hangingAdapter);
    gate.confirm(A);
    const stop = startSyncScheduler(engine, {
      gate, visibility: visibleDoc(), wake: makeStream, report: () => {},
    });
    await settle(POLL_MS);
    expect(syncCalls, "no drain is in flight, so the tick would do the closing").toBeGreaterThan(0);
    expect(closed, "the stream was closed before the sequence began").toBe(0);

    setOwnerCookie(B);
    fireSync();
    await settle(0);
    expect(closed, "a frame was honoured on a stream this window may no longer hold")
      .toBeGreaterThan(0);
    releaseDrain();
    await settle(0);
    stop();
  });

  /**
   * ═══ A REVOKED MIRROR ASKS TO BE CONFIRMED AGAIN ══════════════════════════════════════════
   *
   * Revocation is monotonic and must be, so `confirm` is the only way out — and on a `ready`
   * binding nothing ever calls it: the confirm effect finished long ago and `ready` carries no
   * owner to re-compare. A tab whose marker went to B and came back to A therefore cleared its
   * terminal strip (the contradiction really was gone) and then sat there with reads, sync,
   * mutations and the stream all disabled and nothing on screen saying so. It looked well.
   *
   * The earlier version of this file HID that: it called `gate.confirm(A)` by hand at the end of
   * the round-trip case, which no live `ready` code does.
   */
  it("asks to be confirmed again when the marker returns, once", async () => {
    setOwnerCookie(A);
    const gate = createSyncGate(A);
    let asked = 0;
    gate.onNeedsConfirm(() => { asked += 1; });
    gate.confirm(A);
    expect(gate.identity()).toBe("holds");

    setOwnerCookie(B);
    expect(gate.identity()).toBe("contradicted");
    expect(asked, "it asked while the jar still named somebody else").toBe(0);

    setOwnerCookie(A);
    expect(gate.identity(), "the round trip did not revoke").toBe("revoked");
    expect(asked, "a revoked mirror never asked to be confirmed again — it is a dead end").toBe(1);

    // ONCE PER REVOCATION. The predicate is read on every tick and at every page boundary, so a
    // signal per read would be a confirm ladder per tick.
    gate.identity(); gate.identity(); gate.identity();
    expect(asked, "every read asked again — that is a ladder per tick").toBe(1);

    // And the answer is what actually reopens it; asking is not reopening.
    expect(gate.identity()).toBe("revoked");
    gate.confirm(A);
    expect(gate.identity(), "a fresh confirmation did not reopen the gate").toBe("holds");
  });

  /**
   * ═══ TWO CAUSES FOR ONE LATCH, AND NEITHER ERASES THE OTHER ══════════════════════════════
   *
   * `terminal` has two unrelated causes: the SERVER refused this session, and the jar names
   * somebody else. A single flag naming "the current cause" could not compose — a contradiction
   * observed after a server refusal overwrote it, and clearing the contradiction then took the
   * server's verdict with it. Nothing leaks either way; what disappears is a true sentence the
   * person needs in order to act.
   *
   * ── THIS TEST EXISTS BECAUSE I CLAIMED IT COULD NOT ───────────────────────────────────────
   *
   * Round six shipped the two-bit split as structure with NO test, on a recorded argument that
   * no sequence could distinguish it: a terminal loop holds no timer, so its only driver is
   * `wake()`'s probe, and that probe is floored at `BACKOFF_CAP_MS`. The argument was wrong and
   * review supplied the counterexample. The flaw was in my attempt, not in the reasoning about
   * the floor: I advanced past the cap before the SECOND wake but not before the FIRST, so the
   * probe that was supposed to OBSERVE the contradiction was itself throttled and the gate never
   * saw B at all. Both wakes need the cap.
   *
   * A guard nobody has watched fail is not evidence — and neither is an argument that it cannot.
   */
  it("a contradiction that comes and goes does not erase the server's own refusal", async () => {
    setOwnerCookie(A);
    let refuse = false;
    const adapter = {
      sync: async (): Promise<SyncResponse> => {
        syncCalls += 1;
        if (refuse) {
          throw new MutationRejectedError("this session can no longer sync", {
            retryable: false, status: 401, code: "unauthorized",
          });
        }
        return emptyPage();
      },
      mutate: async (): Promise<MutationOutcome> => ({ status: "applied", entities: [] } as unknown as MutationOutcome),
      fetchBody: async () => null,
    } as unknown as EngineAdapter;

    const { engine, gate } = gated(A, adapter);
    const published: SyncStatus[] = [];
    const doc = visibleDoc();
    const stop = startSyncScheduler(engine, {
      gate, visibility: doc, onStatus: (x) => published.push(x), report: () => {},
    });
    gate.confirm(A);
    await settle(50);
    expect(syncCalls, "the control never drained").toBeGreaterThanOrEqual(1);

    // 1-2. The SERVER refuses, sustained, until the loop latches terminal on its own account.
    refuse = true;
    await settle(POLL_MS * 2 + REFUSAL_SUSTAIN_MS + 60_000);
    expect(published.at(-1)?.terminal, "the server's refusal never latched — nothing to erase")
      .toBe(true);

    // 3. B signs in elsewhere, and the probe must be ALLOWED to run: past the floor, then wake.
    setOwnerCookie(B);
    await settle(BACKOFF_CAP_MS + 1_000);
    doc.fire();
    await settle(POLL_MS);

    // 4-5. A comes back, and again the probe needs the floor before it may look.
    setOwnerCookie(A);
    await settle(BACKOFF_CAP_MS + 1_000);
    doc.fire();
    await settle(POLL_MS);

    /* The identity cause is gone and the SERVER's is not. Under one flag the release took both,
       and the strip fell silent about a session the server had refused. */
    expect(published.at(-1)?.terminal,
      "a contradiction coming and going erased the server's own terminal verdict").toBe(true);
    stop();
  });

  /** 4 — a flip DURING a multi-page drain refuses the next page. */
  it("a cookie flip between pages aborts the drain", async () => {
    setOwnerCookie(A);
    const pages: SyncResponse[] = [
      { ...emptyPage(), hasMore: true, cursor: "p1" },
      { ...emptyPage(), hasMore: false, cursor: "p2" },
    ];
    const adapter: EngineAdapter = {
      sync: async (): Promise<SyncResponse> => {
        syncCalls += 1;
        if (syncCalls === 1) setOwnerCookie(B); // the flip lands between page 1 and page 2
        return pages[Math.min(syncCalls, pages.length) - 1]!;
      },
      mutate: async (): Promise<MutationOutcome> => ({ status: "applied", entities: [] } as unknown as MutationOutcome),
      fetchBody: async () => null,
    } as unknown as EngineAdapter;

    const { engine, gate } = gated(A, adapter);
    const stop = startSyncScheduler(engine, { gate, visibility: visibleDoc(), report: () => {} });
    gate.confirm(A);
    await settle(200);
    expect(syncCalls, "page 2 was fetched under the other account's session").toBe(1);
    stop();
  });

  /**
   * 5 — a mutation is refused RETRYABLY, so the verb survives to be flushed later.
   *
   * ── THIS TEST USED TO PROVE NOTHING IT CLAIMED, AND THAT IS WHY IT LOOKS LIKE THIS ────────
   *
   * It called `guarded.mutate` DIRECTLY, saw a `MutationRejectedError` with `retryable: true`,
   * confirmed the gate, and made a second direct call. `OhmailEngine` was never involved — so
   * "and is not lost" was never measured: the queue, the durable outbox and the idempotency key
   * are all the engine's, and a regression that dropped retryable entries from
   * `pendingMutations()` or minted a fresh key on the retry left every assertion green.
   *
   * The whole point of refusing RETRYABLY rather than with a plain `Error` is what the engine
   * does next (a plain one is read as non-retryable, the overlay rolls back and the click is
   * silently discarded), so the engine has to be in the test. It drives the real one over a
   * seeded mirror: the verb is queued rather than rolled back, it is still in
   * `pendingMutations()` under its key, and after the confirm it reaches the wire ONCE, under
   * THAT key.
   */
  it("a mutation while unconfirmed is queued by the engine, then flushed once under the same key", async () => {
    setOwnerCookie(A);
    const seen: Array<{ kind: string; key: string | undefined }> = [];
    const adapter = {
      sync: async (): Promise<SyncResponse> => emptyPage(),
      mutate: async (m: { kind: string }, opts?: { idempotencyKey?: string }): Promise<MutationOutcome> => {
        seen.push({ kind: m.kind, key: opts?.idempotencyKey });
        return { seq: 2, changes: [] } as unknown as MutationOutcome;
      },
      fetchBody: async () => null,
    } as unknown as EngineAdapter;

    // A mirror with one message in it, so the verb below has a real target and real effects —
    // `OhmailEngine.mutate` rejects a verb whose effects are empty before it ever reaches the
    // gate, which would make this case pass for the wrong reason.
    const store = new MemoryMirrorStore();
    await store.applyResponse(seededPage());
    const gate = createSyncGate(A);
    const engine = new OhmailEngine({ adapter: gate.guard(adapter) as EngineAdapter, store });
    await engine.hydrate();

    const queued = await engine.mutate({ kind: "move", messageId: MSG, folder: "ohmail/News" } as never);
    expect(queued.status, "the gate's refusal rolled the verb back instead of queueing it")
      .toBe("queued");
    expect(seen, "a mutation reached the wire while nobody had named this mirror").toEqual([]);

    const pending = engine.pendingMutations();
    expect(pending.length, "the queued verb is not in the engine's own pending list").toBe(1);
    const key = pending[0]!.key;
    expect(key, "the queued verb carries no idempotency key").toBeTruthy();

    gate.confirm(A);
    const flushed = await engine.flushPending();
    expect(flushed.map((r) => r.status), "the flush did not confirm the queued verb")
      .toEqual(["confirmed"]);
    expect(seen.length, "the verb was sent more or less than once").toBe(1);
    expect(seen[0]!.kind).toBe("move");
    expect(seen[0]!.key, "the retry minted a NEW idempotency key — the server cannot dedupe it")
      .toBe(key);
    expect(engine.pendingMutations().length, "the verb stayed queued after it was confirmed").toBe(0);
  });

  /**
   * THE GATE'S OWN REFUSAL, INDEPENDENT OF ANY SCHEDULER — the case that makes the identity
   * check in `guard().sync` load-bearing rather than redundant.
   *
   * The scheduler's `mayRequest` also reads identity, so every case above is refused twice over
   * and deleting the gate's own line leaves them all green. That redundancy is not the design:
   * the sentence the gate has always carried is "a gate NOBODY has claimed never refuses", and
   * identity is the exception to it — an unclaimed gate on a NAMED mirror must still refuse,
   * because the claim is about cadence and this is about whose bytes these are.
   */
  it("an UNCLAIMED gate on a named mirror still refuses to sync", async () => {
    setOwnerCookie(A);
    const gate = createSyncGate(A);
    const guarded = gate.guard(countingAdapter() as never) as unknown as EngineAdapter;
    // Nobody has called `claim`. The cadence predicate is absent entirely.
    await expect(guarded.sync({ since: null } as never))
      .rejects.toThrow(/not the one this browser's session belongs to/);
    expect(syncCalls, "an unconfirmed mirror reached the adapter").toBe(0);

    gate.confirm(A);
    await expect(guarded.sync({ since: null } as never)).resolves.toBeTruthy();
    expect(syncCalls).toBe(1);

    // …and a contradicting jar closes it again, still with no scheduler in sight.
    setOwnerCookie(B);
    await expect(guarded.sync({ since: null } as never)).rejects.toThrow(/session belongs to/);
    expect(syncCalls).toBe(1);
  });

  /** 6 — an UN-NAMED engine has no mirror on disk, so it holds. */
  it("an engine with no mirror name holds open", async () => {
    const { engine, gate } = gated(null, countingAdapter());
    expect(gate.identity()).toBe("holds");
    const stop = startSyncScheduler(engine, { gate, visibility: visibleDoc() });
    await settle(50);
    expect(syncCalls, "an un-named engine was gated shut").toBeGreaterThanOrEqual(1);
    stop();
  });

  /** An ABSENT cookie is silence, not contradiction — or a cold session would never sync. */
  it("an absent tf_owner is not a contradiction", async () => {
    setOwnerCookie(null);
    const { engine, gate } = gated(A, countingAdapter());
    const stop = startSyncScheduler(engine, { gate, visibility: visibleDoc() });
    gate.confirm(A);
    await settle(50);
    expect(syncCalls, "a dropped cookie was read as another account's session")
      .toBeGreaterThanOrEqual(1);
    stop();
  });
});

describe("a CONTRADICTED browser reads nothing either", () => {
  /**
   * ── THE HOLE THE MERGE GATE LEFT OPEN ──────────────────────────────────────────────────────
   *
   * `sync`, `snapshot` and `mutate` require `holds`, which protects what lands ON DISK. The
   * reads were left ungated on the argument that the server filters by the session's account and
   * that A's ids return 404 under B, so nothing foreign could land.
   *
   * The ids are the hole. Search and Load older mail ask for a LIST, which is keyed on no id
   * this mirror holds: under a foreign session they answer with that account's rows, and every
   * id in the answer then unlocks the body route, the thread batch and the attachment bytes. A
   * tab in this state is still interactive — the strip says the mailbox has stopped syncing and
   * the mail underneath is still clickable — so none of this needs a second sign-in to reach.
   */
  const capabilities = (): Record<string, unknown> => ({
    sync: async (): Promise<SyncResponse> => { syncCalls += 1; return emptyPage(); },
    mutate: async (): Promise<MutationOutcome> => ({ status: "applied", entities: [] } as unknown as MutationOutcome),
    fetchBody: async () => { reads.push("fetchBody"); return null; },
    fetchBodies: async () => { reads.push("fetchBodies"); return []; },
    searchServer: async () => { reads.push("searchServer"); return { messages: [], nextCursor: null }; },
    listMessages: async () => { reads.push("listMessages"); return { messages: [], nextCursor: null }; },
    requestPull: async () => { reads.push("requestPull"); return { ok: true }; },
    reportSyncFailure: async () => { reads.push("reportSyncFailure"); },
    reportSearchPhases: async () => { reads.push("reportSearchPhases"); },
    listAttachments: async () => { reads.push("listAttachments"); return []; },
    fetchAttachment: async () => { reads.push("fetchAttachment"); return new Blob(); },
    fetchAllAttachments: async () => { reads.push("fetchAllAttachments"); return new Blob(); },
    unsubscribe: async () => { reads.push("unsubscribe"); return { state: "unsubscribed" }; },
    snapshot: async () => { reads.push("snapshot"); return { changes: [], asOfSeq: 1, nextCursor: null }; },
    searchAddressServer: async () => { reads.push("searchAddressServer"); return { messages: [], nextCursor: null }; },
    fetchDraftBody: async () => { reads.push("fetchDraftBody"); return "text"; },
    listTrash: async () => { reads.push("listTrash"); return { messages: [], nextCursor: null }; },
    restoreFromTrash: async () => { reads.push("restoreFromTrash"); return { restored: 0 }; },
    heldReleases: async () => { reads.push("heldReleases"); return { groups: [], total: 0 }; },
    whyStayed: async () => { reads.push("whyStayed"); return []; },
    releaseHeld: async () => { reads.push("releaseHeld"); return { released: [], total: 0 }; },
    dismissHeldRelease: async () => { reads.push("dismissHeldRelease"); },
    unscreened: async () => { reads.push("unscreened"); return { groups: [], total: 0, max: 200 }; },
    screenUnscreened: async () => { reads.push("screenUnscreened"); return { screened: [], total: 0 }; },
    screenerWaiting: async () => { reads.push("screenerWaiting"); return { items: [], nextCursor: null, total: 0, inFlight: [] }; },
    organizerRequests: async () => { reads.push("organizerRequests"); return []; },
    timeline: async () => { reads.push("timeline"); return { total: 0, months: [], undated: 0 }; },
    getMessage: async () => { reads.push("getMessage"); return null; },
    withdrawSend: async () => { reads.push("withdrawSend"); return { outcome: "withdrawn" }; },
    forwardPartsAnnounced: async () => { reads.push("forwardPartsAnnounced"); return true; },
  });

  let reads: string[] = [];
  beforeEach(() => { reads = []; });

  /**
   * Every door on the wrapper — DERIVED from the adapter's own declaration, never listed here.
   *
   * `unsubscribe` was once missing from both this list and the wrapper, and the two absences hid
   * each other: a census that does not name a capability cannot report it unforwarded. Three more
   * had gone the same way by 0.19.2 — see {@link DECLARED}. A name now arrives here by being
   * declared over there, and {@link NOT_A_READ} is the only hand-kept part, each entry with its
   * reason.
   */
  const READS: readonly string[] = DECLARED.filter((k) => !NOT_A_READ.includes(k));

  /**
   * THE CENSUS ITSELF — every declared capability survives `guard`, driven through the real
   * wrapper. A forward deleted from the literal reddens here by name; a capability added to
   * `EngineAdapter` and forgotten by the wrapper reddens here on its first day.
   */
  it("forwards every capability the adapter declares", () => {
    setOwnerCookie(A);
    const gate = createSyncGate(A);
    const guarded = gate.guard(capabilities() as never) as unknown as Record<string, unknown>;
    // The parse is the premise: a regex that matched nothing would make every assertion below
    // vacuous, so the shape of what it read is asserted before it is used.
    expect(DECLARED.length, "the declaration parse found nothing").toBeGreaterThanOrEqual(15);
    expect(DECLARED, "a name no source declares reached the derived set").not.toContain("transport");
    const missing = DECLARED.filter((k) => typeof guarded[k] !== "function");
    expect(missing, "the gate drops a capability the engine binds").toEqual([]);
  });

  /**
   * And the stub keeps up with the declaration: the refusal arms below prove nothing about a
   * capability nothing in this file supplies. This is the line that tells the next author to
   * teach `capabilities()` about their new door rather than letting it pass unmeasured.
   */
  it("the fixture supplies every capability the adapter declares", () => {
    const absent = DECLARED.filter((k) => !(k in capabilities()));
    expect(absent, "a declared capability is not exercised by these tests").toEqual([]);
  });

  /**
   * A CANCEL'S QUESTION IS NOT A READ: it decides a send key on the account the session holds, so
   * it is asked only while the identity holds. Refused, in the warm open or under another
   * account's session, it answers `unreachable` and never reaches the adapter.
   */
  it("asks withdrawSend only while the identity holds; otherwise it answers unreachable", async () => {
    setOwnerCookie(A);
    const gate = createSyncGate(A);
    const guarded = gate.guard(capabilities() as never) as unknown as Record<string, unknown>;
    const ask = guarded.withdrawSend as (key: string, draftId: string | null) => Promise<unknown>;
    expect(gate.identity()).toBe("unconfirmed");
    expect(await ask("key-1", null), "an unconfirmed tab decided a send key").toEqual({ outcome: "unreachable" });
    gate.confirm(A);
    expect(await ask("key-1", null), "a held identity did not ask the server").toEqual({ outcome: "withdrawn" });
    setOwnerCookie(B);
    expect(await ask("key-1", null), "a Cancel was asked under another account's session")
      .toEqual({ outcome: "unreachable" });
    expect(reads, "the question reached the adapter outside a held identity").toEqual(["withdrawSend"]);
  });

  /**
   * THE PRESS IS NOT A READ. `releaseHeld` records consent on the account's own rules and its
   * answer is re-read into the mirror, so it requires `holds` where a read takes the warm open.
   * "Not now" and the press are the same kind of press. In the warm open each WAITS for the
   * confirm and reaches the adapter only after it; with no confirm inside the wait it refuses.
   */
  for (const press of ["releaseHeld", "dismissHeldRelease", "screenUnscreened"] as const) {
    it(`holds ${press} until the confirm has landed`, async () => {
      setOwnerCookie(A);
      const gate = createSyncGate(A);
      const guarded = gate.guard(capabilities() as never) as unknown as Record<string, unknown>;
      expect(gate.identity()).toBe("unconfirmed");
      const pressed = call(guarded, press);
      await settle(0);
      expect(reads, "an unconfirmed tab's press reached the adapter").toEqual([]);
      gate.confirm(A);
      await pressed;
      expect(reads, "the press never reached the adapter under its own account").toEqual([press]);
    });

    it(`refuses ${press} when no confirm lands inside the wait`, async () => {
      setOwnerCookie(A);
      const gate = createSyncGate(A);
      const guarded = gate.guard(capabilities() as never) as unknown as Record<string, unknown>;
      const verdict = expect(call(guarded, press), "an unconfirmed press outlived its wait")
        .rejects.toBeInstanceOf(ForeignSessionError);
      await settle(PRESS_CONFIRM_WAIT_MS);
      await verdict;
      expect(reads).toEqual([]);
    });
  }

  const call = (guarded: Record<string, unknown>, name: string): Promise<unknown> =>
    (guarded[name] as (...a: unknown[]) => Promise<unknown>)("x");

  it("refuses every read while the jar names another account", async () => {
    setOwnerCookie(A);
    const gate = createSyncGate(A);
    const guarded = gate.guard(capabilities() as never) as unknown as Record<string, unknown>;
    gate.confirm(A);

    // The control FIRST: with the jar agreeing, every one of them reaches the adapter. Without
    // this the refusals below would be green over a wrapper that simply dropped the capability.
    for (const name of READS) await call(guarded, name);
    expect(reads, "a capability never reached the adapter, so its refusal proves nothing")
      .toEqual([...READS]);

    reads = [];
    setOwnerCookie(B);
    for (const name of READS) {
      await expect(call(guarded, name), `${name} answered under another account's session`)
        .rejects.toBeInstanceOf(ForeignSessionError);
    }
    expect(reads, "a read reached the wire with the jar naming somebody else").toEqual([]);
  });

  /**
   * UNCONFIRMED IS NOT CONTRADICTED, and this is the case that keeps the warm open warm.
   *
   * A tab whose confirm has not answered yet is looking at its own mail under a jar that either
   * agrees or says nothing. Refusing its reads would blank the pane for the length of the check
   * — which is the flicker the whole slice removes, arriving by another door.
   */
  it("allows every read while the confirm has simply not answered yet", async () => {
    setOwnerCookie(A);
    const gate = createSyncGate(A); // nobody has confirmed
    const guarded = gate.guard(capabilities() as never) as unknown as Record<string, unknown>;
    expect(gate.identity()).toBe("unconfirmed");
    for (const name of READS) await call(guarded, name);
    expect(reads, "a warm mirror stopped answering its own reader mid-check").toEqual([...READS]);
    // …while the two that write to disk still refuse, which is the whole distinction.
    await expect((guarded.sync as (p: unknown) => Promise<unknown>)({ since: null }))
      .rejects.toThrow(/session belongs to/);
    await expect((guarded.snapshot as (p: unknown) => Promise<unknown>)({}))
      .rejects.toThrow(/session belongs to/);
    expect(syncCalls).toBe(0);
  });

  /**
   * THE SNAPSHOT'S PAGES 2..n — the residual the merge gate left behind, closed.
   *
   * A cold account's bootstrap is ~37 pages over several seconds. A sign-in as somebody else in
   * another tab rewrites the jar mid-bootstrap, and every remaining page was selected from the
   * NEW session and written into the mirror named for the old one — durably, because the mirror
   * holds no tombstones for ids it should never have had.
   */
  it("stops a multi-page snapshot at the page after the flip", async () => {
    setOwnerCookie(A);
    let pages = 0;
    const gate = createSyncGate(A);
    const guarded = gate.guard({
      ...capabilities(),
      snapshot: async () => {
        pages += 1;
        if (pages === 1) setOwnerCookie(B); // the sign-in lands between page 1 and page 2
        return { changes: [], asOfSeq: pages, nextCursor: `p${pages}` };
      },
    } as never) as unknown as Record<string, unknown>;
    gate.confirm(A);

    /*
     * PAGE ONE'S OWN RESULT IS REFUSED NOW, not merely page two. The flip lands while page 1 is
     * in flight, and a page is written straight into the mirror on disk — where there is no
     * tombstone for a row that never belonged — so an answer that turns out to have been issued
     * across a session change may not be applied at all. The earlier shape of this case let page
     * 1 through and caught page 2, which is one page of somebody else's mail too many.
     */
    await expect((guarded.snapshot as (p: unknown) => Promise<unknown>)({}))
      .rejects.toThrow(/in flight/);
    expect(pages, "the request never left, so the in-flight refusal proves nothing").toBe(1);

    // …and the next page does not even reach the wire.
    await expect((guarded.snapshot as (p: unknown) => Promise<unknown>)({ cursor: "p1" }))
      .rejects.toThrow(/session belongs to/);
    expect(pages, "page 2 of the snapshot was selected under the other account's session").toBe(1);
  });

  /** The gate's own rejection contract, named at the level it is implemented. */
  it("refuses a mutation RETRYABLY rather than with a plain Error", async () => {
    setOwnerCookie(A);
    const gate = createSyncGate(A);
    const guarded = gate.guard(capabilities() as never) as unknown as EngineAdapter;
    const err = await guarded.mutate({ kind: "move" } as never, undefined as never)
      .then(() => null, (e: unknown) => e);
    expect(err, "the refusal is not the class the engine reads as retryable")
      .toBeInstanceOf(MutationRejectedError);
    expect((err as MutationRejectedError).retryable,
      "a non-retryable refusal rolls the overlay back — the click is silently discarded")
      .toBe(true);
  });

  /**
   * THE SAME ANSWER, FOR THE DOORS THAT DO NOT GO THROUGH AN ADAPTER.
   *
   * Two Cloud readers reach the API without touching `EngineAdapter` — the reach-past body door
   * and the mailbox-facts poll — so wrapping the adapter cannot reach them. They ask
   * `syncIdentityOf` instead, and this pins that the export answers off the SAME gate rather
   * than being a second implementation of the question.
   */
  /**
   * ═══ UNSUBSCRIBE REACHES THE WIRE AT ALL ══════════════════════════════════════════════════
   *
   * Driven through the REAL `OhmailEngine`, because that is where the defect lived and a check
   * against the wrapper alone cannot see it. `OhmailEngine.unsubscribe` reads the capability
   * structurally and answers `null` when the adapter has none — and this wrapper is an explicit
   * object literal that did not forward it, so on the live path every account got `null`. The
   * Screener maps that answer to the SUCCESS sentence: the control rendered, the press ran, no
   * request left the browser, and the person was told their unsubscribe had been sent.
   *
   * The demo is never wrapped, so the loss was live-path only and every suite stayed green.
   */
  it("an unsubscribe issued through the real engine reaches the adapter", async () => {
    setOwnerCookie(A);
    let asked = 0;
    const adapter = {
      sync: async (): Promise<SyncResponse> => emptyPage(),
      mutate: async (): Promise<MutationOutcome> => ({ seq: 1, changes: [] } as unknown as MutationOutcome),
      fetchBody: async () => null,
      unsubscribe: async () => { asked += 1; return { state: "unsubscribed" as const }; },
    } as unknown as EngineAdapter;
    const gate = createSyncGate(A);
    const engine = new OhmailEngine({
      adapter: gate.guard(adapter) as EngineAdapter,
      store: new MemoryMirrorStore(),
    });
    gate.confirm(A);

    const out = await engine.unsubscribe("m1");
    expect(asked, "the press issued no request — the capability is not forwarded").toBe(1);
    expect(out, "the engine reported no capability where one exists").not.toBeNull();

    // …and under a foreign session it refuses rather than acting at a third party in somebody
    // else's name. This one is not a read: it cannot be taken back.
    setOwnerCookie(B);
    await expect(engine.unsubscribe("m1"), "an unsubscribe ran under another account's session")
      .rejects.toBeInstanceOf(ForeignSessionError);
    expect(asked).toBe(1);
  });

  /**
   * ═══ THE FAILED SIGN-OUT ══════════════════════════════════════════════════════════════════
   *
   * The sequence, exactly as review reported it:
   *
   *   1. Tab A confirms account A and keeps A's named mirror.
   *   2. Somebody signs into B in another tab of the same profile.
   *   3. B asks to sign out and the server call FAILS — refused, or never answered.
   *   4. The local half runs anyway, as it must, and it used to erase the storage-owner marker.
   *   5. B's HttpOnly session is still live on the server; nothing readable says whose it is.
   *   6. A's gate read the absence as silence, silence as permission, and resumed — syncing,
   *      reading and mutating through a session nobody in that window was signed in to.
   *
   * Two independent things now stop it, and both are asserted here because either alone would
   * leave the sequence reachable by another route: the failed sign-out SAYS so rather than
   * erasing, and a confirmation does not outlive a change in what the marker says.
   */
  it("a refused sign-out closes a confirmed mirror rather than freeing it", async () => {
    setOwnerCookie(A);
    const gate = createSyncGate(A);
    const guarded = gate.guard(capabilities() as never) as unknown as Record<string, unknown>;
    gate.confirm(A);
    expect(gate.identity(), "the control never opened, so nothing below is a closure").toBe("holds");
    await call(guarded, "fetchBody");
    expect(reads, "the gate was shut before the sequence began").toEqual(["fetchBody"]);
    reads = [];

    // Step 3-4: the sign-out's local half, on the path where the server did not confirm it.
    const { markSignedOutPending } = await import("../app/shell/owner-cookie.js");
    markSignedOutPending();

    expect(gate.identity(), "a refused sign-out left a confirmed mirror open").toBe("contradicted");
    for (const name of READS) {
      await expect(call(guarded, name), `${name} answered through a session a sign-out failed to revoke`)
        .rejects.toBeInstanceOf(ForeignSessionError);
    }
    await expect((guarded.sync as (p: unknown) => Promise<unknown>)({ since: null }))
      .rejects.toThrow(/session belongs to/);
    expect(reads, "a read reached the wire after a refused sign-out").toEqual([]);
    expect(syncCalls).toBe(0);
  });

  /**
   * AND THE SECOND HALF ON ITS OWN: even if the marker simply VANISHES — a browser that drops
   * it, an older client, a hand-cleared cookie — a confirmation granted while it said A does not
   * survive it saying nothing. Absence is still not a contradiction, and it is still the END of
   * a grant, which is all this needs to be.
   */
  it("a confirmation does not survive the marker going absent", async () => {
    setOwnerCookie(A);
    const gate = createSyncGate(A);
    const guarded = gate.guard(capabilities() as never) as unknown as Record<string, unknown>;
    gate.confirm(A);
    expect(gate.identity()).toBe("holds");

    setOwnerCookie(null);
    expect(gate.identity(), "an absent marker left the old confirmation standing").toBe("revoked");
    await expect(call(guarded, "searchServer"), "a search ran on a lapsed confirmation")
      .rejects.toBeInstanceOf(ForeignSessionError);
    await expect((guarded.sync as (p: unknown) => Promise<unknown>)({ since: null }))
      .rejects.toThrow(/session belongs to/);

    // A COLD session whose marker was never there is untouched: absence at the start is silence,
    // and this is the case the "an absent cookie is not a contradiction" rule was written for.
    const cold = createSyncGate(A);
    setOwnerCookie(null);
    expect(cold.identity(), "a mirror whose marker was never present was refused outright")
      .toBe("unconfirmed");
    cold.confirm(A);
    expect(cold.identity(), "a cold session with no marker could not be confirmed").toBe("holds");
  });

  /**
   * ═══ A CHANGE BEFORE THE CONFIRMATION COUNTS TOO ══════════════════════════════════════════
   *
   * The revocation used to be written `if (confirmedFor !== null)`, which reads as a tidy no-op
   * and is a hole the width of the whole confirm ladder — four attempts, up to about thirty
   * seconds, during which a WARM MIRROR is on screen and its reads are deliberately allowed.
   *
   * Review's sequence: warm mirror A opens; the confirmation is pending or retrying; another tab
   * establishes B; the readable marker is then removed — an older tab, a malformed write, a
   * hand-cleared cookie — while B's HttpOnly session lives on. The change was seen and thrown
   * away because nobody had confirmed anything yet, the gate stayed `unconfirmed`, and search,
   * message bodies and attachments went on answering. Sync and mutations were closed the whole
   * time; the bytes came back through the reads.
   */
  it("a marker change during the confirm ladder revokes an unconfirmed mirror", async () => {
    setOwnerCookie(A);
    const gate = createSyncGate(A);
    const guarded = gate.guard(capabilities() as never) as unknown as Record<string, unknown>;

    // Nobody has confirmed anything. This is the warm open, and its reads are allowed — the
    // control, without which the refusal below is green over a gate that was shut all along.
    expect(gate.identity()).toBe("unconfirmed");
    await call(guarded, "searchServer");
    expect(reads).toEqual(["searchServer"]);
    reads = [];

    // The marker goes while the ladder is still running.
    setOwnerCookie(null);
    expect(gate.identity(), "a change before the confirmation was thrown away").toBe("revoked");
    for (const name of READS) {
      await expect(call(guarded, name), `${name} answered after the marker changed mid-ladder`)
        .rejects.toBeInstanceOf(ForeignSessionError);
    }
    expect(reads).toEqual([]);
  });

  /**
   * AND THE WINDOW BEFORE ANYBODY ASKS. `lastSeen` is seeded when the gate is BUILT, because the
   * gate is built in the same act that reads the marker to choose which mirror to open. Left to
   * the first `identity()` call, a change between those two moments was the baseline rather than
   * a transition — and the baseline is the one thing that can never revoke.
   */
  it("seeds its baseline at construction, so a change before the first read still counts", async () => {
    setOwnerCookie(A);
    const gate = createSyncGate(A);        // built while the marker says A, nothing asked yet
    setOwnerCookie(null);                  // …and it changes before anybody calls identity()
    expect(gate.identity(), "the first read took the CHANGED marker as its baseline")
      .toBe("revoked");
  });

  /**
   * ═══ THE ROUND TRIP THAT LEAVES NO TRACE — A→B→A ══════════════════════════════════════════
   *
   * The marker ends up reading exactly what it read before, so every check that compares it
   * against the mirror's name passes, at both ends of a request. What happened in between is
   * invisible to a comparison and entirely visible to a TRANSITION, which is why the gate
   * watches for change rather than for difference.
   */
  it("an A-to-B-to-A round trip revokes the confirmation it started with", async () => {
    setOwnerCookie(A);
    const gate = createSyncGate(A);
    const guarded = gate.guard(capabilities() as never) as unknown as Record<string, unknown>;
    gate.confirm(A);
    expect(gate.identity()).toBe("holds");

    setOwnerCookie(B);
    expect(gate.identity()).toBe("contradicted");
    setOwnerCookie(A);

    // The marker says A, the mirror is A's, and nothing may merge until the server says so.
    expect(gate.identity(), "the round trip left the confirmation standing").toBe("revoked");
    await expect(call(guarded, "fetchBody")).rejects.toBeInstanceOf(ForeignSessionError);
    gate.confirm(A);
    expect(gate.identity(), "a fresh confirmation did not reopen the gate").toBe("holds");
    await call(guarded, "fetchBody");
    expect(reads).toEqual(["fetchBody"]);
  });

  /**
   * ═══ A MUTATION'S OUTCOME, ARRIVING AFTER THE SESSION CHANGED ════════════════════════════
   *
   * The arrival check exists on reads, pages AND mutations, and only the first two had a test —
   * so deleting the mutation one was green. It is the one that matters most of the three: a
   * mutation's outcome is APPLIED to the mirror, so an answer issued under another session both
   * acted on the wrong account's server state and would write the result into this one's.
   *
   * Retryable, as at the top: the verb stays queued under the same idempotency key and is flushed
   * once the gate opens, so the click happens exactly once, under the right session, later.
   */
  it("discards a mutation outcome whose session changed while it was in flight", async () => {
    setOwnerCookie(A);
    const gate = createSyncGate(A);
    let sent = 0;
    const guarded = gate.guard({
      ...capabilities(),
      mutate: async () => {
        sent += 1;
        setOwnerCookie(B);              // the other tab signs in mid-flight
        return { seq: 2, changes: [] } as unknown as MutationOutcome;
      },
    } as never) as unknown as EngineAdapter;
    gate.confirm(A);

    const err = await guarded.mutate({ kind: "move" } as never, undefined as never)
      .then(() => null, (e: unknown) => e);
    expect(sent, "the mutation never left, so nothing was discarded").toBe(1);
    expect(err, "an outcome issued across a session change was applied to this mirror")
      .toBeInstanceOf(MutationRejectedError);
    expect((err as MutationRejectedError).retryable,
      "the refusal discards the verb instead of queueing it for the right session").toBe(true);
  });

  /**
   * ═══ THE ANSWER THAT ARRIVES AFTER THE SESSION CHANGED ════════════════════════════════════
   *
   * The pre-request check is a check at REQUEST time, and a request is not instantaneous:
   * another tab can rewrite the shared jar between the check and the credentials going out, or
   * at any point during the flight. The response then belongs to whoever the jar named when the
   * server read it, and nothing in the body says which.
   */
  it("discards a read whose session changed while it was in flight", async () => {
    setOwnerCookie(A);
    const gate = createSyncGate(A);
    let served = 0;
    const guarded = gate.guard({
      ...capabilities(),
      fetchBody: async () => {
        served += 1;
        setOwnerCookie(B);            // the other tab signs in mid-flight
        return { text: "another account's message body" };
      },
    } as never) as unknown as Record<string, unknown>;
    gate.confirm(A);

    await expect(call(guarded, "fetchBody"), "a body issued across a session change was returned")
      .rejects.toBeInstanceOf(ForeignSessionError);
    expect(served, "the request never left, so nothing was discarded").toBe(1);
    // The DEPARTURE check passed — identity was `holds` when this was issued — so the refusal
    // above can only have come from the arrival check. That is the property under test.
    expect(gate.identity()).toBe("contradicted");
  });

  /**
   * THE TERMINAL PROBE HAS TWO CAUSES AND THIS ARM IS RIGHT FOR ONE.
   *
   * `SessionEnded` hurries a refusal along with one `POST /auth/refresh`, which is correct when
   * the server refused THIS account: the answer is definitive in both directions. It is wrong
   * when the loop stopped because the jar names somebody ELSE — the refresh then carries that
   * account's cookies, cannot heal this tab (its session is not in the jar), and rotates a
   * stranger's refresh token from a window that is not theirs.
   *
   * A source check, because the surface mounts only behind a live engine and a confirmed server
   * state; what it pins is that the identity question is asked at all, and asked in the effect
   * rather than off a render-time value the cookie can outrun.
   */
  it("the terminal session probe asks whose session this is first", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${process.cwd()}/apps/webapp/app/shell/engine.tsx`, "utf8");
    const body = src.slice(src.indexOf("const evidence = sync.refused || sync.terminal;"));
    const probeAt = body.indexOf("probeSessionNow();");
    const guardAt = body.indexOf('syncIdentityOf(engine) !== "holds"');
    expect(guardAt, "the terminal probe stopped asking whose session this is").toBeGreaterThan(-1);
    /* `!== "holds"` rather than `=== "contradicted"`: a REVOKED gate — one whose confirmation the
       marker has outlived — has as little business renewing a session as a contradicted one, and
       the narrower test left the failed-sign-out sequence free to do exactly that. */
    expect(body, "the probe narrowed back to positive contradictions only")
      .not.toContain('syncIdentityOf(engine) === "contradicted"');
    expect(guardAt, "the identity check runs AFTER the probe it is meant to prevent")
      .toBeLessThan(probeAt);
    // In the effect, so the jar is read when the probe would fire rather than a render earlier.
    expect(body.slice(0, guardAt), "the check moved out of the effect")
      .toContain("useEffect(() => {");
  });

  it("syncIdentityOf answers off the engine's own gate", async () => {
    setOwnerCookie(A);
    const gate = createSyncGate(A);
    // Registered exactly as `engine-config.ts` does it — the association is what `syncIdentityOf`
    // reads, and an engine whose gate was never registered would answer `holds` for ever.
    const engine = registerSyncGate(
      new OhmailEngine({ adapter: gate.guard(countingAdapter()) as EngineAdapter, store: new MemoryMirrorStore() }),
      gate,
    );
    expect(syncIdentityOf(engine)).toBe("unconfirmed");
    gate.confirm(A);
    expect(syncIdentityOf(engine)).toBe("holds");
    setOwnerCookie(B);
    expect(syncIdentityOf(engine)).toBe("contradicted");
    // An engine with no gate at all — the demo, the desktop's host-built one — has no Cloud
    // session to be wrong about.
    expect(syncIdentityOf(new OhmailEngine({ adapter: countingAdapter(), store: new MemoryMirrorStore() })))
      .toBe("holds");
    expect(syncIdentityOf(null)).toBe("holds");
  });
});

/**
 * THE WARM LOAD: the shell starts this loop before the session confirm lands, so the opener at
 * start is refused by identity. The gate opening must dial it, or a warm tab polls for its whole
 * life (STALE-WEB-WAKE-STREAM-NOT-OPENED). MUTATION WATCHED: `gate?.onOpen(wake)` as it stood.
 */
describe("the gate opening connects the wake stream", () => {
  class Stream implements WakeStreamLike {
    readyState = 0;
    private readonly listeners = new Map<string, Set<() => void>>();
    addEventListener(type: "open" | "sync" | "error", l: () => void): void {
      const set = this.listeners.get(type) ?? new Set<() => void>();
      set.add(l);
      this.listeners.set(type, set);
    }
    close(): void { this.readyState = WAKE_STREAM_CLOSED; }
    fire(type: string): void { for (const l of [...(this.listeners.get(type) ?? [])]) l(); }
    open(): void { this.readyState = 1; this.fire("open"); }
    /** A non-200, `sse_disabled` among them: EventSource gives up and so must the loop. */
    refuse(): void { this.readyState = WAKE_STREAM_CLOSED; this.fire("error"); }
  }
  const streams: Stream[] = [];
  const factory = (): WakeStreamLike => { const s = new Stream(); streams.push(s); return s; };
  beforeEach(() => { streams.length = 0; });

  it("a loop started unconfirmed opens no stream, and the confirmation opens one", async () => {
    setOwnerCookie(A);
    const { engine, gate } = gated(A, countingAdapter());
    const stop = startSyncScheduler(engine, { gate, visibility: visibleDoc(), wake: factory, report: () => {} });
    await settle(50);
    expect(streams, "a stream was opened for a session nobody had confirmed").toHaveLength(0);

    gate.confirm(A);
    await settle(0);
    streams[0]?.open();
    // Inside WAKE_STREAM_SILENCE_MS: a stream silent past it is closed and re-dialled by design.
    await settle(POLL_MS * 3);
    expect(syncCalls, "the gate opening did not drain").toBeGreaterThanOrEqual(1);
    expect(streams.length, "a warm load never dialled the wake stream").toBeGreaterThanOrEqual(1);
    expect(streams, "the open was dialled twice").toHaveLength(1);
    stop();
  });

  /**
   * THE CLOUD WHILE `TF_SSE` IS OFF answers `503 sse_disabled`: ONE refused /events, then at most
   * one a minute, and /sync at today's 8 s. MUTATION WATCHED: drop the minute check from
   * `connectStream` and the hide-and-show and the second confirm re-dial it (3 dials).
   */
  it("a flag-off server is dialled once and the tab keeps its 8 s poll", async () => {
    setOwnerCookie(A);
    const syncAt: number[] = [];
    const base = countingAdapter();
    const adapter = { ...base, sync: async (p: SyncParams) => { syncAt.push(Date.now()); return base.sync(p); } } as EngineAdapter;
    const { engine, gate } = gated(A, adapter);
    const doc = visibleDoc();
    const stop = startSyncScheduler(engine, { gate, visibility: doc, wake: factory, report: () => {} });
    gate.confirm(A);
    await settle(0);
    expect(streams, "the control: the confirmation dialled nothing").toHaveLength(1);
    streams[0]!.refuse();

    const gapsOver = (from: number): number => {
      let worst = 0;
      let prev = from;
      for (const t of syncAt.filter((x) => x >= from)) { worst = Math.max(worst, t - prev); prev = t; }
      return Math.max(worst, Date.now() - prev);
    };
    let from = Date.now();
    await settle(POLL_MS * 4 + 100);
    expect(streams, "a refused stream was dialled again while the tab only waited").toHaveLength(1);
    expect(gapsOver(from), "the poll fell off its 8 s cadence").toBeLessThanOrEqual(POLL_MS + 100);

    // Every later door that dials: a hide and show, and the gate opening again after a round trip.
    doc.visibilityState = "hidden";
    doc.fire();
    doc.visibilityState = "visible";
    doc.fire();
    setOwnerCookie(B);
    await settle(POLL_MS);
    setOwnerCookie(A);
    doc.fire();
    gate.confirm(A);
    await settle(0);
    expect(streams, "a refused stream was dialled again").toHaveLength(1);

    const before = syncCalls;
    from = Date.now();
    await settle(POLL_MS * 10 + 100);
    expect(syncCalls - before, "a poll-only tab stopped polling at the fast cadence").toBeGreaterThanOrEqual(10);
    expect(gapsOver(from), "the poll fell off its 8 s cadence").toBeLessThanOrEqual(POLL_MS + 100);
    // A minute on, one re-ask from a settled drain; it stays pending, so nothing asks again.
    expect(streams, "a refused stream was asked again more than once a minute").toHaveLength(2);
    stop();
  });
});
