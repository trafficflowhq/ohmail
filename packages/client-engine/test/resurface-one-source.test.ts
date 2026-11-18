import type { EngineMessage, MessageStateDTO, MutationOutcome } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  ohboxView,
  parkedMessageIds,
  triagePiles,
  winningStates,
  type EngineAdapter,
  type EntityReader,
  type StorePolicy,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * ═══ "THIS MESSAGE COMES BACK LATER" HAS ONE SOURCE ════════════════════════════════════════
 *
 * The fact was carried TWICE on the wire — embedded on the message (`MessageDTO.triage`, which
 * `TriageService.setState` re-emits for exactly this reason) and as its own `message_state`
 * entity — and the two had SEPARATE readers: the chip read the copy on the message, while the
 * Ohbox's hold-out and the bottom piles read the records. A client that receives one home and
 * not the other therefore disagreed with itself: the desktop stood a parked message in the main
 * list wearing its "Back <day>" chip while the web had it under Triage.
 *
 * Both halves are reachable. The snapshot is windowed on the message's ARRIVAL date, so a
 * parked message older than the window is in neither the window nor the tagged tail; a later
 * `message` update then delivers the row with its `triage` embedded while the original park's
 * `message_state` change sits below the cursor the client adopted at bootstrap — the message
 * without its record. The reverse (a record for a message the mirror does not hold) titles a
 * pile entry with a raw identifier.
 *
 * The fix is ONE CARRIER read through ONE selector: `winningStates` folds both wire homes into
 * a single claim per message, and `oneSourceReader` — applied at `OhmailEngine.read()`, so no
 * surface can forget it — stamps that claim onto the message's own `triage`. The record stops
 * being a second read source and becomes a pure input to the fold.
 */

const NOW = new Date("2026-08-07T12:00:00.000Z");
const DAY = 86_400_000;
const BACK_ON = "2026-11-20T09:00:00.000Z"; // beyond any 90-day window over NOW

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * DAY).toISOString();
}

let seq = 0;

function msg(id: string, date: string, triage: MessageStateDTO | null = null): EngineMessage {
  return {
    id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name: "Anna", address: "anna@example.test" },
    to: [],
    cc: [],
    date,
    folder: "INBOX",
    snippet: "snippet",
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage,
    labels: [],
    remoteContent: "none",
    updatedAt: date,
  };
}

/** The park as the server materializes it — the SAME object both wire homes carry. */
function parkedState(messageId: string, updatedAt: string, bubbleUpAt = BACK_ON): MessageStateDTO {
  return { messageId, state: "bubbled_up", bubbleUpAt, setAt: updatedAt, updatedAt };
}

function create(type: string, id: string, entity: unknown): SyncChange {
  return { type, op: "create", id, seq: ++seq, updatedAt: NOW.toISOString(), entity };
}

function adapterOf(): EngineAdapter {
  return {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: String(seq),
      hasMore: false,
      serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
  } as unknown as EngineAdapter;
}

async function mirror(changes: SyncChange[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(changes);
  return store;
}

/** The reader every surface actually consumes — `engine.read()`, never the raw store. */
function readerOf(store: MemoryMirrorStore, storePolicy?: StorePolicy): EntityReader {
  return new OhmailEngine({
    adapter: adapterOf(), store, now: () => NOW, ...(storePolicy ? { storePolicy } : {}),
  }).read();
}

/** Where the message stands as the LIST decides it: in the Ohbox, or held out into a pile. */
function placement(reader: EntityReader, id: string): { inList: boolean; inPile: boolean } {
  const box = ohboxView(reader);
  const inList = [...box.newForYou, ...box.previouslySeen, ...box.resurfaced].some((m) => m.id === id);
  const inPile = triagePiles(reader).resurface.some((e) => e.messageId === id);
  return { inList, inPile };
}

/** The chip's own source: the horizon carried on the row the surface renders. */
function chipHorizon(reader: EntityReader, id: string): string | undefined {
  const m = reader.get<EngineMessage>("message", id);
  return m?.triage?.state === "bubbled_up" ? m.triage.bubbleUpAt ?? undefined : undefined;
}

describe("the projecting reader's own stamp", () => {
  /**
   * THE CROSS-LANE HAZARD, AS A CASE. `oneSourceReader` folds `message_state` into a message's
   * `triage`, and the per-type stamps arrived while it was in flight. A stamp that named only
   * `message` would let a window hold a projection built before a park the mirror already has —
   * the stale screen the deny list exists to prevent, reached from the other side.
   */
  it("moves the MESSAGE stamp when a message_state lands, and leaves other types alone", async () => {
    const store = await mirror([create("message", "m1", msg("m1", daysAgo(1)))]);
    const reader = readerOf(store);
    const before = reader.stampOf("message");
    const otherBefore = reader.stampOf("rule");

    await store.applyChanges([create("message_state", "s1", parkedState("m1", daysAgo(0)))]);
    const after = readerOf(store);
    // THE CLAIM: the projected message moved, because what it renders did.
    expect(after.stampOf("message")).toBeGreaterThan(before);
    // …and nothing else was dragged along by it.
    expect(after.stampOf("rule")).toBe(otherBefore);
  });

  it("keeps message_state out of an ignore set while messages are still read, and honours it otherwise", async () => {
    const store = await mirror([create("message", "m1", msg("m1", daysAgo(1)))]);
    const base = readerOf(store).stampExcept(["message_state"]);
    await store.applyChanges([create("message_state", "s1", parkedState("m1", daysAgo(0)))]);
    const reader = readerOf(store);
    // Ignoring the record while still reading the row it projects into cannot hide the write.
    expect(reader.stampExcept(["message_state"])).toBeGreaterThan(base);
    // A caller that reads no messages at all reads no projection, so its deny list stands.
    expect(reader.stampExcept(["message", "message_state"]))
      .toBe(reader.stampExcept(["message", "message_state"]));
  });
});

describe("the park fact has one carrier and one reader", () => {
  /**
   * THE REPRODUCED SPLIT. Two mirrors of ONE account, each holding a different half of the same
   * park. Pre-fix: D stood the message in the list wearing its chip (no record to hold it out)
   * while W held it out into the pile — the reported divergence, from one park.
   */
  it("two mirrors holding different halves of one park place the message the same way", async () => {
    const parked = parkedState("m-old", daysAgo(120));
    // The DESKTOP's half: the message carrying the fact, its record never delivered.
    const desktop = readerOf(await mirror([create("message", "m-old", msg("m-old", daysAgo(120), parked))]));
    // The WEB's half: the record delivered beside the message, which is the whole mailbox's shape.
    const web = readerOf(await mirror([
      create("message", "m-old", msg("m-old", daysAgo(120), parked)),
      create("message_state", "state-row:m-old", parked),
    ]));

    expect(placement(desktop, "m-old"), "the desktop mirror disagrees with the web mirror")
      .toEqual(placement(web, "m-old"));
    // And the agreed answer is the product's: parked mail is in its pile, never in the list.
    expect(placement(desktop, "m-old")).toEqual({ inList: false, inPile: true });
    // The chip says the same day on both, because it reads the same carrier.
    expect(chipHorizon(desktop, "m-old")).toBe(BACK_ON);
    expect(chipHorizon(web, "m-old")).toBe(BACK_ON);
  });

  /**
   * THE CHIP AND THE PLACEMENT ARE ONE FACT, whichever home is newer. A re-park from another
   * device arrives as a record while the message's embedded copy still names the FIRST horizon;
   * pre-fix the chip read that stale day while the pile read the new one.
   */
  it("the chip reads the winning claim, not whichever home the row happens to carry", async () => {
    const first = parkedState("m1", daysAgo(9), "2026-09-01T09:00:00.000Z");
    const rebooked = parkedState("m1", daysAgo(1), BACK_ON);
    const reader = readerOf(await mirror([
      create("message", "m1", msg("m1", daysAgo(30), first)),
      create("message_state", "state-row:m1", rebooked),
    ]));

    expect(chipHorizon(reader, "m1"), "the chip rendered a horizon the pile had already replaced")
      .toBe(BACK_ON);
    expect(triagePiles(reader).resurface.find((e) => e.messageId === "m1")?.resurfaceAt).toBe(BACK_ON);
    // One fold, one answer — `winningStates` is what both read.
    expect(winningStates(reader).get("m1")?.bubbleUpAt).toBe(BACK_ON);
  });

  /** The hold-out set is the fold's, so a message carrying the fact alone is never listed. */
  it("holds out a message whose record never arrived", async () => {
    const reader = readerOf(await mirror([
      create("message", "m2", msg("m2", daysAgo(200), parkedState("m2", daysAgo(200)))),
    ]));
    expect([...parkedMessageIds(reader)]).toEqual(["m2"]);
  });

  /**
   * A PARK BEYOND THE WINDOW SURVIVES THE WINDOWED PRUNE. The eviction pin used to read the
   * records only, so a desktop holding the fact on the message alone evicted the parked mail —
   * the reminder deleted by the cache it was stored in.
   */
  it("a windowed mirror does not evict a message parked on its own row", async () => {
    const store = await mirror([
      create("message", "keep", msg("keep", daysAgo(200), parkedState("keep", daysAgo(200)))),
      ...Array.from({ length: 6 }, (_, i) => create("message", `n${String(i)}`, msg(`n${String(i)}`, daysAgo(i)))),
    ]);
    const engine = new OhmailEngine({
      adapter: adapterOf(), store, now: () => NOW,
      storePolicy: { mode: "windowed", days: 30, minRows: 2 },
    });
    await engine.syncOnce();
    expect(store.entries<EngineMessage>("message").map((e) => e.id)).toContain("keep");
  });
});
