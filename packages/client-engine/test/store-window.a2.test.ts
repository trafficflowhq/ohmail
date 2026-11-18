import type { EngineDraft, EngineMessage, MessageStateDTO, MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedDbMirrorStore,
  DEFAULT_STORE_POLICY,
  MemoryMirrorStore,
  OhmailEngine,
  RENDERED_PINS,
  type EngineAdapter,
  type StorePolicy,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * ═══ THE WINDOWED STORE ═══════════════════════════════════════════════════════════════
 *
 * The browser mirror is a cache in front of a Cloud that still holds everything; the desktop
 * mirror is the mail itself. One engine serves both, so the eviction pass has to be opt-IN and
 * the absent-config branch has to be today's behaviour exactly — a mailbox that prunes because
 * nobody configured it is data loss with no error message.
 *
 * Every guard below was watched RED against a named mutation of the implementation, then the
 * implementation was restored. The mutations are recorded per test.
 */

const NOW = new Date("2026-08-07T12:00:00.000Z");
const DAY = 86_400_000;

/** `n` days before NOW, as the ISO string a message's `date` carries. */
function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * DAY).toISOString();
}

let seq = 0;

function msg(id: string, date: string): EngineMessage {
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
    date,
    folder: "INBOX",
    snippet: "snippet",
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: date,
  };
}

function create(type: string, id: string, entity: unknown): SyncChange {
  return { type, op: "create", id, seq: ++seq, updatedAt: NOW.toISOString(), entity };
}

/** The same, as an UPDATE — the op every server writer re-emits a row it already wrote under. */
function update(type: string, id: string, entity: unknown): SyncChange {
  return { type, op: "update", id, seq: ++seq, updatedAt: NOW.toISOString(), entity };
}

/** A `/sync` that answers one scripted page then goes quiet, so `drain()` completes. */
function adapterOf(pages: SyncChange[][] = []): EngineAdapter & { calls: string[] } {
  const calls: string[] = [];
  const queue = [...pages];
  return {
    calls,
    sync: async (params: { since: string }): Promise<SyncResponse> => {
      calls.push(params.since);
      const changes = queue.shift() ?? [];
      return {
        changes: { creates: changes, updates: [], moves: [], deletes: [] },
        cursor: String(seq),
        hasMore: false,
        serverTime: NOW.toISOString(),
      };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
  } as unknown as EngineAdapter & { calls: string[] };
}

/** A mirror seeded with `messages` and whatever extra rows a test needs to pin with. */
async function seeded(messages: EngineMessage[], extra: SyncChange[] = []): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([...messages.map((m) => create("message", m.id, m)), ...extra]);
  return store;
}

function ids(store: MemoryMirrorStore): string[] {
  return store.entries<EngineMessage>("message").map((e) => e.id).sort();
}

/** The engine a drain runs on, handed back so a test can act on it BEFORE the drain. */
function engineOver(store: MemoryMirrorStore, storePolicy?: StorePolicy): OhmailEngine {
  return new OhmailEngine({
    adapter: adapterOf(),
    store,
    now: () => NOW,
    ...(storePolicy ? { storePolicy } : {}),
  });
}

async function drainWith(store: MemoryMirrorStore, storePolicy?: StorePolicy): Promise<void> {
  await engineOver(store, storePolicy).syncOnce();
}

/** Twelve messages, one per day going back, so `days`/`minRows` can be aimed precisely. */
function ladder(count = 12): EngineMessage[] {
  return Array.from({ length: count }, (_, i) => msg(`m${i}`, daysAgo(i)));
}

// ── GUARD 1: THE DEFAULT-POLICY PIN ────────────────────────────────────────────────────────

describe("the default policy", () => {
  /**
   * ── WHY THIS ONE MIRROR IS 600 ROWS AND THE REST ARE 12 ───────────────────────────────────
   *
   * The first version of this guard used the same 12-row ladder as everything below, and it did
   * NOT go red against the mutation it exists to catch. Changing the engine's resolution to
   * `opts.storePolicy ?? { mode: "windowed", days: 30, minRows: 500 }` — a "reasonable default"
   * of exactly the shape that would quietly truncate a desktop mailbox — left all 13 tests green,
   * because `pruneToPolicy` returns early on `rows.length <= minRows` and twelve rows are under
   * any plausible floor. The guard was asserting a fact about a dataset too small to distinguish
   * "the pass did not run" from "the pass ran and found nothing to do".
   *
   * So the dataset is sized to defeat the mutation instead of the assertion being weakened: enough
   * rows, every one of them 400+ days old, which no windowed policy a host might plausibly
   * default to can leave intact. With the mutation above it now fails on 500 vs 600.
   */
  it("WINDOWS a mirror whose host configured nothing — there is no unlimited default any more", async () => {
    const store = await seeded(Array.from({ length: 600 }, (_, i) => msg(`m${i}`, daysAgo(400 + i))));
    await drainWith(store); // no storePolicy — the absent-config branch

    // This mirror is under `DEFAULT_STORE_POLICY.minRows`, so nothing is evicted HERE; what this
    // asserts is that the mirror is one the pass RUNS over. The eviction itself is the case below,
    // driven at a size the default floor can decide.
    expect(ids(store)).toHaveLength(600);
    expect(engineOver(store).storeWindow()).toEqual({ days: 90, minRows: 5000 });
  });

  /**
   * AND IT EVICTS. The guard above cannot distinguish "the default is a window" from "the default
   * prunes nothing", because so few rows are under any plausible floor — the very trap the small
   * sizing above was chosen to defeat, now pointing the other way. So the default is driven at a
   * size ONLY it can decide: more rows than its floor, all older than its 90 days.
   *
   * WATCHED RED by restoring `opts.storePolicy ?? { mode: "full" }`: every row held where the floor is
   * owed.
   */
  it("… and the default really is a bound: old rows past it settle at its floor", async () => {
    const store = await seeded(Array.from({ length: 5001 }, (_, i) => msg(`m${i}`, daysAgo(400 + i))));
    await drainWith(store); // no storePolicy

    expect(ids(store)).toHaveLength(DEFAULT_STORE_POLICY.mode === "windowed"
      ? DEFAULT_STORE_POLICY.minRows
      : 5001);
  });

  /**
   * WATCHED RED by the same mutation above.
   *
   * ── A MUTATION THAT DID **NOT** GO RED, AND WHY IT IS RECORDED HERE ───────────────────────
   *
   * Deleting `if (policy.mode !== "windowed") return false;` outright leaves all 13 tests green,
   * so that line is NOT what this test proves. The reason is JavaScript rather than design: on a
   * `full` policy `policy.minRows` is `undefined`, `rows.length <= undefined` is false, and the
   * eviction loop starts at `i = undefined`, whose `<` comparison is false — so the body runs and
   * does nothing. The `full` branch is protected by the early return AND, redundantly, by
   * arithmetic on `undefined`, and only the first of those is intentional.
   *
   * The mutation that DOES go red is inverting it to `if (policy.mode === "windowed") return
   * false`, which takes 8 of the 13 with it. Stated plainly because a guard is worth exactly the
   * mutations it has been seen to catch, and this one does not catch that deletion.
   */
  it("keeps EVERY message under an EXPLICIT { mode: 'full' } — which is now the only way to ask", async () => {
    const store = await seeded(Array.from({ length: 600 }, (_, i) => msg(`m${i}`, daysAgo(400 + i))));
    await drainWith(store, { mode: "full" });

    expect(ids(store)).toHaveLength(600);
  });

  /**
   * The windowed policy on the SAME dataset. Not a guard of its own — it is what makes the two
   * above mean something: if `windowed` also kept everything, they would pass against an engine
   * with no prune pass at all.
   */
  it("… while a windowed policy over the same mirror does evict", async () => {
    const store = await seeded(Array.from({ length: 600 }, (_, i) => msg(`m${i}`, daysAgo(400 + i))));
    await drainWith(store, { mode: "windowed", days: 30, minRows: 500 });

    expect(ids(store)).toHaveLength(500);
  });

  /**
   * AND THE ENGINE SAYS WHICH IT IS. A list derived from the whole mirror — History — has no wire
   * partition to page and cannot state a count on a client that keeps part of the mailbox. What it
   * reads is the POLICY: true after a reload, where a latch is not, and true at a mailbox smaller
   * than the window, where "the mirror holds at least minRows" is not.
   *
   * WATCHED RED by `policy.mode === "windowed" ? null : {…}` (inverted): two failures, one per arm.
   */
  it("reports the window itself, and null wherever the mirror IS the mailbox", async () => {
    const store = new MemoryMirrorStore();
    await store.load();

    expect(engineOver(store).storeWindow(), "the absent branch is a window now")
      .toEqual({ days: 90, minRows: 5000 });
    expect(engineOver(store, { mode: "full" }).storeWindow()).toBeNull();
    expect(engineOver(store, { mode: "windowed", days: 90, minRows: 5000 }).storeWindow())
      .toEqual({ days: 90, minRows: 5000 });
  });
});

// ── THE WINDOW ITSELF ──────────────────────────────────────────────────────────────────────

describe("the window", () => {
  it("keeps the newest minRows unconditionally, however old they are", async () => {
    // Every row is a year old, so `days` alone would take the lot. `minRows` is the floor that
    // stops a quiet mailbox evicting itself down to an empty screen.
    const store = await seeded(Array.from({ length: 8 }, (_, i) => msg(`m${i}`, daysAgo(365 + i))));
    await drainWith(store, { mode: "windowed", days: 7, minRows: 5 });

    expect(ids(store)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  it("keeps everything inside `days` even when that is far more than minRows", async () => {
    // 12 rows, one per day; a 30-day window covers all of them, minRows is only 2.
    const store = await seeded(ladder());
    await drainWith(store, { mode: "windowed", days: 30, minRows: 2 });

    expect(ids(store)).toHaveLength(12);
  });

  it("evicts only what is BOTH beyond minRows AND older than days", async () => {
    // 12 rows at 0..11 days. days=5 ⇒ m0..m5 are inside the window; minRows=2 adds nothing new.
    //
    // The boundary is INCLUSIVE and that is deliberate: `m5` is exactly five days old, and "keep
    // five days of mail" that dropped the fifth day would be off by one in the direction that
    // loses data. The test names it rather than working around it.
    const store = await seeded(ladder());
    await drainWith(store, { mode: "windowed", days: 5, minRows: 2 });

    expect(ids(store)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5"]);
  });

  it("cascades the hydrated body with its message (no orphaned raw text)", async () => {
    const store = await seeded(ladder());
    // Two bodies: one on a message that will be evicted, one on a message that will be kept.
    await store.putLocal("message_body", "m11", { messageId: "m11", state: "ready", text: "quokkaledger old" });
    await store.putLocal("message_body", "m0", { messageId: "m0", state: "ready", text: "quokkaledger new" });

    await drainWith(store, { mode: "windowed", days: 5, minRows: 2 });

    expect(store.get("message_body", "m11")).toBeUndefined();
    expect(store.get("message_body", "m0")).toBeDefined();
    // And it is GONE, not tombstoned — nothing at that key at all.
    expect(store.record("message_body", "m11")).toBeUndefined();
  });

  it("never moves the cursor or maxSeq backwards", async () => {
    const store = await seeded(ladder());
    const cursorBefore = store.getCursor();
    const maxBefore = store.maxSeq();
    await drainWith(store, { mode: "windowed", days: 5, minRows: 2 });

    expect(store.maxSeq()).toBe(maxBefore);
    expect(store.getCursor()).not.toBe(cursorBefore); // the drain advanced it…
    expect(store.getCursor()).not.toBe("0"); // …and the prune did not reset it
  });
});

// ── THE CEILING ────────────────────────────────────────────────────────────────────────────

/**
 * `days` bounds the window by AGE. Without a ceiling beside the floor it does not bound it by
 * SIZE, so a mailbox whose mail is DENSE inside `days` sits almost entirely in a "windowed"
 * mirror — measured on the large corpus at several times the floor, which is a window
 * that tracks the mailbox rather than the policy.
 *
 * THE FIXTURE HAS HOLES ON PURPOSE. Every row below is inside `days`, and the day gaps are
 * irregular (0, 1, 3, 6, 10, 15 …), so "the newest N" and "inside the window" select different
 * sets and no off-by-one in either bound can pass for the other. A ladder one-per-day would let a
 * ceiling of 12 and a `days` of 12 agree by accident.
 */
function denseLadder(count = 40): EngineMessage[] {
  // Triangular gaps, capped so the whole run stays well inside a 400-day window: never evenly
  // spaced, never a round multiple of the floor or the ceiling.
  let day = 0;
  return Array.from({ length: count }, (_, i) => {
    const m = msg(`d${i}`, daysAgo(day));
    day += (i % 7) + 1;
    return m;
  });
}

describe("the ceiling", () => {
  /**
   * WATCHED RED by deleting `i < ceiling &&` from `pruneToPolicy` (40 kept where 12 is owed) and
   * by `const ceiling = policy.maxRows ?? 0` (5 kept — the floor alone — where 12 is owed).
   */
  it("keeps at most maxRows, even where days would keep every one of them", async () => {
    const rows = denseLadder();
    const store = await seeded(rows);
    // days=400 covers the whole run, so only the ceiling can decide anything here.
    await drainWith(store, { mode: "windowed", days: 400, minRows: 5, maxRows: 12 });

    expect(ids(store)).toEqual(rows.slice(0, 12).map((m) => m.id).sort());
  });

  /**
   * THE POSITIVE CONTROL FOR THE ORDINARY CASE: an embedder that set no ceiling gets the
   * pre-ceiling rule exactly. The absent branch is the one every shipped client had until now, and
   * a ceiling that defaulted to anything finite would silently truncate every one of them.
   *
   * WATCHED RED by `policy.maxRows ?? 12` (12 kept where 40 is owed).
   */
  it("keeps the pre-ceiling rule exactly when no ceiling is set", async () => {
    const store = await seeded(denseLadder());
    await drainWith(store, { mode: "windowed", days: 400, minRows: 5 });

    expect(ids(store)).toHaveLength(40);
  });

  /**
   * A CEILING UNDER THE FLOOR IS REFUSED AT CONSTRUCTION, not clamped. The eviction loop starts at
   * `minRows`, so such a policy would quietly read as "the floor won" and the window it NAMES
   * would never be the window it KEEPS — a wrong constant that survives a release. The three
   * shipped constants are checked by the guard below; this is what stops a fourth being written.
   *
   * WATCHED RED by deleting the constructor check (no throw) and by `maxRows <= minRows` (the
   * equal case throws, and the admitted arm below goes red instead).
   */
  it("refuses a policy whose ceiling is below its floor", () => {
    const store = new MemoryMirrorStore();
    expect(() => engineOver(store, { mode: "windowed", days: 400, minRows: 9, maxRows: 3 }))
      .toThrow(/maxRows \(3\) is below minRows \(9\)/);
    // THE ADMITTED CASE, so the refusal cannot pass by refusing everything: equal is a legal
    // window (the floor and the ceiling meet), and so is a ceiling above the floor.
    expect(() => engineOver(store, { mode: "windowed", days: 400, minRows: 9, maxRows: 9 })).not.toThrow();
    expect(() => engineOver(store, { mode: "windowed", days: 400, minRows: 9, maxRows: 10 })).not.toThrow();
    expect(() => engineOver(store, { mode: "windowed", days: 400, minRows: 9 })).not.toThrow();
  });

  /**
   * A PINNED ROW SURVIVES THE CEILING, exactly as it survives `days`. The ceiling evicts for being
   * numerous, and "numerous" is no better a reason to delete mail someone is still answering than
   * "old" is — so the ceiling is a bound on what the window keeps BY POLICY, not a hard cap on the
   * row count, and the comment on `DESKTOP_WINDOW` says so.
   *
   * WATCHED RED by moving `if (pinned.has(row.id)) continue;` above the ceiling test (d30 evicted).
   */
  it("keeps a pinned message that the ceiling would otherwise evict", async () => {
    const rows = denseLadder();
    const triage: MessageStateDTO = {
      messageId: "d30", state: "bubbled_up", bubbleUpAt: daysAgo(-3), setAt: daysAgo(9), updatedAt: daysAgo(9),
    };
    const store = await seeded(rows, [create("message_state", "d30", triage)]);
    await drainWith(store, { mode: "windowed", days: 400, minRows: 5, maxRows: 12 });

    expect(store.get("message", "d30")).toBeDefined();
    // d29 and d31 are the control: the same band, nothing pinning them, gone.
    expect(store.get("message", "d29")).toBeUndefined();
    expect(store.get("message", "d31")).toBeUndefined();
  });
});

// ── GUARD 2: THE PIN SET ───────────────────────────────────────────────────────────────────

describe("the pin set", () => {
  /**
   * All four references at once, each on a message deep outside the window.
   *
   * WATCHED RED four times, once per clause, by deleting that clause's loop from
   * `pinnedMessageIds()`:
   *   · drop the `draft` loop            → m11 evicted
   *   · drop the `message_state` loop    → m10 evicted
   *   · drop the `routing_decision` loop → m9  evicted
   *   · drop the `approval` loop         → m8  evicted
   * and once wholesale by deleting `if (pinned.has(row.id)) continue;` from `pruneToPolicy`,
   * which evicts all four.
   */
  it("pins a message referenced by a draft, a triage state, a pending decision, or a pending approval", async () => {
    const draft: EngineDraft = {
      id: "d1", mailboxId: "mb", threadId: null, inReplyToMessageId: "m11",
      subject: "Re: old", body: "", to: [], cc: [], bcc: [], rationale: null,
      status: "draft", createdAt: daysAgo(1), updatedAt: daysAgo(1),
    };
    const triage: MessageStateDTO = {
      messageId: "m10", state: "bubbled_up", bubbleUpAt: daysAgo(-3), setAt: daysAgo(9), updatedAt: daysAgo(9),
    };
    const store = await seeded(ladder(), [
      create("draft", "d1", draft),
      create("message_state", "m10", triage),
      create("routing_decision", "rd1", { id: "rd1", messageId: "m9", status: "pending_approval" }),
      create("approval", "ap1", { id: "ap1", messageId: "m8", status: "pending" }),
    ]);

    await drainWith(store, { mode: "windowed", days: 5, minRows: 2 });

    // m0..m5 are inside the window; m8..m11 survive only because something pins them.
    expect(ids(store)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m10", "m11", "m8", "m9"].sort());
    // m6 and m7 are the control: same age band as the pinned four, nothing referencing them, gone.
    expect(store.get("message", "m6")).toBeUndefined();
    expect(store.get("message", "m7")).toBeUndefined();
  });

  it("pins the message a draft FORWARDS, as it pins the one a draft answers", async () => {
    const forward: EngineDraft = {
      id: "d2", mailboxId: "mb", threadId: null, inReplyToMessageId: null, forwardOfMessageId: "m11",
      subject: "Fwd: old", body: "", to: [], cc: [], bcc: [], rationale: null,
      status: "draft", createdAt: daysAgo(1), updatedAt: daysAgo(1),
    };
    const store = await seeded(ladder(), [create("draft", "d2", forward)]);
    await drainWith(store, { mode: "windowed", days: 5, minRows: 2 });
    expect(store.get("message", "m11"), "a kept forward's original was evicted").toBeDefined();
    // m10 is the control: the same band, nothing pinning it, gone.
    expect(store.get("message", "m10")).toBeUndefined();
  });

  /**
   * REMOVE A PIN AND THE ROW GOES. This is the other half of the guard above: without it, a
   * `pinnedMessageIds()` that returned every id in the mirror would pass the first test.
   */
  it("evicts the same message once its pin is gone", async () => {
    const triage: MessageStateDTO = {
      messageId: "m10", state: "reply_later", bubbleUpAt: null, setAt: daysAgo(9), updatedAt: daysAgo(9),
    };
    const store = await seeded(ladder(), [create("message_state", "m10", triage)]);

    await drainWith(store, { mode: "windowed", days: 5, minRows: 2 });
    expect(store.get("message", "m10")).toBeDefined();

    // The user clears the pile: the state row goes back to `none`, which is the DEFAULT and
    // therefore not a pin.
    await store.applyChanges([
      { type: "message_state", op: "update", id: "m10", seq: ++seq, updatedAt: NOW.toISOString(),
        entity: { ...triage, state: "none" } },
    ]);
    await drainWith(store, { mode: "windowed", days: 5, minRows: 2 });

    expect(store.get("message", "m10")).toBeUndefined();
  });

  /**
   * ── A PIN THAT ARRIVES AFTER THE EVICTION ─────────────────────────────────────────────────
   *
   * The clauses above protect a row that is STILL THERE. A draft written on another device pins a
   * message this one evicted first, and a pin over a hole is not a repair: the mirror renders a
   * reply to mail it does not have, and the message's own change sits below this client's cursor,
   * so nothing later re-delivers it. `drafts-service.ts` did not emit the message beside the
   * draft; `packages/services/test/draft-pin-rematerialized.test.ts` is the writer, this is what
   * the wire has to carry for the mirror to come back whole.
   *
   * The first arm is the shape WITHOUT the paired emit and it is the control: it is what the
   * server produced until this change, and it is still what any writer that forgot would produce.
   */
  it("a draft alone cannot bring back the message it pins", async () => {
    const store = await seeded(ladder());
    await drainWith(store, { mode: "windowed", days: 5, minRows: 2 });
    expect(store.get("message", "m11"), "evicted first — nothing pinned it").toBeUndefined();

    const draft: EngineDraft = {
      id: "d1", mailboxId: "mb", threadId: null, inReplyToMessageId: "m11",
      subject: "Re: old", body: "", to: [], cc: [], bcc: [], rationale: null,
      status: "draft", createdAt: daysAgo(1), updatedAt: daysAgo(1),
    };
    await store.applyChanges([create("draft", "d1", draft)]);

    // The pin is now live and protects nothing. A later drain does not conjure the row either.
    await drainWith(store, { mode: "windowed", days: 5, minRows: 2 });
    expect(store.get("message", "m11")).toBeUndefined();
    expect(store.get("draft", "d1"), "the draft is there; the mail it answers is not").toBeDefined();
  });

  it("the message update the writer emits beside it re-materializes the row", async () => {
    const store = await seeded(ladder());
    await drainWith(store, { mode: "windowed", days: 5, minRows: 2 });
    expect(store.get("message", "m11")).toBeUndefined();

    const draft: EngineDraft = {
      id: "d1", mailboxId: "mb", threadId: null, inReplyToMessageId: "m11",
      subject: "Re: old", body: "", to: [], cc: [], bcc: [], rationale: null,
      status: "draft", createdAt: daysAgo(1), updatedAt: daysAgo(1),
    };
    // The pair, in the order the writer emits it: the mail first, then the row pointing at it.
    await store.applyChanges([update("message", "m11", msg("m11", daysAgo(11))), create("draft", "d1", draft)]);

    expect(store.get("message", "m11"), "the reply has its message back").toBeDefined();

    // AND IT STAYS. The re-materialized row is outside the window, so without the pin the very
    // next drain would evict it again and the repair would last exactly one pass.
    await drainWith(store, { mode: "windowed", days: 5, minRows: 2 });
    expect(store.get("message", "m11")).toBeDefined();
    // The control beside it: same age band, nothing pointing at it, still gone.
    expect(store.get("message", "m7")).toBeUndefined();
  });

  /**
   * ── THE PIN NOTHING IN THE MIRROR CAN EXPRESS ──────────────────────────────────────────────
   *
   * The four clauses above all read a ROW that points at a message. The message a reader has
   * OPEN is pointed at by nothing: reading is not a mutation, the Screener's preview is
   * deliberately side-effect-free, and a message merely opened has no draft, no triage state and
   * no pending question. So every clause above could be satisfied while the prune hard-deleted —
   * with its `message_body` cascade — the mail on screen, on the drain that follows.
   *
   * `hydrateBody` is the signal because it is what every reading surface already calls from an
   * effect keyed on the open id (`AppShell`'s selection and reader-sheet effects, the Screener's
   * selected sender, the Reads/Receipts/History cards). Here that call stands in for the shell's.
   */
  it("pins the message a surface has OPEN — the window may not evict what is being read", async () => {
    /**
     * WATCHED RED twice, once on each side of the mechanism:
     *   · delete `for (const id of this.renderedIds) pinned.add(id);` from `pinnedMessageIds()`
     *     — the READ. m9 is evicted while the reader is looking at it;
     *   · make `noteRendered` a no-op — the WRITE. Same eviction, and this is the half a
     *     refactor of `hydrateBody` would take without touching the prune at all.
     */
    const store = await seeded(ladder());
    const engine = engineOver(store, { mode: "windowed", days: 5, minRows: 2 });

    // The reader opens m9: deep outside the window, and nothing in the mirror references it.
    await engine.hydrateBody("m9");
    await engine.syncOnce();

    expect(store.get("message", "m9"), "the open message was pruned out from under the reader")
      .toBeDefined();
    // m8 is the control, and it is what stops this passing on a pin set that returns everything:
    // same age band, never opened, gone.
    expect(store.get("message", "m8")).toBeUndefined();
  });

  it("…and the hold is BOUNDED — it is what is on screen, not everything ever opened", async () => {
    /**
     * The other half. A hold that only ever grew would be a second retention policy quietly
     * competing with the window: open enough mail over a long session and the windowed store
     * stops evicting anything, which is the failure the `minRows`/`days` pair exists to bound.
     *
     * `RENDERED_PINS` is read from the engine rather than copied, because a guard that
     * hand-copies the number it is checking goes green against a shipped value it never saw.
     *
     * WATCHED RED by deleting the `while (this.renderedIds.size > RENDERED_PINS)` trim: the
     * first-opened message survives for ever.
     */
    const store = await seeded(ladder(RENDERED_PINS + 8));
    const engine = engineOver(store, { mode: "windowed", days: 5, minRows: 2 });

    const first = `m${RENDERED_PINS + 7}`; // the oldest row, opened first and long since closed
    await engine.hydrateBody(first);
    // Everything the reader looked at afterwards, which is more than the hold keeps.
    for (let i = 0; i < RENDERED_PINS; i++) await engine.hydrateBody(`m${i}`);
    await engine.syncOnce();

    expect(store.get("message", first)).toBeUndefined();
    // …while the most recent one it pushed out for IS still held. `m6` is beyond `minRows: 2`
    // and older than `days: 5`, so nothing but the hold is keeping it.
    expect(store.get("message", "m6")).toBeDefined();
  });

  it("does not pin on a RESOLVED decision or approval — history is what the window is for", async () => {
    const store = await seeded(ladder(), [
      create("routing_decision", "rd1", { id: "rd1", messageId: "m9", status: "auto_applied" }),
      create("approval", "ap1", { id: "ap1", messageId: "m8", status: "approved" }),
      create("approval", "ap2", { id: "ap2", messageId: "m7", status: "expired" }),
    ]);
    await drainWith(store, { mode: "windowed", days: 5, minRows: 2 });

    expect(store.get("message", "m9")).toBeUndefined();
    expect(store.get("message", "m8")).toBeUndefined();
    expect(store.get("message", "m7")).toBeUndefined();
  });

  /**
   * A TAGGED MESSAGE IS PINNED, and its untagged twin of the same age is the control.
   *
   * The server serves these on purpose: once the windowed walk has met both floors, `getSnapshot`
   * opens a LABELED TAIL carrying every message below the window that owns a tag, because an
   * evicted tagged row can never come back — its `message_tags` change sits below the client's
   * post-bootstrap cursor. Pruning them locally threw that tail away again, and a tag whose mail
   * was older than the window then listed a fraction of its messages under a count to match.
   *
   * WATCHED RED by deleting the `labels` loop from `pinnedMessageIds()`: m9 and m8 evicted.
   */
  it("pins a message that carries a tag — the labeled tail the snapshot went out of its way to send", async () => {
    const rows = ladder();
    const tagged = rows.map((m) => (m.id === "m9" || m.id === "m8" ? { ...m, labels: ["t1"] } : m));
    const store = await seeded(tagged);

    await drainWith(store, { mode: "windowed", days: 5, minRows: 2 });

    expect(store.get("message", "m9")).toBeDefined();
    expect(store.get("message", "m8")).toBeDefined();
    // The control: same age band, no tag, gone. An empty `labels` array is not a tag.
    expect(store.get("message", "m7")).toBeUndefined();
    expect(store.get("message", "m6")).toBeUndefined();
  });
});

// ── GUARD 3: RE-MATERIALIZATION ────────────────────────────────────────────────────────────

describe("a pruned message", () => {
  /**
   * THE REASON `prune` IS A HARD DELETE AND NOT A TOMBSTONE.
   *
   * WATCHED RED by changing `BaseMirrorStore.prune` to write a tombstone at the row's last seq
   * (`this.records.set(key, { ...rec, entity: null })`) instead of deleting it: the later delta
   * arrives with a LOWER seq than the tombstone, `applyToRecords`'s "never let an older-or-equal
   * seq overwrite" guard drops it, and the message stays invisible forever. The assertion fails
   * on `undefined`.
   */
  it("re-materializes from a later delta, because /sync changes carry full DTOs", async () => {
    const store = await seeded(ladder());
    await drainWith(store, { mode: "windowed", days: 5, minRows: 2 });
    expect(store.get("message", "m11")).toBeUndefined();

    // The user is mentioned in an old thread and the server sends an ordinary `update`. Note the
    // seq is BELOW the seq the row was originally created at — which is the case a tombstone
    // could not survive, and the case a hard delete does not care about.
    const revived = { ...msg("m11", daysAgo(11)), unread: true, subject: "Re: the old thread" };
    await store.applyChanges([
      { type: "message", op: "update", id: "m11", seq: 3, updatedAt: NOW.toISOString(), entity: revived },
    ]);

    expect(store.get<EngineMessage>("message", "m11")?.subject).toBe("Re: the old thread");
  });

  /**
   * WATCHED RED by deleting the `entities.delete(key)` loop from `IndexedDbMirrorStore.purge`
   * (leaving the in-memory map drop in place): the mirror looks pruned until the tab is reloaded,
   * and every evicted row comes back on `load()`.
   */
  it("stays gone across a reload — the delete is persisted, not only in memory", async () => {
    const factory = new IDBFactory();
    const a = new IndexedDbMirrorStore({ dbName: "window-a", factory });
    await a.load();
    await a.applyChanges(ladder().map((m) => create("message", m.id, m)));
    await a.putLocal("message_body", "m11", { messageId: "m11", state: "ready", text: "quokkaledger" });
    await a.prune([{ type: "message", id: "m11" }, { type: "message", id: "m10" }]);
    a.close();

    const b = new IndexedDbMirrorStore({ dbName: "window-a", factory });
    await b.load();
    expect(b.get("message", "m11")).toBeUndefined();
    expect(b.get("message", "m10")).toBeUndefined();
    expect(b.get("message_body", "m11")).toBeUndefined();
    expect(b.get("message", "m0")).toBeDefined();
    // The cursor is untouched by a prune — see MirrorStore.prune.
    expect(b.getCursor()).toBe("0");
    b.close();
  });
});
