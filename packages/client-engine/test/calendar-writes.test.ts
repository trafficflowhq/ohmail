/**
 * THE CALENDAR'S ACTS ON A DEVICE: one overlay for the device's own acts and for the writes a record
 * says the provider has not taken, a selector that tells the two waits apart, and the queue that
 * makes an act durable before it is sent and sends it under one key until our server answers.
 */
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { CalendarEventAct, CalendarEventRecord, CalendarWriteAnswer, CalendarWriteMark } from "@ohmail/wire";
import { applyCalendarActs, eventsWithWrites } from "../src/calendar-acts.js";
import { CALENDAR_OUTBOX_TYPE, CalendarWriteQueue, type CalendarWriteTransport } from "../src/calendar-writes.js";
import { IndexedDbMirrorStore, MemoryMirrorStore } from "../src/index.js";
import { MutationRejectedError } from "../src/types.js";

const BASE = "2026-11-15T09:00:00.000Z";

function record(id: string, over: Partial<CalendarEventRecord> = {}): CalendarEventRecord {
  return {
    id, calendarId: "cal-1", uid: `${id}@example.test`, recurrenceId: "", thisAndFuture: false, sequence: 0, status: "confirmed",
    title: "Kiln check", notes: null, place: null, callLink: null,
    start: { kind: "instant", value: "20261118T090000Z" }, end: { kind: "instant", value: "20261118T100000Z" }, duration: null,
    startsAt: "2026-11-18T09:00:00.000Z", endsAt: "2026-11-18T10:00:00.000Z", occurrenceAt: null, repeat: null, busy: true, private: false,
    organizer: null, myAnswer: null, heldBack: false, invitees: [], alarms: [], cut: false, writes: [], updatedAt: BASE, ...over,
  };
}
const update = (eventId: string, title: string): CalendarEventAct =>
  ({ kind: "calendar_event_update", eventId, base: BASE, scope: { kind: "record" }, change: { title } });
const create = (eventId: string, title = "Glaze firing"): CalendarEventAct => ({
  kind: "calendar_event_create", eventId, calendarId: "cal-1",
  event: {
    title, start: { kind: "zoned", value: "20261117T090000", zone: "Europe/Zurich" }, end: { kind: "zoned", value: "20261117T100000", zone: "Europe/Zurich" },
    notes: null, place: "Studio 2", callLink: null, busy: true, private: false, repeat: null, invitees: [], alarms: [15],
  },
});
const mark = (act: CalendarEventAct, over: Partial<CalendarWriteMark> = {}): CalendarWriteMark =>
  ({ id: "w-1", key: "k-1", state: "pending", reason: null, act, part: null, at: BASE, ...over });

describe("the one overlay", () => {
  it("lays acts over records in order: a new event appears, a change is written, a removal takes it out, a move and an answer are the account's", () => {
    const shown = applyCalendarActs([record("e1"), record("e2")], [
      create("e3"), update("e1", "Kiln check, moved"), { kind: "calendar_event_delete", eventId: "e2", base: BASE, scope: { kind: "record" } },
      { kind: "calendar_event_move", eventId: "e1", base: BASE, toCalendarId: "cal-2" },
      { kind: "calendar_event_answer", eventId: "e3", base: BASE, scope: { kind: "record" }, answer: "tentative" },
    ]);
    expect(shown.map((r) => [r.id, r.title, r.calendarId, r.myAnswer])).toEqual([
      ["e1", "Kiln check, moved", "cal-2", null], ["e3", "Glaze firing", "cal-1", "tentative"],
    ]);
    // A new event in a zone is placed at its moment: 09:00 in Zurich in November is 08:00 UTC.
    expect([shown[1]!.startsAt, shown[1]!.endsAt, shown[1]!.alarms]).toEqual(["2026-11-17T08:00:00.000Z", "2026-11-17T09:00:00.000Z", [{ minutesBefore: 15, method: "notice" }]]);
  });

  it("does not lay an act on one day of a series over the record", () => {
    const act: CalendarEventAct = { kind: "calendar_event_update", eventId: "e1", base: BASE, scope: { kind: "occurrence", at: "1763456400000" }, change: { title: "x" } };
    expect(applyCalendarActs([record("e1")], [act])[0]!.title).toBe("Kiln check");
  });
});

describe("the selector", () => {
  it("tells a write waiting on this device from one waiting at the provider, and shows a refused one beside the provider's copy", () => {
    const records = [
      record("at-provider", { writes: [mark(update("at-provider", "Mine"))] }),
      record("refused", { title: "Theirs", writes: [mark(update("refused", "Mine"), { id: "w-9", state: "refused", reason: "version_stale" })] }),
      record("quiet"),
    ];
    const shown = eventsWithWrites(records, [{ key: "k-2", act: update("quiet", "On the device") }, { key: "k-3", act: create("new-one") }]);
    expect(shown.map((e) => [e.record.id, e.record.title, e.waiting, e.refusal, e.refusedWriteId])).toEqual([
      ["at-provider", "Mine", "provider", null, null],
      ["refused", "Theirs", null, "version_stale", "w-9"],
      ["quiet", "On the device", "device", null, null],
      ["new-one", "Glaze firing", "device", null, null],
    ]);
  });
});

/** A transport that answers from the test's hand and records every key it was asked under. */
function transport(answer: (act: CalendarEventAct, key: string) => Promise<{ answer: CalendarWriteAnswer; seq: number | null }>) {
  const asked: { kind: string; key: string; after: string | undefined }[] = [];
  const t: CalendarWriteTransport = {
    async writeCalendar(act, key) {
      asked.push({ kind: act.kind, key, after: "after" in act ? act.after : undefined });
      return answer(act, key);
    },
    async retryCalendarWrite() { throw new Error("not asked"); },
    async dismissCalendarWrite() { throw new Error("not asked"); },
  };
  return { t, asked };
}

const echo = (r: CalendarEventRecord, key: string): { answer: CalendarWriteAnswer; seq: number } =>
  ({ answer: { write: { id: "w-1", key, state: "pending", reason: null }, events: [r] }, seq: 7 });

describe("the queue on a device", () => {
  it("makes an act durable before it is sent, and sends it again after a reload under the same key", async () => {
    const factory = new IDBFactory();
    const first = new IndexedDbMirrorStore({ owner: "acct-cal", factory });
    await first.load();
    let release: () => void = () => undefined;
    const hung = transport(() => new Promise((_, reject) => { release = () => reject(new MutationRejectedError("offline", { status: null, code: null, retryable: true })); }));
    const keys = ["key-1"];
    const q1 = new CalendarWriteQueue(first, hung.t, { uuid: () => keys.shift()!, now: () => 1 });
    await q1.press(create("e1"));
    expect(hung.asked.map((a) => a.key)).toEqual(["key-1"]);
    release();
    await q1.flush();
    // Reloaded: a new store over the same database, a new queue.
    const second = new IndexedDbMirrorStore({ owner: "acct-cal", factory });
    await second.load();
    const ok = transport(async (act, key) => echo(record("e1", { title: "Glaze firing", writes: [mark(act, { key })] }), key));
    const q2 = new CalendarWriteQueue(second, ok.t, { uuid: () => "never", now: () => 2 });
    expect(q2.owed().map((r) => r.key)).toEqual(["key-1"]);
    await q2.flush();
    expect(ok.asked.map((a) => a.key)).toEqual(["key-1"]);
    expect(second.entries(CALENDAR_OUTBOX_TYPE).filter((e) => e.entity !== null)).toEqual([]);
  });

  it("sends in the order pressed, each act under its own key, an act on an event naming this session's previous one", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    const { t, asked } = transport(async (act, key) => echo(record(act.eventId), key));
    let n = 0;
    const q = new CalendarWriteQueue(store, t, { uuid: () => `key-${++n}`, now: () => 1 });
    await q.press(update("e1", "One"));
    await q.press(update("e1", "Two"));
    await q.press(update("e2", "Other"));
    await q.flush();
    expect(asked).toEqual([
      { kind: "calendar_event_update", key: "key-1", after: undefined },
      { kind: "calendar_event_update", key: "key-2", after: "key-1" },
      { kind: "calendar_event_update", key: "key-3", after: undefined },
    ]);
  });

  it("lays our server's answer in at once, so the view passes from the device's wait to the provider's without a gap", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([{ type: "calendar_event", op: "create", id: "e1", entity: record("e1"), seq: 3, updatedAt: BASE }]);
    let answer: () => void = () => undefined;
    const { t } = transport((act, key) => new Promise((resolve) => {
      answer = () => resolve(echo(record("e1", { writes: [mark(act, { key })] }), key));
    }));
    const q = new CalendarWriteQueue(store, t, { uuid: () => "key-1", now: () => 1 });
    await q.press(update("e1", "Mine"));
    expect(q.events().map((e) => [e.record.title, e.waiting])).toEqual([["Mine", "device"]]);
    answer();
    await q.flush();
    expect(q.events().map((e) => [e.record.title, e.waiting])).toEqual([["Mine", "provider"]]);
  });

  it("lets an act our server refused go and says why beside its event; one it could not take now stays, and nothing behind it is sent", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([{ type: "calendar_event", op: "create", id: "e1", entity: record("e1"), seq: 3, updatedAt: BASE }]);
    const refusing = transport(async () => { throw new MutationRejectedError("read only", { status: 409, code: "calendar_read_only", retryable: false }); });
    const q = new CalendarWriteQueue(store, refusing.t, { uuid: () => "key-1", now: () => 1 });
    await q.press(update("e1", "Mine"));
    await q.flush();
    expect(q.owed()).toEqual([]);
    expect(q.events().map((e) => [e.record.title, e.waiting, e.refusal])).toEqual([["Kiln check", null, "calendar_read_only"]]);

    const busy = transport(async () => { throw new MutationRejectedError("busy", { status: 503, code: "db_busy", retryable: true }); });
    let n = 0;
    const q2 = new CalendarWriteQueue(store, busy.t, { uuid: () => `b-${++n}`, now: () => 2 });
    await q2.press(update("e1", "Later"));
    await q2.press(update("e1", "Later still"));
    await q2.flush();
    expect(q2.owed().map((r) => r.key)).toEqual(["b-1", "b-2"]);
    expect(busy.asked.filter((a) => a.key === "b-2")).toEqual([]);
  });
});
