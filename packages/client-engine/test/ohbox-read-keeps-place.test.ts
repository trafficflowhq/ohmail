import type { EngineMessage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  ohboxView, screenerSegments, arrivalMs,
  type EntityReader,
} from "@ohmail/client-engine";

/**
 * A READ NEVER MOVES A ROW MONTHS AWAY (owner report 2026-09-18). Two measured mechanisms, one
 * symptom: every date comparator keyed on the raw sender-written `Date:` header, so a header
 * months from arrival WAS the row's position; and "Earlier" filed every unstamped read row below
 * everything ever stamped, at a fixed boundary months down. The fix: the server clamps the
 * header against recorded arrival into `sortAt`, and every comparator keys on `sortAt ?? date`
 * in ONE derivation. Since the arrival ruling (owner 2026-09-18, same day) that one key
 * positions EVERY row, read or unread — `lastReadAt` is state, never a sort key. These are the
 * briefed controls (a)–(g); position is read through the SELECTOR's order, never a rendering.
 */

const NOW = new Date("2026-09-18T13:19:00.000Z");
const iso = (d: Date) => d.toISOString();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 864e5);
const APRIL = "2026-04-14T09:00:00.000Z";

let seq = 0;
function mkMsg(p: Partial<EngineMessage> & { date: string | null }): EngineMessage {
  seq += 1;
  return {
    id: p.id ?? `m${String(seq).padStart(3, "0")}`,
    accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: p.subject ?? `s-${seq}`, from: { name: "N", address: p.id ? `${p.id}@example.test` : `n${seq}@example.test` },
    to: [], cc: [], folder: "INBOX", snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: p.date ?? iso(NOW),
    ...p,
  } as EngineMessage;
}

function readerOf(list: EngineMessage[]): EntityReader {
  let v = 0;
  // Type-aware: `screenerSegments` lists other entity types too, and a fake that answers
  // messages for every type hands `heldReleaseClaim` rows with no `match` to trim.
  return {
    list: <T,>(type: string) => (type === "message" ? list.map((m) => ({ ...m })) : []) as T[],
    get: <T,>(type: string, id: string) =>
      (type === "message" ? list.find((e) => e.id === id) : undefined) as T | undefined,
    entries: <T,>(type: string) =>
      type === "message" ? list.map((entity, i) => ({ id: entity.id, entity: entity as T, seq: i })) : [],
    version: () => ++v,
  } as EntityReader;
}

/**
 * A mailbox shaped like a real one: mail read in-app over the last 90 days (stamped), a
 * basement of history read before the stamp existed (unstamped, back to 18 months), and a
 * few unread rows. The basement is what the old rule filed fresh rows UNDER.
 */
function corpus(): EngineMessage[] {
  seq = 0;
  const msgs: EngineMessage[] = [];
  for (let i = 0; i < 40; i++) {
    const read = daysAgo(1 + i * 2);
    const dated = new Date(read.getTime() - 2 * 864e5);
    msgs.push(mkMsg({ date: iso(dated), lastReadAt: iso(read), unread: false }));
  }
  for (let i = 0; i < 40; i++) {
    msgs.push(mkMsg({ date: iso(daysAgo(30 + i * 14)), lastReadAt: null, unread: false }));
  }
  for (let i = 0; i < 4; i++) msgs.push(mkMsg({ date: iso(daysAgo(0.2 + i * 0.5)), unread: true }));
  return msgs;
}

const read = (m: EngineMessage, stamp: string | null): EngineMessage =>
  ({ ...m, unread: false, lastReadAt: stamp, updatedAt: iso(NOW) });
const sub = (list: EngineMessage[], m: EngineMessage) => list.map((x) => (x.id === m.id ? m : x));

function positions(list: EngineMessage[], id: string) {
  const v = ohboxView(readerOf(list));
  return {
    newIdx: v.newForYou.findIndex((m) => m.id === id),
    prevIdx: v.previouslySeen.findIndex((m) => m.id === id),
    prevLen: v.previouslySeen.length,
    prevAt: (i: number) => v.previouslySeen[i],
  };
}

describe("the Ohbox's order key is the arrival-anchored sortAt, on both sides of a read", () => {
  it("(a) an invitation arriving today sits at its arrival slot before AND after a read", () => {
    const invite = mkMsg({
      id: "invite", subject: "Invitation: Sync @ Tue Sep 29, 2026 10am (CEST)",
      date: iso(NOW), sortAt: iso(NOW), arrivedAt: iso(NOW), unread: true,
    });
    const list = [...corpus(), invite];
    expect(positions(list, "invite").newIdx).toBe(0);
    // Read, stamp intact: the top of "Earlier" — the same arrival-anchored place.
    expect(positions(sub(list, read(invite, iso(NOW))), "invite").prevIdx).toBe(0);
  });

  it("(b)(f) an April-header mail arriving today sits at TODAY in New and, read, at TODAY in Earlier", () => {
    const stale = mkMsg({
      id: "stale", subject: "dated April, arrived today",
      date: APRIL, sortAt: iso(NOW), arrivedAt: iso(NOW), unread: true,
    });
    const list = [...corpus(), stale];
    // Before the read: the ARRIVAL slot of "New for you", not the April slot the raw header buys.
    expect(positions(list, "stale").newIdx).toBe(0);
    // After the read, stamp intact: the top of "Earlier".
    expect(positions(sub(list, read(stale, iso(NOW))), "stale").prevIdx).toBe(0);
    // After a read whose stamp was LOST: still the arrival slot — sortAt files it, not the header.
    expect(positions(sub(list, read(stale, null)), "stale").prevIdx).toBe(0);
  });

  it("(g) a today row whose read stamp is lost files at its own instant, never the basement", () => {
    const invite = mkMsg({
      id: "invite", date: iso(NOW), sortAt: iso(NOW), arrivedAt: iso(NOW), unread: true,
    });
    const list = sub([...corpus(), invite], read(invite, null));
    const p = positions(list, "invite");
    // Its arrival is the newest instant in the section, so it stands at the top — under the
    // old two-block rule it stood below every stamped row (measured: deep in the section).
    expect(p.prevIdx).toBe(0);
  });

  it("(d) a message that legitimately arrived in April sits in April — both row shapes", () => {
    // The live shape: arrival recorded in April, header April, sortAt = the header.
    const liveApril = mkMsg({ id: "live-april", date: APRIL, sortAt: APRIL, arrivedAt: APRIL, unread: false, lastReadAt: null });
    // The pre-0119 shape: no recorded arrival, no sortAt — the header decides, as it always did.
    const oldApril = mkMsg({ id: "old-april", date: APRIL, unread: false, lastReadAt: null });
    const list = [...corpus(), liveApril, oldApril];
    const v = ohboxView(readerOf(list));
    for (const id of ["live-april", "old-april"]) {
      const i = v.previouslySeen.findIndex((m) => m.id === id);
      expect(i, id).toBeGreaterThan(0);
      // Chronological neighbourhood: everything above it ARRIVED later, everything below it
      // earlier — the row is in April, not at any boundary. Arrival is the only instant asked;
      // the rows' stamps are state and may say anything.
      const own = Date.parse(APRIL);
      const above = v.previouslySeen[i - 1]!;
      expect(arrivalMs(above)!).toBeGreaterThanOrEqual(own);
      const below = v.previouslySeen[i + 1];
      if (below) expect(arrivalMs(below)!).toBeLessThanOrEqual(own);
    }
  });

  it("(c) the Screener and the Ohbox order one message by the SAME key", () => {
    // Two undecided strangers at the gate: one dated April but arriving today (clamped), one
    // dated yesterday. The clamped row outranks the yesterday row in BOTH selectors, or the two
    // surfaces would show one mailbox in two orders.
    const staleGate = mkMsg({
      id: "stale-gate", folder: "ohmail/Screener", unread: true,
      date: APRIL, sortAt: iso(NOW), arrivedAt: iso(NOW),
    });
    const plainGate = mkMsg({
      id: "plain-gate", folder: "ohmail/Screener", unread: true,
      date: iso(daysAgo(1)), sortAt: iso(daysAgo(1)), arrivedAt: iso(daysAgo(1)),
    });
    const gate = [staleGate, plainGate];
    const seg = screenerSegments(readerOf(gate), NOW);
    const waiting = [...seg.waiting.values()].map((s) => s.id);
    expect(waiting.indexOf("stale-gate")).toBeLessThan(waiting.indexOf("plain-gate"));

    const inbox: EngineMessage[] = gate.map((m) => ({ ...m, folder: "INBOX" }));
    const v = ohboxView(readerOf(inbox));
    const order = v.newForYou.map((m) => m.id);
    expect(order.indexOf("stale-gate")).toBeLessThan(order.indexOf("plain-gate"));
  });

  it("arrivalMs prefers the clamped instant — the Resurfaced rank, badge and open target follow", () => {
    // Direct, because the resurfaced fixtures carry no sortAt: without this case the sortAt
    // branch in arrivalMs is a guard nobody has watched fail.
    expect(arrivalMs({ sortAt: iso(NOW), date: APRIL, arrivedAt: iso(NOW) })).toBe(NOW.getTime());
    expect(arrivalMs({ date: APRIL, arrivedAt: iso(NOW) })).toBe(Date.parse(APRIL));
    expect(arrivalMs({ date: null, arrivedAt: iso(NOW) })).toBe(NOW.getTime());
    expect(arrivalMs({ date: null })).toBeNull();
  });

  it("(e) rows without sortAt keep the pre-field order exactly — the header decides", () => {
    const a = mkMsg({ id: "old-a", date: iso(daysAgo(3)), unread: true });
    const b = mkMsg({ id: "old-b", date: iso(daysAgo(5)), unread: true });
    const v = ohboxView(readerOf([b, a]));
    expect(v.newForYou.map((m) => m.id)).toEqual(["old-a", "old-b"]);
  });
});

/**
 * AN EXISTING MAILBOX DOES NOT GET MESSED UP (owner rulings 2026-09-18): rows written before
 * mail 0119 carry no `sortAt`, so every existing mirror is this fixture on the day this ships.
 * What the UPDATE moves, pinned against the DEPLOYED 0.19.6 order (stamped rows by reading
 * stamp above an unstamped basement): READ ROWS RETURN TO CHRONOLOGICAL ORDER, AND NOTHING
 * ELSE — Earlier's membership is unchanged, no row vanishes or changes section, New for you
 * and Resurfaced are byte-identical. The intermediate own-instant fallback (the same day's
 * first fix) is stated below as `BASE_0119` for the record; the shipped 0.20.0 carries both
 * commits and a person updating from 0.19.6 sees exactly this diff.
 */
describe("an existing mailbox on update: read rows return to chronological order, nothing else", () => {
  const D = (s: string) => s;
  const rows: EngineMessage[] = [];
  const add = (m: EngineMessage) => { rows.push(m); return m; };
  seq = 500;
  const s1 = add(mkMsg({ id: "s1", date: D("2026-09-15T09:00:00.000Z"), lastReadAt: D("2026-09-17T10:00:00.000Z") }));
  const s2 = add(mkMsg({ id: "s2", date: D("2026-09-10T09:00:00.000Z"), lastReadAt: D("2026-09-16T10:00:00.000Z") }));
  const s3 = add(mkMsg({ id: "s3", date: D("2026-04-20T09:00:00.000Z"), lastReadAt: D("2026-09-14T10:00:00.000Z") }));
  // A folded conversation's two read members — the fold itself is the view's and unchanged.
  const c1 = add(mkMsg({ id: "c1", threadId: "t1", date: D("2026-09-12T09:00:00.000Z"), lastReadAt: D("2026-09-13T10:00:00.000Z") }));
  const c2 = add(mkMsg({ id: "c2", threadId: "t1", date: D("2026-09-11T09:00:00.000Z"), lastReadAt: null }));
  const far = add(mkMsg({ id: "far", date: D("2027-01-01T09:00:00.000Z"), lastReadAt: null }));
  const u1 = add(mkMsg({ id: "u1", date: D("2026-09-16T12:00:00.000Z"), lastReadAt: null }));
  const u2 = add(mkMsg({ id: "u2", date: D("2026-06-01T09:00:00.000Z"), lastReadAt: null }));
  const u3 = add(mkMsg({ id: "u3", date: D("2026-04-10T09:00:00.000Z"), lastReadAt: null }));
  const unreadA = add(mkMsg({ id: "unreadA", date: D("2026-09-18T08:00:00.000Z"), unread: true }));
  const unreadB = add(mkMsg({ id: "unreadB", date: D("2026-05-05T09:00:00.000Z"), unread: true }));
  const res = add(mkMsg({
    id: "res", date: D("2026-08-01T09:00:00.000Z"),
    triage: { messageId: "res", state: "resurfaced" as never, bubbleUpAt: null, setAt: D("2026-09-18T07:00:00.000Z"), updatedAt: D("2026-09-18T07:00:00.000Z") },
  }));
  void s1; void s2; void s3; void c1; void c2; void far; void u1; void u2; void u3; void unreadA; void unreadB; void res;

  /** The DEPLOYED 0.19.6 "Earlier": stamped by stamp desc, then EVERY unstamped row, date desc. */
  const DEPLOYED_0196 = ["s1", "s2", "s3", "c1", "far", "u1", "c2", "u2", "u3"];
  /** The same day's first fix (own-instant fallback), for the record — never shipped alone. */
  const BASE_0119 = ["far", "s1", "u1", "s2", "s3", "c1", "c2", "u2", "u3"];
  /** The ruled order: ONE chronology, `sortAt ?? date` desc — reading stamps position nothing. */
  const RULED = ["far", "u1", "s1", "c1", "c2", "s2", "u2", "s3", "u3"];

  it("read rows return to chronological order, and nothing else changes", () => {
    const v = ohboxView(readerOf(rows));
    // MUTATION WATCHED (mutation-control.sh, 2026-09-18): key the pile's sort on the reading
    // stamp again and this reads the DEPLOYED/BASE shapes back — red on the first element.
    expect(v.previouslySeen.map((m) => m.id)).toEqual(RULED);
    // The update moves ORDER alone: same membership as the deployed list, nothing vanished,
    // nothing changed section.
    expect(v.previouslySeen).toHaveLength(DEPLOYED_0196.length);
    expect(new Set(v.previouslySeen.map((m) => m.id))).toEqual(new Set(DEPLOYED_0196));
    // …and the ruled order is the mailbox's own chronology: strictly non-increasing arrival.
    const instants = v.previouslySeen.map((m) => arrivalMs(m)!);
    for (let i = 1; i < instants.length; i++) {
      expect(instants[i]!, `position ${i} out of arrival order`).toBeLessThanOrEqual(instants[i - 1]!);
    }
    void BASE_0119;
  });

  it("New for you and Resurfaced are byte-identical to the old order", () => {
    const v = ohboxView(readerOf(rows));
    expect(v.newForYou.map((m) => m.id)).toEqual(["unreadA", "unreadB"]);
    expect(v.resurfaced.map((m) => m.id)).toEqual(["res"]);
  });
});
