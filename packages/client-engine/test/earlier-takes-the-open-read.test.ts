import { describe, expect, it } from "vitest";
import { getFixtures, type MessageFixture } from "@ohmail/fixtures";
import {
  DEMO_NOW,
  FixturesAdapter,
  MemoryMirrorStore,
  inverseMutations,
  OhmailEngine,
  mutationEffects,
  ohboxView,
  type EngineAdapter,
  type EngineMessage,
  type EngineMutation,
  type SyncChange,
} from "@ohmail/client-engine";
import { OPEN_READ_SHAPES, type OpenReadRow } from "./fixtures/open-read-shapes.js";
import { earlierPlaceComparisons, placeEarlier } from "../src/selectors.js";
import { openReadFloorScanCount } from "../src/mutations.js";

/**
 * A MESSAGE YOU OPEN AND READ IN OHMAIL GOES TO THE TOP OF EARLIER WHEN YOU MOVE ON (owner,
 * 2026-10-07: "I read this email and it did not get sorted in after Earlier but way lower"), narrowing
 * the 2026-09-18 arrival-order ruling. Only an OPEN READ moves a row — a read taken while its
 * conversation is the held row (`holdOpenRow`); every other read keeps arrival. Driven through a real
 * `OhmailEngine` over a `FixturesAdapter` whose rows carry `sortAt` and `threadId` (stamped by the
 * wrapper below, on every page and every echo, so a drain never un-threads or re-dates a row).
 */

type Row = OpenReadRow & { folder?: "INBOX" | "Sent" };

/** Owner's shape: read rows arrived Sat/Sun/Mon/Tue before DEMO_NOW (Wed); F unread, arrived Fri 00:15. */
const OWNER_ROWS: Row[] = [
  { label: "tue", thread: "TUE", arrived: "2026-07-28T09:00:00.000Z", unread: false },
  { label: "mon", thread: "MON", arrived: "2026-07-27T09:00:00.000Z", unread: false },
  { label: "sun", thread: "SUN", arrived: "2026-07-26T09:00:00.000Z", unread: false },
  { label: "sat", thread: "SAT", arrived: "2026-07-25T09:00:00.000Z", unread: false },
  { label: "fri", thread: "FRI", arrived: "2026-07-24T00:15:00.000Z", unread: true },
];
const ARRIVAL = ["tue", "mon", "sun", "sat"];

function fixtureOf(r: Row): MessageFixture {
  return {
    id: r.label, folder: "ohbox", from: { name: r.label, address: `${r.label}@example.com` },
    subject: `Subject ${r.label}`, snippet: `snippet ${r.label}`, time: "Mon", unread: r.unread,
  };
}

interface World {
  engine: OhmailEngine;
  /** Every mutation the adapter received — the ENRICHED one, which is what the wire sends. */
  sent: EngineMutation[];
  /** Every message entity the fixture backend echoed for a mutation. */
  echoed: EngineMessage[];
}

async function world(rows: readonly Row[]): Promise<World> {
  const base = getFixtures();
  const inner = new FixturesAdapter({
    fixtures: {
      ...base, ohbox: rows.map(fixtureOf), reads: [], receipts: [],
      triage: { replyLater: [], setAside: [], resurface: [] },
    },
  });
  const byId = new Map(rows.map((r) => [r.label, r]));
  const seeded = new Set<string>();
  const stamp = (c: SyncChange): SyncChange => {
    const r = c.type === "message" ? byId.get(c.id) : undefined;
    if (!r || !c.entity) return c;
    const first = !seeded.has(c.id);
    seeded.add(c.id);
    return {
      ...c,
      entity: {
        ...(c.entity as object), threadId: r.thread, date: r.arrived, sortAt: r.arrived,
        folder: r.folder ?? "INBOX",
        // The "server" holds a stamp only on the row's first page (what a reload reads back).
        ...(first && r.openReadAt !== undefined ? { openReadAt: r.openReadAt } : {}),
      },
    };
  };
  const sent: EngineMutation[] = [];
  const echoed: EngineMessage[] = [];
  const adapter: EngineAdapter = {
    fetchBody: () => inner.fetchBody(),
    withdrawSend: (key, draftId) => inner.withdrawSend(key, draftId),
    async sync(params) {
      const r = await inner.sync(params);
      return {
        ...r,
        changes: {
          ...r.changes, creates: r.changes.creates.map(stamp), updates: r.changes.updates.map(stamp),
          moves: r.changes.moves.map(stamp),
        },
      };
    },
    async mutate(m, o) {
      sent.push(m);
      const out = await inner.mutate(m, o);
      const changes = out.changes.map(stamp);
      for (const c of changes) if (c.type === "message" && c.entity) echoed.push(c.entity as EngineMessage);
      return { ...out, changes };
    },
  };
  const engine = new OhmailEngine({ adapter, now: () => DEMO_NOW });
  await engine.start();
  return { engine, sent, echoed };
}

const ids = (list: readonly EngineMessage[]) => list.map((m) => m.id);
const box = (engine: OhmailEngine) => ohboxView(engine.read(), engine.openRowHeld());
const flagged = (m: EngineMutation): boolean => (m as { openRead?: unknown }).openRead === true;
const openReadOf = (m: EngineMessage): string | null | undefined => (m as { openReadAt?: string | null }).openReadAt;

describe("the reported shape: an old unread row opened, read and left files at the top of Earlier", () => {
  it("F arrived Friday, below four read rows; read while open, it is Earlier's first row once left", async () => {
    const { engine } = await world(OWNER_ROWS);
    expect(ids(box(engine).previouslySeen), "the premise: arrival order").toEqual(ARRIVAL);

    expect(engine.holdOpenRow("fri")).toBe(true);
    const res = await engine.mutate({ kind: "mark_seen", messageIds: ["fri"], unread: false, via: "glance" });
    expect(res.status).toBe("confirmed");
    // Held: still in New at its slot while the reader is on it.
    expect(ids(box(engine).newForYou)).toEqual(["fri"]);
    expect(ids(box(engine).previouslySeen)).toEqual(ARRIVAL);

    engine.releaseOpenRow("fri");
    const after = box(engine);
    expect(ids(after.newForYou)).toEqual([]);
    // MUTATION WATCHED: drop `openReadMsOf` from `placeOf` and "fri" is at index 4 again.
    expect(ids(after.previouslySeen)).toEqual(["fri", ...ARRIVAL]);
  });
});

describe("durable: the stamp is the server's, so a reload keeps the row on top", () => {
  it("a second engine over the same rows, F carrying the server's openReadAt, reads F first", async () => {
    const rows: Row[] = OWNER_ROWS.map((r) =>
      r.label === "fri" ? { ...r, unread: false, openReadAt: "2026-07-29T11:00:00.000Z" } : r);
    const { engine } = await world(rows);
    expect(ids(box(engine).previouslySeen)).toEqual(["fri", ...ARRIVAL]);
  });
});

/** Conversation C, three unread members on Thursday, below the reader's read rows. */
const C_ROWS: Row[] = [
  ...OWNER_ROWS,
  { label: "c1", thread: "C", arrived: "2026-07-23T10:00:00.000Z", unread: true },
  { label: "c2", thread: "C", arrived: "2026-07-23T11:00:00.000Z", unread: true },
  { label: "c3", thread: "C", arrived: "2026-07-23T12:00:00.000Z", unread: true },
];

describe("together: a held conversation read in two chunks is ONE row at the top", () => {
  it("both chunks are flagged and the conversation leads Earlier once left", async () => {
    const { engine, sent } = await world(C_ROWS);
    expect(engine.holdOpenRow("c3")).toBe(true);
    // The 200-chunk shape at small size: two ids, then one.
    await engine.mutate({ kind: "mark_seen", messageIds: ["c3", "c2"], unread: false });
    await engine.mutate({ kind: "mark_seen", messageIds: ["c1"], unread: false });
    const reads = sent.filter((m) => m.kind === "mark_seen");
    expect(reads.map(flagged), "every chunk of the held conversation is an open read").toEqual([true, true]);

    engine.releaseOpenRow("c3");
    const earlier = ids(box(engine).previouslySeen);
    expect(new Set(earlier.slice(0, 3))).toEqual(new Set(["c1", "c2", "c3"]));
    // `fri` is still unread, so it stands in New; the read rows keep arrival below the conversation.
    expect(earlier.slice(3)).toEqual(ARRIVAL);
  });

  it("CONTROL: the same ids with the hold on ANOTHER conversation are unflagged and keep arrival", async () => {
    const { engine, sent } = await world(C_ROWS);
    expect(engine.holdOpenRow("fri")).toBe(true);
    await engine.mutate({ kind: "mark_seen", messageIds: ["c3", "c2"], unread: false });
    await engine.mutate({ kind: "mark_seen", messageIds: ["c1"], unread: false });
    expect(sent.filter((m) => m.kind === "mark_seen").map(flagged)).toEqual([false, false]);
    expect(ids(box(engine).previouslySeen)).toEqual([...ARRIVAL, "c3", "c2", "c1"]);
  });
});

async function mirrorOf(rows: readonly Row[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges(rows.map((r): SyncChange => ({
    type: "message", op: "create", id: r.label, seq: ++seq, updatedAt: r.arrived,
    entity: {
      id: r.label, accountId: "demo", mailboxId: "lichtgrat", threadId: r.thread, messageIdHeader: null,
      subject: r.label, from: { name: null, address: `${r.label}@example.com` }, to: [], cc: [],
      date: r.arrived, sortAt: r.arrived, folder: "INBOX", snippet: "", unread: r.unread,
      hasAttachments: false, attachmentCount: 0,
      sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: null, labels: [], remoteContent: "none", updatedAt: r.arrived,
      ...(r.openReadAt !== undefined ? { openReadAt: r.openReadAt } : {}),
    } satisfies EngineMessage,
  })));
  return store;
}

describe("parity: the overlay, the fixture echo and the server stamp the same rows", () => {
  for (const shape of OPEN_READ_SHAPES) {
    it(shape.name, async () => {
      const { engine, sent, echoed } = await world(shape.rows);
      engine.holdOpenRow(shape.held);
      await engine.mutate({ kind: "mark_seen", messageIds: shape.ids, unread: shape.unread });
      const enriched = sent.find((m) => m.kind === "mark_seen")!;
      expect(enriched, "the adapter saw the read").toBeDefined();

      // The overlay, over the rows as they stood before the read.
      const overlay = mutationEffects(await mirrorOf(shape.rows), enriched, { now: () => DEMO_NOW, uuid: () => "u" })
        .filter((e) => e.type === "message" && e.entity)
        .map((e) => e.entity as EngineMessage);
      const before = new Map(shape.rows.map((r) => [r.label, r.openReadAt ?? null]));
      const stampedBy = (list: readonly EngineMessage[]) =>
        list.filter((m) => openReadOf(m) != null && openReadOf(m) !== before.get(m.id)).map((m) => m.id).sort();
      const clearedBy = (list: readonly EngineMessage[]) =>
        list.filter((m) => before.get(m.id) != null && openReadOf(m) == null).map((m) => m.id).sort();

      // MUTATION WATCHED: paint without the `msg.unread` check and the read member is stamped too.
      expect(stampedBy(overlay), "overlay").toEqual([...shape.stamped].sort());
      expect(stampedBy(echoed), "fixture echo").toEqual([...shape.stamped].sort());
      expect(clearedBy(overlay), "overlay clears").toEqual([...shape.cleared].sort());
      expect(clearedBy(echoed), "echo clears").toEqual([...shape.cleared].sort());
    });
  }
});

/** the flow: F opened, read while held, left — lifted to the top. */
async function liftedFri(): Promise<World> {
  const w = await world(OWNER_ROWS);
  w.engine.holdOpenRow("fri");
  await w.engine.mutate({ kind: "mark_seen", messageIds: ["fri"], unread: false, via: "glance" });
  w.engine.releaseOpenRow("fri");
  expect(ids(box(w.engine).previouslySeen)[0], "the premise: lifted").toBe("fri");
  return w;
}

describe("the positive controls: every other read keeps arrival", () => {
  it("Mark all read over two conversations while F is held: no flag, every row at arrival", async () => {
    const { engine, sent } = await world(C_ROWS);
    engine.holdOpenRow("fri");
    await engine.mutate({ kind: "mark_seen", messageIds: ["fri", "c3", "c2", "c1"], unread: false });
    // MUTATION WATCHED: the enrich arm's conversation check cut to `msg !== undefined` flags this.
    expect(sent.filter((m) => m.kind === "mark_seen").map(flagged)).toEqual([false]);
    engine.releaseOpenRow("fri");
    expect(ids(box(engine).previouslySeen)).toEqual([...ARRIVAL, "fri", "c3", "c2", "c1"]);
  });

  it("Mark all read's twin: a flag a SURFACE put on the mutation is dropped — enrich alone decides", async () => {
    const { engine, sent } = await world(C_ROWS);
    await engine.mutate({ kind: "mark_seen", messageIds: ["c1"], unread: false, openRead: true });
    expect(sent.filter((m) => m.kind === "mark_seen").map(flagged), "nothing is held; the flag must not survive").toEqual([false]);
  });

  it("a read in another client — a sync change, now or a cycle later — keeps arrival", async () => {
    const rows = OWNER_ROWS.map((r) => (r.label === "fri" ? { ...r, unread: false } : r));
    const store = await mirrorOf(OWNER_ROWS);
    const before = ids(ohboxView(store).previouslySeen);
    expect(before).toEqual(ARRIVAL);
    const read = (await mirrorOf(rows)).get<EngineMessage>("message", "fri")!;
    for (const at of ["2026-07-29T11:59:00.000Z", "2026-07-29T12:10:00.000Z"]) {
      await store.applyChanges([{
        type: "message", op: "update", id: "fri", seq: 100 + at.length, updatedAt: at,
        entity: { ...read, lastReadAt: at, openReadAt: null, updatedAt: at },
      } as SyncChange]);
      expect(ids(ohboxView(store).previouslySeen), at).toEqual([...ARRIVAL, "fri"]);
    }
  });

  it("the u key on the lifted row clears the stamp and puts it in New; a later bulk read files it at arrival", async () => {
    const { engine } = await liftedFri();
    await engine.mutate({ kind: "mark_seen", messageIds: ["fri"], unread: true });
    const fri = engine.read().get<EngineMessage>("message", "fri")!;
    expect(openReadOf(fri) ?? null).toBeNull();
    expect(ids(box(engine).newForYou)).toEqual(["fri"]);
    await engine.mutate({ kind: "mark_seen", messageIds: ["fri", "tue"], unread: false });
    expect(ids(box(engine).previouslySeen)).toEqual([...ARRIVAL, "fri"]);
  });

  it("Mark unread on a lifted row, held again, then Undo: no open read on the wire, back below the newer one once left", async () => {
    const { engine, sent } = await liftedFri();
    const friAt = openReadOf(engine.read().get<EngineMessage>("message", "fri")!);
    await engine.mutate({ kind: "mark_seen", messageIds: ["tue"], unread: true });
    engine.holdOpenRow("tue");
    await engine.mutate({ kind: "mark_seen", messageIds: ["tue"], unread: false, via: "glance" });
    engine.releaseOpenRow("tue");
    expect(ids(box(engine).previouslySeen).slice(0, 2), "the premise: tue's open read is newer").toEqual(["tue", "fri"]);

    const press: EngineMutation = { kind: "mark_seen", messageIds: ["fri"], unread: true };
    const undo = inverseMutations(engine.verbRead(), press);
    await engine.mutate(press);
    expect(engine.holdOpenRow("fri"), "the Undo link re-takes the hold").toBe(true);
    const before = sent.length;
    for (const u of undo) expect((await engine.mutate(u)).status).toBe("confirmed");
    expect(sent.slice(before).filter((m) => m.kind === "mark_seen").map(flagged), "an Undo's read placed the row anew").toEqual([false]);
    engine.releaseOpenRow("fri");
    expect(openReadOf(engine.read().get<EngineMessage>("message", "fri")!)).toBe(friAt);
    expect(ids(box(engine).previouslySeen)).toEqual(["tue", "fri", ...ARRIVAL.slice(1)]);
  });

  it("re-opening a read row holds nothing and writes nothing", async () => {
    const { engine, sent } = await liftedFri();
    const before = sent.length;
    expect(engine.holdOpenRow("fri")).toBe(false);
    expect(sent.length).toBe(before);
    expect(ids(box(engine).previouslySeen)[0]).toBe("fri");
  });

  it("the overlay's floor: a second open read paints above the first though the clock stands still", async () => {
    const { engine } = await liftedFri();
    const tue = OWNER_ROWS.find((r) => r.label === "tue")!;
    expect(tue.unread).toBe(false);
    // Mark tue unread, then open-read it under the same frozen clock: it must land above fri.
    await engine.mutate({ kind: "mark_seen", messageIds: ["tue"], unread: true });
    engine.holdOpenRow("tue");
    await engine.mutate({ kind: "mark_seen", messageIds: ["tue"], unread: false, via: "glance" });
    engine.releaseOpenRow("tue");
    expect(ids(box(engine).previouslySeen).slice(0, 2)).toEqual(["tue", "fri"]);
  });

  it("the floor refuses a reader that cannot list, rather than painting now unchecked", () => {
    const reader = { get: () => ({ ...OWNER_MSG, unread: true }) } as never;
    expect(() => mutationEffects(reader, { kind: "mark_seen", messageIds: ["fri"], unread: false, openRead: true },
      { now: () => DEMO_NOW, uuid: () => "u" })).toThrow(/list/);
  });
});

const OWNER_MSG = {
  id: "fri", accountId: "demo", mailboxId: "lichtgrat", threadId: "FRI", messageIdHeader: null, subject: "s",
  from: { name: null, address: "fri@example.com" }, to: [], cc: [], date: "2026-07-24T00:15:00.000Z",
  folder: "INBOX", snippet: "", unread: true, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: "2026-07-24T00:15:00.000Z",
} satisfies EngineMessage;

describe("the default branch: no stamp, the same array; the cost is the lifted rows' sort", () => {
  it("with no open read in the mirror, placeEarlier returns the identical array", async () => {
    const store = await mirrorOf(OWNER_ROWS);
    const list = ohboxView(store).previouslySeen.slice();
    expect(placeEarlier(list, store)).toBe(list);
  });

  it("stamped rows move alone; a bump that leaves the message stamp re-sorts nothing", async () => {
    // Two lifted rows, so their sort makes at least one comparison the arm can count.
    const store = await mirrorOf(OWNER_ROWS.map((r) =>
      r.label === "sat" ? { ...r, openReadAt: "2026-07-29T11:00:00.000Z" }
        : r.label === "sun" ? { ...r, openReadAt: "2026-07-29T10:00:00.000Z" } : r));
    const start = earlierPlaceComparisons();
    expect(ids(ohboxView(store).previouslySeen)).toEqual(["sat", "sun", "tue", "mon"]);
    const sorted = earlierPlaceComparisons() - start;
    expect(sorted, "the arm counts nothing").toBeGreaterThan(0);
    // A tag write moves the version and not the message stamp: the view re-derives, the lift is cached.
    await store.applyChanges([{ type: "tag", op: "create", id: "t1", seq: 500, updatedAt: "2026-07-29T12:00:00.000Z",
      entity: { id: "t1", name: "T", hue: 1, className: "t" } } as SyncChange]);
    expect(ids(ohboxView(store).previouslySeen)).toEqual(["sat", "sun", "tue", "mon"]);
    expect(earlierPlaceComparisons() - start, "the lifted sort ran again on an unchanged message stamp").toBe(sorted);
  });
});

/**
 * A ROW THAT ENTERS A PILE OR A PIN HAS BEEN HANDLED BY ANOTHER ACT, AND THAT ACT PLACES IT (hand-back
 * 1, H1): the open read is cleared by the transition, so Done and un-park file at arrival. And a press
 * never stamps a member that is parked or pinned at the moment of the read (LOW 6).
 */
describe("H1 a park or a pin ends the open read", () => {
  it("open-read, Resurface, Done: the row files at its arrival index", async () => {
    const { engine } = await liftedFri();
    await engine.mutate({ kind: "triage_set", messageId: "fri", state: "resurfaced" as never });
    expect(ids(box(engine).resurfaced)).toContain("fri");
    expect(openReadOf(engine.read().get<EngineMessage>("message", "fri")!) ?? null, "the pin cleared the open read").toBeNull();
    await engine.mutate({ kind: "mark_seen", messageIds: ["fri"], unread: false });
    // MUTATION WATCHED: drop the overlay's clear on a non-none state and fri is first again.
    expect(ids(box(engine).previouslySeen)).toEqual([...ARRIVAL, "fri"]);
  });

  it("open-read, Reply later, then none: the row files at its arrival index", async () => {
    const { engine } = await liftedFri();
    await engine.mutate({ kind: "triage_set", messageId: "fri", state: "reply_later" });
    expect(ids(box(engine).previouslySeen)).toEqual(ARRIVAL);
    await engine.mutate({ kind: "triage_set", messageId: "fri", state: "none" });
    expect(ids(box(engine).previouslySeen)).toEqual([...ARRIVAL, "fri"]);
  });

  it("LOW 6: a press over the held conversation never stamps a member that is parked", async () => {
    const { engine, echoed } = await world(C_ROWS);
    await engine.mutate({ kind: "triage_set", messageId: "c1", state: "reply_later" });
    expect(engine.holdOpenRow("c3")).toBe(true);
    await engine.mutate({ kind: "mark_seen", messageIds: ["c3", "c2", "c1"], unread: false });
    const c1 = engine.read().get<EngineMessage>("message", "c1")!;
    expect(c1.unread, "the parked member is read").toBe(false);
    expect(openReadOf(c1) ?? null, "the overlay stamped a parked member").toBeNull();
    expect(openReadOf(echoed.filter((m) => m.id === "c1").at(-1)!) ?? null, "the echo stamped a parked member").toBeNull();
    expect(openReadOf(engine.read().get<EngineMessage>("message", "c2")!)).toEqual(expect.any(String));
  });
});

describe("LOW 4 the overlay's floor scans the mirror once per version", () => {
  it("two open-read effects over one mirror version scan once; a new version scans again", async () => {
    const store = await mirrorOf(C_ROWS);
    const m: Extract<EngineMutation, { kind: "mark_seen" }> = { kind: "mark_seen", messageIds: ["c1"], unread: false, openRead: true };
    const ctx = { now: () => DEMO_NOW, uuid: () => "u" };
    const start = openReadFloorScanCount();
    mutationEffects(store, m, ctx);
    mutationEffects(store, { ...m, messageIds: ["c2"] }, ctx);
    // MUTATION WATCHED: key the cache on nothing and this reads 2.
    expect(openReadFloorScanCount() - start).toBe(1);
    await store.applyChanges([{ type: "message", op: "update", id: "c3", seq: 900, updatedAt: "2026-07-29T12:00:00.000Z",
      // A server stamp AHEAD of this device's clock (the 126 s skew this host once measured).
      entity: { ...store.get<EngineMessage>("message", "c3")!, openReadAt: "2026-07-29T13:00:00.000Z" } } as SyncChange]);
    const effects = mutationEffects(store, m, ctx);
    expect(openReadFloorScanCount() - start, "a new message version must be read again").toBe(2);
    // …and the floor read the new newest stamp: the paint lands 1 ms above it, never below.
    const painted = openReadOf(effects.find((e) => e.id === "c1")!.entity as EngineMessage)!;
    expect(painted).toBe("2026-07-29T13:00:00.001Z");
  });
});
