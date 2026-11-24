/**
 * THE CALENDAR'S ACTS ON A DEVICE: one overlay for the device's own acts and for the writes a record
 * says the provider has not taken, a selector that tells the two waits apart, and the queue that
 * makes an act durable before it is sent and sends it under one key until our server answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { CalendarEventAct, CalendarEventRecord, CalendarWriteAnswer, CalendarWriteMark } from "@ohmail/wire";
import { applyCalendarActs, CalendarActKeys, eventsWithWrites } from "../src/calendar-acts.js";
import { CALENDAR_OUTBOX_TYPE, CalendarWriteQueue, type CalendarWriteTransport } from "../src/calendar-writes.js";
import { IndexedDbMirrorStore, MemoryMirrorStore } from "../src/index.js";
import { MutationRejectedError } from "../src/types.js";

beforeEach(() => vi.stubGlobal("IDBKeyRange", IDBKeyRange));
afterEach(() => vi.unstubAllGlobals());

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
  it("lays the single changed occurrence over its own day and keeps the series times while a broader edit waits", () => {
    const at = String(Date.UTC(2026, 10, 18, 9));
    const child = record("occurrence", { recurrenceId: at });
    const act = {
      kind: "calendar_event_update" as const, eventId: child.id, base: BASE,
      scope: { kind: "occurrence" as const, at }, change: { title: "One firing" },
    };
    expect(applyCalendarActs([child], [act])[0]?.title).toBe("One firing");
    const seriesEdit = { ...act, scope: { kind: "record" as const }, base: `${BASE}/${BASE}`, change: { title: "New title for the series" } };
    expect(applyCalendarActs([child], [seriesEdit])[0]).toEqual(child);
    const keys = new CalendarActKeys();
    keys.stamp(act, "first");
    expect(keys.stamp(act, "next")).toEqual(act);
    expect(keys.stamp(seriesEdit, "whole")).toEqual(seriesEdit);
  });

  it("shows a queued scoped write on the changed occurrence the person acted on", () => {
    const at = String(Date.UTC(2026, 10, 18, 9));
    const master = record("master", { uid: "weekly", repeat: { rules: ["FREQ=DAILY"], added: [], excluded: [] } });
    const child = record("changed", { uid: master.uid, recurrenceId: at });
    const act = {
      kind: "calendar_event_update" as const, eventId: child.id, base: BASE,
      scope: { kind: "occurrence" as const, at }, change: { title: "One firing" },
    };
    expect(eventsWithWrites([{ ...master, writes: [mark(act)] }, child], []).at(1))
      .toMatchObject({ record: { title: "One firing" }, waiting: "provider" });
    expect(eventsWithWrites([{ ...master, writes: [mark(act, { state: "refused", reason: "version_stale" })] }, child], []).at(1))
      .toMatchObject({ record: { title: child.title }, waiting: null, refusal: "version_stale" });
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
    await vi.waitFor(() => expect(hung.asked.map((a) => a.key)).toEqual(["key-1"]));
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

it("keeps the delete durable and offline until the Undo window closes", async () => {
  vi.useFakeTimers();
  try {
    const store = new MemoryMirrorStore();
    await store.load();
    const event = record("e1");
    await store.applyChanges([{ type: "calendar_event", op: "create", id: event.id, entity: event, seq: 1, updatedAt: BASE }]);
    const { t, asked } = transport(async (act, key) => echo(record(act.eventId), key));
    let count = 0;
    const queue = new CalendarWriteQueue(store, t, { uuid: () => `key-${++count}`, now: Date.now });
    const act = { kind: "calendar_event_delete", eventId: event.id, base: BASE, scope: { kind: "record" } } as const;
    const first = await queue.holdDelete(act, 8000);
    expect(queue.owed()).toHaveLength(1);
    expect(queue.events()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(7999);
    expect(asked).toHaveLength(0);
    expect(await first.undo()).toBe(true);
    expect(queue.events().map(({ record }) => record.id)).toEqual([event.id]);
    await vi.advanceTimersByTimeAsync(1);
    expect(asked).toHaveLength(0);

    const second = await queue.holdDelete(act, 8000);
    await vi.advanceTimersByTimeAsync(8000);
    await queue.flush();
    expect(asked.map(({ key }) => key)).toEqual([second.key]);
    expect(await second.undo()).toBe(false);
    expect(queue.owed()).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});


it("honors Undo on disk even when another tab already loaded the deletion", async () => {
  const factory = new IDBFactory();
  const first = new IndexedDbMirrorStore({ owner: "acct-cal", factory });
  const second = new IndexedDbMirrorStore({ owner: "acct-cal", factory });
  const { t, asked } = transport(async (act, key) => echo(record(act.eventId), key));
  let now = 1;
  const opts = { uuid: () => "key-1", now: () => now };
  await first.load();
  const left = new CalendarWriteQueue(first, t, opts);
  const stopLeft = left.activate();
  const right = new CalendarWriteQueue(second, t, opts);
  try {
    const act = { kind: "calendar_event_delete", eventId: "e1", base: BASE, scope: { kind: "record" } } as const;
    const held = await left.holdDelete(act, 8000);
    await second.load();
    expect(right.owed().map(({ key }) => key)).toEqual([held.key]);
    await right.flush();
    now += 2000;
    expect(held.remainingMs()).toBe(6000);
    expect(await held.undo()).toBe(true);
    now += 8000;
    await right.flush();
    expect(asked).toEqual([]);
    expect(right.owed()).toEqual([]);
  } finally {
    stopLeft();
  }
});

it("wakes an offline calendar change on reconnect and sends it once under its original key", async () => {
  const store = new MemoryMirrorStore();
  await store.load();
  const online = new EventTarget();
  let connected = false;
  const accepted = vi.fn();
  const { t } = transport(async (act, key) => {
    if (!connected)
      throw new MutationRejectedError("offline", { status: null, code: "network", retryable: true });
    accepted(act, key);
    return echo(record(act.eventId), key);
  });
  const opts = { uuid: () => "key-1", now: Date.now, online };
  const queue = new CalendarWriteQueue(store, t, opts);
  const stop = queue.activate();
  try {
    const act: CalendarEventAct = {
      kind: "calendar_event_delete", eventId: "e1", base: BASE, scope: { kind: "record" },
      audience: { organizer: null, guests: [record("guest").uid] },
    };
    const { key } = await queue.press(act);
    await queue.flush();
    expect(queue.deviceActs()).toEqual([{ key, act }]);
    connected = true;
    online.dispatchEvent(new Event("online"));
    online.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(queue.owed()).toEqual([]), { timeout: 250 });
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledWith(act, key);
  } finally {
    stop();
  }
});


it("lets one tab dispatch an expired deletion even when both tabs wake at once", async () => {
  const factory = new IDBFactory();
  const first = new IndexedDbMirrorStore({ owner: "acct-cal", factory });
  const second = new IndexedDbMirrorStore({ owner: "acct-cal", factory });
  const { t, asked } = transport(async (act, key) => echo(record(act.eventId), key));
  let now = 1;
  const opts = { uuid: () => "key-1", now: () => now };
  const left = new CalendarWriteQueue(first, t, opts);
  const right = new CalendarWriteQueue(second, t, opts);
  const stopLeft = left.activate();
  const stopRight = right.activate();
  try {
    await first.load();
    const act = { kind: "calendar_event_delete", eventId: "e1", base: BASE, scope: { kind: "record" } } as const;
    const held = await left.holdDelete(act, 8000);
    await second.load();
    now += 8000;
    await Promise.all([left.flush(), right.flush()]);
    expect(asked.map(({ key }) => key)).toEqual([held.key]);
    expect(await held.undo()).toBe(false);
  } finally {
    stopLeft();
    stopRight();
  }
});

it("aborts an in-flight calendar request when its account leaves and keeps the original act owed", async () => {
  const store = new MemoryMirrorStore();
  await store.load();
  const send = vi.fn<CalendarWriteTransport["writeCalendar"]>((_act, _key, signal) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
  const t = { ...transport(async () => { throw new Error("not asked"); }).t, writeCalendar: send };
  const queue = new CalendarWriteQueue(store, t, { uuid: () => "key-1", now: Date.now });
  const stop = queue.activate();
  const act = update("e1", "Rescheduled");
  const { key } = await queue.press(act);
  const inFlight = queue.flush();
  expect(send).toHaveBeenCalledTimes(1);
  const signal = send.mock.calls[0]?.[2];
  stop();
  await inFlight;
  expect(signal?.aborted).toBe(true);
  expect(queue.deviceActs()).toEqual([{ key, act }]);
});


it("backs off temporary calendar refusals and keeps retrying the same press", async () => {
  vi.useFakeTimers();
  const store = new MemoryMirrorStore();
  await store.load();
  let tries = 0;
  const { t, asked } = transport(async (act, key) => {
    if (++tries < 3) throw new MutationRejectedError("temporarily unavailable", { status: 503, retryable: true });
    return echo(record(act.eventId), key);
  });
  const queue = new CalendarWriteQueue(store, t, { uuid: () => "key-1", now: Date.now });
  const stop = queue.activate();
  try {
    const { key } = await queue.press(update("e1", "Rescheduled"));
    await queue.flush();
    expect(asked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(asked).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(asked).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(asked.map((request) => request.key)).toEqual([key, key, key]);
    expect(queue.owed()).toEqual([]);
  } finally {
    stop();
    vi.useRealTimers();
  }
});


it("sends a closed tab's offline change once when the surviving tab reconnects", async () => {
  const factory = new IDBFactory();
  const writerStore = new IndexedDbMirrorStore({ owner: "acct-cal", factory, notices: () => null });
  const survivorStore = new IndexedDbMirrorStore({ owner: "acct-cal", factory, notices: () => null });
  await writerStore.load();
  await survivorStore.load();
  const online = new EventTarget();
  const offline = transport(async () => {
    throw new MutationRejectedError("offline", { code: "network", retryable: true });
  });
  const accepted = vi.fn(async (act: CalendarEventAct, key: string) => echo(record(act.eventId), key));
  const surviving = new CalendarWriteQueue(survivorStore, transport(accepted).t, {
    uuid: () => "survivor", now: Date.now, online,
  });
  const writing = new CalendarWriteQueue(writerStore, offline.t, { uuid: () => "original", now: Date.now });
  const stopSurviving = surviving.activate();
  const stopWriting = writing.activate();
  try {
    const act: CalendarEventAct = {
      kind: "calendar_event_delete", eventId: "e1", base: BASE, scope: { kind: "record" },
      audience: { organizer: null, guests: [record("guest").uid] },
    };
    const { key } = await writing.press(act);
    await vi.waitFor(() => expect(offline.asked.map((row) => row.key)).toEqual([key]));
    await writing.flush();
    stopWriting();
    writerStore.close();
    expect(surviving.owed()).toEqual([]);
    online.dispatchEvent(new Event("online"));
    online.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledTimes(1));
    await surviving.flush();
    expect(accepted).toHaveBeenCalledWith(act, key);
    expect(surviving.owed()).toEqual([]);
  } finally {
    stopWriting();
    stopSurviving();
    survivorStore.close();
  }
});


it("follows another tab's queue change, preserving its in-flight claim and clearing the waiting row", async () => {
  const factory = new IDBFactory();
  const writerStore = new IndexedDbMirrorStore({ owner: "acct-cal-notice", factory });
  const readerStore = new IndexedDbMirrorStore({ owner: "acct-cal-notice", factory });
  await writerStore.load();
  await readerStore.load();
  let finish = () => {};
  const { t, asked } = transport((act, key) => new Promise((resolve) => {
    finish = () => resolve(echo(record(act.eventId), key));
  }));
  const opts = { uuid: () => "shared", now: Date.now };
  const writer = new CalendarWriteQueue(writerStore, t, opts);
  const reader = new CalendarWriteQueue(readerStore, t, opts);
  const stopWriter = writer.activate();
  const stopReader = reader.activate();
  try {
    const { key } = await writer.press(update("e1", "Rescheduled"));
    await vi.waitFor(() => {
      expect(asked).toHaveLength(1);
      expect(reader.owed().map((row) => row.key)).toEqual([key]);
    });
    await reader.flush();
    expect(asked).toHaveLength(1);
    finish();
    await vi.waitFor(() => expect(reader.owed()).toEqual([]));
    expect(asked.map((a) => a.key)).toEqual([key]);
  } finally {
    finish();
    stopWriter();
    stopReader();
    await Promise.all([writer.flush(), reader.flush()]);
    writerStore.close();
    readerStore.close();
  }
});


it("retries storing a terminal Calendar refusal without sending the write again", async () => {
  vi.useFakeTimers();
  const store = new MemoryMirrorStore();
  await store.load();
  const commit = store.commitLocal.bind(store);
  let refuseCommit = true;
  const persist = vi.spyOn(store, "commitLocal").mockImplementation(async (puts, deletes) => {
    if (deletes.length > 0 && refuseCommit) {
      refuseCommit = false;
      throw new Error("storage temporarily unavailable");
    }
    await commit(puts, deletes);
  });
  const { t, asked } = transport(async () => {
    throw new MutationRejectedError("read only", { code: "calendar_read_only", retryable: false });
  });
  const queue = new CalendarWriteQueue(store, t, { uuid: () => "original", now: Date.now });
  const stop = queue.activate();
  try {
    const { key } = await queue.press(update("ev", "A new time"));
    await queue.flush();
    expect(queue.owed().map((row) => row.key)).toEqual([key]);
    expect(queue.result(key)).toBeNull();
    expect(asked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(queue.owed()).toEqual([]);
    expect(queue.result(key)).toEqual({ kind: "refused", word: "calendar_read_only" });
    expect(asked).toHaveLength(1);
  } finally {
    stop();
    persist.mockRestore();
    vi.useRealTimers();
  }
});


it("dispatches an expired deletion at the stored deadline even when its commit shortened the Undo window", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const factory = new IDBFactory();
  const writerStore = new IndexedDbMirrorStore({ owner: "acct-cal", factory, notices: () => null });
  const otherStore = new IndexedDbMirrorStore({ owner: "acct-cal", factory, notices: () => null });
  await writerStore.load();
  await otherStore.load();
  const commit = writerStore.commitLocal.bind(writerStore);
  const delayed = vi.spyOn(writerStore, "commitLocal").mockImplementation(async (puts, deletes) => {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    await commit(puts, deletes);
  });
  const sentAt: number[] = [];
  const writerWire = transport(async (act, key) => echo(record(act.eventId), key));
  const { t, asked } = transport(async (act, key) => {
    sentAt.push(Date.now());
    return echo(record(act.eventId), key);
  });
  const opts = { uuid: () => "deletion", now: Date.now };
  const writer = new CalendarWriteQueue(writerStore, writerWire.t, opts);
  const other = new CalendarWriteQueue(otherStore, t, opts);
  const stopWriter = writer.activate();
  const stopOther = other.activate();
  try {
    const pressedAt = Date.now();
    const waiting = writer.holdDelete({ kind: "calendar_event_delete", eventId: "ev", base: BASE, scope: { kind: "record" } }, 8000);
    await vi.advanceTimersByTimeAsync(4000);
    const held = await waiting;
    expect(held.deadline).toBe(pressedAt + 8000);
    expect(held.remainingMs()).toBe(4000);
    await writer.flush();
    writer.suspend();
    await other.flush();
    await vi.advanceTimersByTimeAsync(3999);
    expect(sentAt).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await held.undo()).toBe(false);
    await other.flush();
    await writer.flush();
    expect(writerWire.asked).toEqual([]);
    expect(sentAt).toEqual([held.deadline]);
    expect(asked.map(({ key }) => key)).toEqual([held.key]);
  } finally {
    stopWriter();
    stopOther();
    delayed.mockRestore();
    writerStore.close();
    otherStore.close();
    vi.useRealTimers();
  }
});

it("holds a proposal for Undo and sends it without overlaying or writing the event", async () => {
  vi.useFakeTimers();
  try {
    const store = new MemoryMirrorStore();
    await store.load();
    const event = record("meeting");
    await store.applyChanges([{ type: "calendar_event", op: "create", id: event.id, entity: event, seq: 1, updatedAt: BASE }]);
    const { t, asked } = transport(async (act, key) => echo(record(act.eventId), key));
    const mailProposal = vi.fn(async () => ({ answer: { write: null, events: [] }, seq: null }));
    let count = 0;
    const queue = new CalendarWriteQueue(store, { ...t, mailProposal }, { uuid: () => `proposal-${++count}`, now: Date.now });
    const act = {
      kind: "calendar_event_propose", recordId: event.id, base: BASE, occurrence: "",
      start: { kind: "instant", value: "20261118T120000Z" },
      end: { kind: "instant", value: "20261118T130000Z" },
    } as const;

    const cancelled = await queue.hold(act, 8000);
    expect(queue.events()[0]?.record).toEqual(event);
    await vi.advanceTimersByTimeAsync(7999);
    expect(mailProposal).not.toHaveBeenCalled();
    expect(await cancelled.undo()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(mailProposal).not.toHaveBeenCalled();

    const sent = await queue.hold(act, 8000);
    await vi.advanceTimersByTimeAsync(8000);
    await queue.flush();
    expect(mailProposal).toHaveBeenCalledWith(act, sent.key, expect.any(AbortSignal));
    expect(mailProposal).toHaveBeenCalledTimes(1);
    expect(await sent.undo()).toBe(false);
    expect(asked).toEqual([]);
    expect(queue.events()[0]?.record).toEqual(event);
  } finally {
    vi.useRealTimers();
  }
});
