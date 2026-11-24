import type { EngineMessage, Folder } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  ohboxView,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * THE OHBOX IS IN ARRIVAL ORDER, AND A READ THE ENGINE DID NOT HOLD NEVER MOVES A ROW (owner ruling
 * 2026-09-18, reversing 2026-08-08's "Earlier is reading order"; narrowed 2026-10-07: an OPEN READ
 * — `openReadAt`, `earlier-takes-the-open-read.test.ts` — takes the top of Earlier): every other row
 * is positioned by the ONE arrival key `tsOf` (`sortAt ?? date`), newest first; `lastReadAt` is
 * state — the seen pill — never a sort key. Measured on a live mailbox: two sorts ("Earlier" by reading
 * stamp with the own-sent join keyed on send dates) stacked the whole sent history above the
 * unstamped received history — year-jumping batches nobody read in that order.
 */

let seq = 0;

function msg(o: {
  id: string;
  date: string;
  folder?: string;
  sortAt?: string;
  unread?: boolean;
  lastReadAt?: string | null;
}): EngineMessage {
  const m: EngineMessage = {
    id: o.id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${o.id}`,
    from: { name: null, address: `${o.id}@example.com` },
    to: [],
    cc: [],
    date: o.date,
    folder: (o.folder ?? "INBOX") as Folder,
    snippet: `snippet ${o.id}`,
    unread: o.unread ?? false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: o.date,
  };
  if ("sortAt" in o) m.sortAt = o.sortAt;
  // ABSENT and null are different values and both have to be exercised: a mirror written by a
  // build older than the field holds neither `null` nor a stamp, it holds nothing at all.
  if ("lastReadAt" in o) m.lastReadAt = o.lastReadAt;
  return m;
}

async function mirrorOf(messages: EngineMessage[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    messages.map((m) => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })) as SyncChange[],
  );
  return store;
}

const earlier = async (messages: EngineMessage[]): Promise<string[]> =>
  ohboxView(await mirrorOf(messages)).previouslySeen.map((m) => m.id);

/**
 * THE MEASURED SHAPE (incident report 2026-09-18, "The top-of-list batches" — hashed positions,
 * nothing identifying): a handled block of real reads at DISTINCT instants across header years,
 * a large own-SENT history unstamped across 2024–2026, a received basement unstamped across
 * 2020–2026, unread rows on top. Under the reversed rule ("Earlier" reading-stamped, sent rows
 * keyed on send dates) the sent history STACKED above the basement as a second chronology —
 * a stretch of a live account's list was one run of sent rows, all from one year, with the read
 * history restarting below. The pin: ONE chronology, strictly newest-first by `sortAt ?? date`.
 */
function measuredShape(): EngineMessage[] {
  const rows: EngineMessage[] = [
    // Unread, arrived today — "New for you".
    msg({ id: "n1", date: "2026-09-18T10:00:00.000Z", unread: true }),
    msg({ id: "n2", date: "2026-09-18T08:00:00.000Z", unread: true }),
    // Real reads at distinct instants, dates spread across years — an old mail read this
    // morning MUST NOT float above yesterday's mail.
    msg({ id: "r-sep18", date: "2026-09-18T07:00:00.000Z", lastReadAt: "2026-09-18T11:45:46.000Z" }),
    msg({ id: "r-sep14", date: "2026-09-14T09:00:00.000Z", lastReadAt: "2026-09-18T11:45:36.000Z" }),
    msg({ id: "r-aug29", date: "2026-08-29T09:00:00.000Z", lastReadAt: "2026-09-15T12:14:46.000Z" }),
    msg({ id: "r-2025", date: "2025-03-02T09:00:00.000Z", lastReadAt: "2026-09-18T11:41:26.000Z" }),
    msg({ id: "r-2020", date: "2020-05-12T09:00:00.000Z", lastReadAt: "2026-09-18T11:41:53.000Z" }),
    // The own-sent history: unstamped, 2024–2026 — the block that stacked.
    msg({ id: "s-sep18", folder: "Sent", date: "2026-09-18T09:30:00.000Z" }),
    msg({ id: "s-sep16", folder: "Sent", date: "2026-09-16T09:00:00.000Z" }),
    msg({ id: "s-2025a", folder: "Sent", date: "2025-11-20T09:00:00.000Z" }),
    msg({ id: "s-2025b", folder: "Sent", date: "2025-06-05T09:00:00.000Z" }),
    msg({ id: "s-2024", folder: "Sent", date: "2024-04-01T09:00:00.000Z" }),
    // The received basement: read elsewhere before ohmail saw it, no stamp, 2020–2026.
    msg({ id: "b-aug", date: "2026-08-10T09:00:00.000Z", lastReadAt: null }),
    msg({ id: "b-2025", date: "2025-09-01T09:00:00.000Z" }),
    msg({ id: "b-2024", date: "2024-10-01T09:00:00.000Z", lastReadAt: null }),
    msg({ id: "b-2020", date: "2020-03-01T09:00:00.000Z" }),
    // A clamped row (mail 0119): header 2025, arrived Sep 17 — the ONE key is sortAt.
    msg({ id: "clamped", date: "2025-01-15T09:00:00.000Z", sortAt: "2026-09-17T09:00:00.000Z", lastReadAt: null }),
  ];
  return rows;
}

/** Every pile of the measured shape, in strict arrival order — one chronology. */
const ARRIVAL_EARLIER = [
  "s-sep18",  // 2026-09-18T09:30
  "r-sep18",  // 2026-09-18T07:00
  "clamped",  // sortAt 2026-09-17
  "s-sep16",  // 2026-09-16
  "r-sep14",  // 2026-09-14
  "r-aug29",  // 2026-08-29
  "b-aug",    // 2026-08-10
  "s-2025a",  // 2025-11-20
  "b-2025",   // 2025-09-01
  "s-2025b",  // 2025-06-05
  "r-2025",   // 2025-03-02
  "b-2024",   // 2024-10-01
  "s-2024",   // 2024-04-01
  "r-2020",   // 2020-05-12
  "b-2020",   // 2020-03-01
];

describe("the Ohbox is one arrival-ordered chronology — the measured shape", () => {
  it("every pile in strict arrival order: no sent stack, no basement, no read-floats", async () => {
    const view = ohboxView(await mirrorOf(measuredShape()));
    // MUTATION WATCHED (mutation-control.sh, 2026-09-18): put `previouslySeen`'s sort back to
    // the reading-stamp comparator and this list goes red on its first element — the stamped
    // reads float to the top by read instant and the sent rows stack above the basement.
    expect(view.previouslySeen.map((m) => m.id)).toEqual(ARRIVAL_EARLIER);
    expect(view.newForYou.map((m) => m.id)).toEqual(["n1", "n2"]);
  });

  it("a sent row sits at its send instant AMONG received rows, never as a second chronology", async () => {
    const ids = await earlier(measuredShape());
    // The 2025 sent rows sit below every 2026 received row — the year-jumping batch dissolved.
    for (const sent of ["s-2025a", "s-2025b"]) {
      for (const received of ["r-sep14", "r-aug29", "b-aug"]) {
        expect(ids.indexOf(sent), `${sent} above ${received}`).toBeGreaterThan(ids.indexOf(received));
      }
    }
  });
});

describe("a read the engine did not hold never moves a row", () => {
  it("stamping a row read at NOW leaves its position unchanged", async () => {
    const rows = measuredShape();
    const before = await earlier(rows);
    // `b-2025` — deep in the history. The reader opens it now; the stamp is state, not a key.
    const after = await earlier(rows.map((m) =>
      m.id === "b-2025" ? { ...m, lastReadAt: "2026-09-18T12:00:00.000Z" } : m,
    ));
    expect(after).toEqual(before);
  });

  it("a read the engine did not hold files at its arrival slot, not at the top", async () => {
    const rows = measuredShape();
    // `n2` arrived today 08:00 — read, it files between `s-sep18` (09:30) and `r-sep18` (07:00).
    const after = ohboxView(await mirrorOf(rows.map((m) =>
      m.id === "n2" ? { ...m, unread: false, lastReadAt: "2026-09-18T12:00:00.000Z" } : m,
    )));
    expect(after.newForYou.map((m) => m.id)).toEqual(["n1"]);
    const ids = after.previouslySeen.map((m) => m.id);
    expect(ids.indexOf("n2")).toBe(ids.indexOf("s-sep18") + 1);
    expect(ids.indexOf("r-sep18")).toBe(ids.indexOf("n2") + 1);
  });

  it("a batch read in ONE gesture moves nothing — every row keeps its arrival slot", async () => {
    // `markSeen` stamps one instant for the whole selection. Under a stamp sort that was a tie
    // to break; under arrival order the stamps change nothing at all.
    const tie = "2026-08-06T10:00:00.000Z";
    const rows = [
      msg({ id: "m3", date: "2026-08-01T09:00:00.000Z", lastReadAt: tie }),
      msg({ id: "m1", date: "2026-08-03T09:00:00.000Z", lastReadAt: tie }),
      msg({ id: "m2", date: "2026-08-02T09:00:00.000Z", lastReadAt: tie }),
    ];
    expect(await earlier(rows)).toEqual(["m1", "m2", "m3"]);
    // …and the same set in a different mirror order produces the same list.
    expect(await earlier([rows[1]!, rows[2]!, rows[0]!])).toEqual(["m1", "m2", "m3"]);
  });

  it("every stamp shape — real, null, absent, unparseable — orders identically", async () => {
    // The stamp is not a key, so no shape of it may matter. Same three dates, four stampings.
    const dates = ["2026-08-03T09:00:00.000Z", "2026-08-02T09:00:00.000Z", "2026-08-01T09:00:00.000Z"];
    const stamps: (string | null | undefined)[] = ["2026-09-01T00:00:00.000Z", null, undefined, "not a date"];
    for (const stamp of stamps) {
      const rows = dates.map((date, i) =>
        stamp === undefined
          ? msg({ id: `d${i}`, date })
          : msg({ id: `d${i}`, date, lastReadAt: stamp }),
      );
      expect(await earlier(rows), String(stamp)).toEqual(["d0", "d1", "d2"]);
    }
  });

  it("an open read moves its row ALONE: the measured shape with one stamp is ARRIVAL_EARLIER otherwise verbatim", async () => {
    // `b-2025`, read in ohmail while open (owner 2026-10-07): it leads Earlier; nothing else moves.
    const ids = await earlier(measuredShape().map((m) =>
      m.id === "b-2025" ? { ...m, lastReadAt: "2026-09-18T12:00:00.000Z", openReadAt: "2026-09-18T12:00:00.000Z" } : m,
    ));
    expect(ids).toEqual(["b-2025", ...ARRIVAL_EARLIER.filter((id) => id !== "b-2025")]);
  });

  it("NEW FOR YOU IS UNTOUCHED — unread mail is ordered by arrival, a leftover stamp ignored", async () => {
    // A `lastReadAt` left over on an unread row (marked unread again after being read, before
    // the write lands) must not reach any group's order.
    const view = ohboxView(await mirrorOf([
      msg({ id: "u-old", date: "2026-01-01T09:00:00.000Z", unread: true, lastReadAt: "2026-08-09T09:00:00.000Z" }),
      msg({ id: "u-new", date: "2026-08-01T09:00:00.000Z", unread: true }),
    ]));
    expect(view.newForYou.map((m) => m.id)).toEqual(["u-new", "u-old"]);
    expect(view.previouslySeen).toEqual([]);
  });
});
