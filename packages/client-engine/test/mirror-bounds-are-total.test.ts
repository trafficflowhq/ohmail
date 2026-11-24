import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  BODY_CACHE_MAX,
  HISTORY_PAGE_CACHE_ROWS,
  HISTORY_PAGE_ROWS,
  CASCADE_TYPES,
  MIRROR_BOUNDS,
  MIRROR_ENTITY_TYPES,
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type KnownMirrorEntityType,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * NO ENTITY CLASS IN THE MIRROR IS UNBOUNDED BY CONSTRUCTION.
 *
 * `pruneToPolicy` reached `message` and cascaded to `message_body`; every other type was outside
 * it — tags, threads, an evicted message's child state, and `draft`, which held the text of every
 * reply the person had ever sent, so the advertised window did not bound total retention.
 * `MIRROR_BOUNDS` is total by TYPE — a missing key fails `tsc -b` here. These cases are the other
 * half: the table's claims are DRIVEN through a real engine over a real drain, because a table
 * that describes the code is a claim, not a measurement.
 */

const NOW = new Date("2026-09-14T12:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * DAY).toISOString();

let seq = 0;
function create(type: string, id: string, entity: unknown): SyncChange {
  return { type, op: "create", id, seq: ++seq, updatedAt: NOW.toISOString(), entity };
}

function msg(id: string, date: string, over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "sender@example.test" },
    to: [], cc: [], date, folder: "INBOX", snippet: "s", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date, ...over,
  };
}

function adapterOf(): EngineAdapter {
  return {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: String(seq), hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
  } as unknown as EngineAdapter;
}

/** Seed a mirror, then drain once through a windowed engine so the prune pass really runs. */
async function prunedMirror(rows: SyncChange[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(rows);
  const engine = new OhmailEngine({
    adapter: adapterOf(), store, now: () => NOW,
    storePolicy: { mode: "windowed", days: 30, minRows: 2, maxRows: 4 },
  });
  await engine.syncOnce();
  return store;
}

const idsOf = (store: MemoryMirrorStore, type: string): string[] =>
  store.entries(type).map((e) => e.id).sort();

/**
 * THE TYPES THE FIXTURE BELOW WRITES, spelled out INDEPENDENTLY of {@link MIRROR_ENTITY_TYPES}.
 * This is the list the sweep walks, so the sweep can see a type the table is missing. The two
 * outbox types and the demo world's two are named here as well: they are written by paths this
 * file does not drive, and leaving them out of the census's own vocabulary would be the same
 * blindness one level up.
 */
const WRITTEN_TYPES = [
  "message", "thread", "draft", "rule", "tag", "folder", "approval", "routing_decision",
  "message_state", "mailbox", "message_body", "view_meta", "held_release_group",
  "screener_suggestion", "screener_waiting",
] as const;

// ── TOTALITY ───────────────────────────────────────────────────────────────────────────────

describe("the table answers for every type", () => {
  /**
   * The `Record` gives this at compile time; asserted at RUNTIME too because the build is not a
   * gate every consumer runs, and because an empty table would satisfy a `Record` over an empty
   * list. The count is pinned so a type SILENTLY LEAVING the list is also a failure.
   */
  it("holds one bound per known type, and the list is not empty", () => {
    // 17 → 18: `screener_suggestion` joined the wire (owner decision 2026-09-18), cascade-bound.
    // 18 → 19: `unscreened_sender_group` — client-local and REPLACED, the held-release
    // derivation's shape one predicate over.
    // 19 → 20: `store_page` (ARCHIVE-024) — History's store pages, in memory, ceiling-bound.
    // 20 → 21: `mailbox_profile` — a read mailbox's organizer rules, one row per read mailbox.
    // 21 → 22: `screener_waiting` — the store's Screener queue page, client-local and REPLACED.
    // 22 → 26: the calendar's four kinds — a connection and a calendar bounded by the person, an
    // event by the span around today, a suggestion cascaded with its letter.
    expect(MIRROR_ENTITY_TYPES.length).toBe(26);
    expect(new Set(MIRROR_ENTITY_TYPES).size).toBe(MIRROR_ENTITY_TYPES.length);
    for (const t of MIRROR_ENTITY_TYPES) {
      expect(MIRROR_BOUNDS[t], `${t} has a bound`).toBeDefined();
      expect(MIRROR_BOUNDS[t].why.length, `${t}: the reason is a sentence`).toBeGreaterThan(40);
    }
    expect(Object.keys(MIRROR_BOUNDS).sort()).toEqual([...MIRROR_ENTITY_TYPES].sort());
  });

  /**
   * AND THE LIST COVERS WHAT THE ENGINE ACTUALLY WRITES. The type-level half cannot see a type
   * that only exists as a string literal at a `putLocal` call, so the types a driven engine puts
   * in the store are read back and checked against the list — the direction that catches a type
   * added to the code and not to the table.
   *
   * WATCHED RED by removing `"message_body"` from `MIRROR_ENTITY_TYPES`: `message_body` is
   * reported as a type the mirror holds with no bound.
   */
  it("every type a driven engine writes is on the list", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([
      create("message", "m1", msg("m1", daysAgo(1))),
      create("thread", "t1", { id: "t1" }),
      create("draft", "d1", { id: "d1", status: "draft", body: "x" }),
      create("rule", "r1", { id: "r1" }),
      create("tag", "g1", { id: "g1", name: "n", hue: "h" }),
      create("folder", "f1", { id: "f1" }),
      create("approval", "a1", { id: "a1", messageId: "m1", status: "pending" }),
      create("routing_decision", "rd1", { id: "rd1", messageId: "m1", status: "pending_approval" }),
      create("message_state", "ms1", { messageId: "m1", state: "none", updatedAt: NOW.toISOString() }),
      create("mailbox", "mb", { id: "mb" }),
      create("screener_suggestion", "sg1", {
        id: "sg1", messageId: "m1", senderKey: "sender@example.test",
        decision: "yes", destination: "INBOX", spam: false, confidence: 0.8,
        boughtAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      }),
    ]);
    await store.putLocal("message_body", "m1", { state: "ready", text: "t" });
    await store.putLocal("view_meta", "reads_waterline", { newestSeenId: "m1" });
    await store.putLocal("held_release_group", "r1", { id: "r1", count: 1, total: 1 });
    // Written by the engine's own door, never by hand, so the sweep reads what it really writes.
    await waitingEngine(store, [queueItem("q1")]).refreshScreenerWaiting();

    /**
     * THE TYPES ARE READ FROM WHAT WAS WRITTEN, never from the list under test. A sweep that
     * iterates `MIRROR_ENTITY_TYPES` and asks the store about each one cannot see a type the
     * list is missing — it would look only where the answer is already yes, which is a census
     * that covered nothing while reporting green.
     */
    const written = new Set<string>(WRITTEN_TYPES);
    const held = [...written].filter((t) => store.entries(t).length > 0);
    expect(held.length, "the fixture writes something to measure").toBe(written.size);

    const known = new Set<string>(MIRROR_ENTITY_TYPES);
    expect(held.filter((t) => !known.has(t)), "a type the mirror holds with no bound").toEqual([]);
  });

  /** The arms that claim a MECHANISM are the ones driven below; the list is derived, not typed. */
  it("names which types the prune pass cascades to", () => {
    expect(CASCADE_TYPES.map((c) => c.type).sort())
      .toEqual(["approval", "calendar_suggestion", "message_state", "routing_decision", "screener_suggestion", "thread"]);
  });
});

// ── THE SPAN, DRIVEN ───────────────────────────────────────────────────────────────────────

describe("a calendar event is held while it can touch the span around today", () => {
  const event = (id: string, startDays: number, endDays: number | null, over: Record<string, unknown> = {}) =>
    create("calendar_event", id, {
      id, calendarId: "cal", startsAt: daysAgo(-startDays), endsAt: endDays === null ? null : daysAgo(-endDays),
      occurrenceAt: null, thisAndFuture: false, ...over,
    });

  /**
   * Driven through a real engine's prune pass, in the store mode that keeps all mail: the span is
   * the calendar's own bound, not the mail window's. WATCHED RED by dropping the span pass from
   * `pruneToPolicy`: the two far events stay.
   */
  it("keeps what meets the span, a series that never ends, and a moved occurrence's replacement; lets the far ones go", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([
      // The switch on: a mirror that holds the calendar holds the record that says so, or lets it go.
      create("settings", "acct", { accountId: "acct", calendarEnabledAt: NOW.toISOString() }),
      event("today", 0, 0.05),
      event("next-year", 700, 700.1),
      event("too-far", 800, 800.1),
      event("long-ago", -400, -399.9),
      event("endless-series", -900, null, { repeat: { rules: ["FREQ=WEEKLY"], excluded: [], added: [] } }),
      // Starts far ahead, but replaces an occurrence inside the span: it must stay to hide it.
      event("moved-out", 900, 900.1, { recurrenceId: "1", occurrenceAt: daysAgo(-3) }),
    ]);
    const engine = new OhmailEngine({ adapter: adapterOf(), store, now: () => NOW, storePolicy: { mode: "full" } as never });
    await engine.syncOnce();
    expect(idsOf(store, "calendar_event")).toEqual(["endless-series", "moved-out", "next-year", "today"]);
  });

  /** A second net under the server's own deletions: WATCHED RED with the store's calendar cascade taken out. */
  it("a connection's delete takes its calendars and their events, a calendar's its events, and nothing else", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([
      create("calendar_connection", "c1", { id: "c1" }), create("calendar_connection", "c2", { id: "c2" }),
      create("calendar", "k1", { id: "k1", connectionId: "c1" }), create("calendar", "k2", { id: "k2", connectionId: "c2" }),
      create("calendar", "k3", { id: "k3", connectionId: "c2" }),
      event("e1", 0, 0.1, { calendarId: "k1" }), event("e2", 0, 0.1, { calendarId: "k2" }), event("e3", 0, 0.1, { calendarId: "k3" }),
    ]);
    await store.applyChanges([
      { type: "calendar_connection", op: "delete", id: "c1", seq: 100, updatedAt: NOW.toISOString() },
      { type: "calendar", op: "delete", id: "k3", seq: 101, updatedAt: NOW.toISOString() },
    ]);
    const live = (type: string) => store.entries(type).filter((r) => r.entity !== null).map((r) => r.id).sort();
    expect(live("calendar")).toEqual(["k2"]);
    expect(live("calendar_event")).toEqual(["e2"]);
    expect(live("calendar_connection")).toEqual(["c2"]);
  });
});

// ── THE CASCADE, DRIVEN ────────────────────────────────────────────────────────────────────

describe("evicting a message takes the rows that named it", () => {
  /**
   * The fixture: six messages a year old against a floor of two, so four are evicted. Each has a
   * thread, a resting park and a settled decision and approval — the rows that cannot pin,
   * because a live one would keep its message and never reach the cascade at all.
   *
   * WATCHED RED by deleting the `victims.push(...this.cascadeVictims(...))` line: six threads,
   * six parks, six decisions and six approvals survive where two of each are owed.
   */
  async function sixWithChildren(): Promise<MemoryMirrorStore> {
    const rows: SyncChange[] = [];
    for (let i = 0; i < 6; i++) {
      rows.push(create("message", `m${i}`, msg(`m${i}`, daysAgo(365 + i), { threadId: `t${i}` })));
      rows.push(create("thread", `t${i}`, { id: `t${i}`, subject: `T${i}` }));
      rows.push(create("message_state", `ms${i}`,
        { messageId: `m${i}`, state: "none", updatedAt: NOW.toISOString() }));
      rows.push(create("routing_decision", `rd${i}`,
        { id: `rd${i}`, messageId: `m${i}`, status: "approved" }));
      rows.push(create("approval", `a${i}`, { id: `a${i}`, messageId: `m${i}`, status: "approved" }));
      rows.push(create("screener_suggestion", `sg${i}`, {
        id: `sg${i}`, messageId: `m${i}`, senderKey: "sender@example.test",
        decision: "yes", destination: "INBOX", spam: false, confidence: 0.5,
        boughtAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      }));
    }
    // A SECOND PAGE so nothing is inside the one-page grace: the grace holds back rows above the
    // previous page's high-water, and without this the whole fixture would be exempt.
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges(rows);
    const engine = new OhmailEngine({
      adapter: adapterOf(), store, now: () => NOW,
      storePolicy: { mode: "windowed", days: 30, minRows: 2, maxRows: 2 },
    });
    await engine.syncOnce();
    return store;
  }

  it("evicts the thread, the park, the decision and the approval of an evicted message", async () => {
    const store = await sixWithChildren();
    expect(idsOf(store, "message")).toEqual(["m0", "m1"]);
    expect(idsOf(store, "thread")).toEqual(["t0", "t1"]);
    expect(idsOf(store, "message_state")).toEqual(["ms0", "ms1"]);
    expect(idsOf(store, "routing_decision")).toEqual(["rd0", "rd1"]);
    expect(idsOf(store, "approval")).toEqual(["a0", "a1"]);
    expect(idsOf(store, "screener_suggestion"), "advice goes with the message it was bought about")
      .toEqual(["sg0", "sg1"]);
  });

  /**
   * THE POSITIVE CONTROL FOR THE CASCADE: a thread one surviving message still names is KEPT,
   * even while every other message on it goes. Without this the assertion above passes for a
   * cascade that simply deletes every thread it sees.
   */
  it("keeps a thread a surviving message still names", async () => {
    const rows: SyncChange[] = [create("thread", "shared", { id: "shared" })];
    // The newest message and the oldest share one thread; the floor keeps the newest.
    rows.push(create("message", "new", msg("new", daysAgo(1), { threadId: "shared" })));
    for (let i = 0; i < 5; i++) {
      rows.push(create("message", `old${i}`, msg(`old${i}`, daysAgo(365 + i), { threadId: "shared" })));
    }
    const store = await prunedMirror(rows);

    expect(store.entries("message").length).toBe(2);
    expect(idsOf(store, "thread"), "one survivor still names it").toEqual(["shared"]);
  });

  /**
   * AND AN APPROVAL WITH NO MESSAGE IS NEVER CASCADED. It is page-1 live state — the bootstrap
   * reader emits it deliberately because it has no page to ride with — and a cascade written as
   * "evict what does not name a survivor" would take it on the first prune of any mailbox.
   *
   * WATCHED RED by `if (!evicted.has(named ?? ""))`-style inversions; here by dropping the
   * `typeof named === "string"` test, which reads `undefined` as an evicted message.
   */
  it("never takes an approval that names no message", async () => {
    const rows: SyncChange[] = [create("approval", "orphan", { id: "orphan", messageId: null, status: "pending" })];
    for (let i = 0; i < 6; i++) rows.push(create("message", `m${i}`, msg(`m${i}`, daysAgo(365 + i))));
    const store = await prunedMirror(rows);

    expect(store.entries("message").length).toBe(2);
    expect(idsOf(store, "approval")).toEqual(["orphan"]);
  });

  /**
   * A LIVE CHILD KEEPS ITS PARENT, so it is never in the cascade's reach. This is the property
   * that makes the cascade safe to write as "resting rows only" — proven rather than assumed,
   * because if the pin ever stopped working the cascade would be deleting a person's reminders.
   */
  it("a parked message and its park both survive, however old", async () => {
    const rows: SyncChange[] = [];
    for (let i = 0; i < 6; i++) rows.push(create("message", `m${i}`, msg(`m${i}`, daysAgo(365 + i))));
    rows.push(create("message_state", "park",
      { messageId: "m5", state: "bubbled_up", updatedAt: NOW.toISOString() }));
    const store = await prunedMirror(rows);

    expect(idsOf(store, "message")).toContain("m5");
    expect(idsOf(store, "message_state")).toEqual(["park"]);
  });
});

// ── THE NON-MECHANICAL ARMS ────────────────────────────────────────────────────────────────

function queueItem(id: string) {
  return { messageId: id, address: `${id}@example.test`, name: null, receivedAt: daysAgo(1), subject: "s", snippet: "s", mailboxId: "mb" };
}

/** An engine whose door answers `GET /screener` with `items`, a page at a time. */
function waitingEngine(store: MemoryMirrorStore, items: ReturnType<typeof queueItem>[], answers?: { items: typeof items }) {
  const adapter = {
    ...adapterOf(),
    screenerWaiting: async (page?: { cursor?: string }) => {
      const rows = answers?.items ?? items;
      return page?.cursor
        ? { items: [queueItem("onward")], nextCursor: null, total: null, inFlight: [] }
        : { items: rows, nextCursor: "next", total: rows.length + 1, inFlight: [] };
    },
  } as unknown as EngineAdapter;
  return new OhmailEngine({ adapter, store, now: () => NOW });
}

describe("a replaced type holds one answer, never an accumulation", () => {
  /**
   * `screener_waiting` claims `replaced`: every refresh writes the whole page and prunes the
   * complement, and the pages onward are never written. Driven: two answers with different
   * senders leave the second alone, and a walk onward adds nothing to the mirror.
   * WATCHED RED by dropping the complement delete in `refreshScreenerWaiting` (five rows held).
   */
  it("screener_waiting is replaced by each refresh and never grows with the pages onward", async () => {
    expect(MIRROR_BOUNDS.screener_waiting).toMatchObject({ by: "replaced", via: "OhmailEngine.refreshScreenerWaiting" });
    const store = new MemoryMirrorStore();
    await store.load();
    const answers = { items: [queueItem("a"), queueItem("b"), queueItem("c")] };
    const engine = waitingEngine(store, [], answers);
    await engine.refreshScreenerWaiting();
    answers.items = [queueItem("d")];
    await engine.refreshScreenerWaiting();
    expect(idsOf(store, "screener_waiting")).toEqual(["page", "sender:d@example.test"]);
    await engine.screenerWaitingPage("next");
    expect(idsOf(store, "screener_waiting")).toEqual(["page", "sender:d@example.test"]);
  });
});

describe("a type with no mechanism says what its size is a function of", () => {
  /**
   * `person` is the arm that could hide "nobody thought about it", so it is the one with a
   * PINNED membership: adding a type to it is a decision that shows up in a diff beside this
   * list, and the reason has to be written where a reviewer reads it.
   */
  it("pins which types are bounded by a reason rather than by a pass", () => {
    const stated = MIRROR_ENTITY_TYPES
      .filter((t) => MIRROR_BOUNDS[t].by === "person").sort();
    expect(stated).toEqual([
      "calendar", "calendar_connection",
      "draft", "folder", "mailbox", "mailbox_profile", "outbox_abandoned", "outbox_entry",
      "rule", "screener_sender", "tag", "triage_item",
    ]);
    for (const t of stated) {
      const b = MIRROR_BOUNDS[t] as { growsWith: string };
      expect(b.growsWith.length, `${t}: names what it grows with`).toBeGreaterThan(8);
    }
  });

  /** The ceilings name constants this package really has, read rather than described. */
  it("the ceilings are numbers, not adjectives", () => {
    expect(MIRROR_BOUNDS.message_body).toMatchObject({ by: "ceiling", at: "BODY_CACHE_MAX" });
    expect(Number.isFinite(BODY_CACHE_MAX)).toBe(true);
    expect(BODY_CACHE_MAX).toBeGreaterThan(0);
    expect(MIRROR_BOUNDS.view_meta).toMatchObject({ by: "ceiling" });
    expect(MIRROR_BOUNDS.store_page).toMatchObject({ by: "ceiling", at: "HISTORY_PAGE_CACHE_ROWS" });
    expect(HISTORY_PAGE_CACHE_ROWS).toBe(3 * HISTORY_PAGE_ROWS);
  });

  /**
   * THE STORE-PAGE CEILING, DRIVEN: History walked page by page to the first message holds at
   * most the ceiling in memory at every step, and writes nothing into the mirror.
   */
  it("store_page is bounded by its ceiling while History walks the whole store", async () => {
    const rows = Array.from({ length: 500 }, (_, i) =>
      msg(`00000000-0000-4000-8000-${(0xfffff - i).toString(16).padStart(12, "0")}`, daysAgo(i)));
    const adapter = {
      ...adapterOf(),
      listMessages: async (_view: string, opts: { startBelow?: { date: string | null; id: string }; limit?: number }) => {
        const b = opts.startBelow;
        const rest = b ? rows.filter((m) => m.date! < b.date! || (m.date === b.date && m.id < b.id)) : rows;
        return { items: rest.slice(0, opts.limit ?? 50), nextCursor: null };
      },
    } as unknown as EngineAdapter;
    const store = new MemoryMirrorStore();
    await store.load();
    const engine = new OhmailEngine({ adapter, store, now: () => NOW });
    let at: { date: string | null; id: string } | undefined;
    let peak = 0;
    for (let p = 0; p < 10; p++) {
      const out = await engine.pageStore("all", at ? { before: at } : {});
      if (out.state !== "ready") throw new Error(out.state);
      const last = out.items[out.items.length - 1]!;
      at = { date: last.date, id: last.id };
      peak = Math.max(peak, engine.storePageCacheRows());
    }
    expect(at?.id).toBe(rows[499]!.id);
    expect(peak).toBe(HISTORY_PAGE_CACHE_ROWS);
    expect(store.entries("message").length).toBe(0);
  });

  /**
   * THE ONE EVERY OTHER ARM EXISTS BECAUSE OF: `draft` is bounded in BYTES rather than in rows,
   * and that claim is driven here too rather than only in its own file — a table whose most
   * expensive row is the one nobody re-measured is the table this lane replaces.
   */
  it("draft is bounded in bytes: a sent row in the mirror carries no text", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([
      create("draft", "sent1", { id: "sent1", status: "sent", body: null, html: null, bodyOmitted: "sent" }),
    ]);
    const held = store.get<{ body: string | null }>("draft", "sent1")!;
    expect(held.body).toBeNull();
    expect((MIRROR_BOUNDS.draft as { growsWith: string }).growsWith).toContain("written");
  });
});
