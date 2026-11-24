/**
 * THE CALENDAR'S RECORD, FROM THE PAGE TO THE NATIVE MODULE'S HANDS. Over the real page bridge, the real native host
 * with its guard, and the real door; the native module is a recorder.
 *
 *  · the record is read closed, by the contract's own reader, over one table of cases that the native twins are
 *    held to as well (`calendar-snapshot-cases.json`): a record with a member too many or too few, one out of its
 *    range or of another word is refused whole, and what is read is a copy, a title cleaned once more;
 *  · the bridge's guard refuses such a record as malformed, and an act with a key beside its own;
 *  · native is handed the pairing and the copy as one JSON text, only while the session stands, for its own scope,
 *    and a build without the module keeps nothing.
 *
 * The Kotlin twin runs over the same table on a JVM, outside this suite, in the change that made it; the Swift twin is
 * written to the same rules and owed to a simulator.
 */
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbMirrorStore, readCalendarSnapshot } from "@ohmail/client-engine";
import { describe, expect, it } from "vitest";
import { redirectSystemPath } from "../app/+native-intent";
import { watchWidgetLinks, widgetGeneration } from "../src/calendar/opened";
import { snapshotDoor, type SnapshotDoorDeps } from "../src/calendar/snapshot-door";
import type { CalendarNative } from "../src/calendar/calendar-port";
import { BridgeHost } from "../src/shell/bridge-host";
import { readRequest } from "../src/shell/bridge-kinds";
import { createBridge, type Bridge } from "../web/src/bridge";
import { calendarPublisher, calendarRecordClearer, calendarRecordSender, followWidget, snapshotFromMirror, widgetEventFragment } from "../web/src/calendar-record";
import { storedWidgetChoices } from "../web/src/notices";
import type { PagePort } from "../web/src/port";
import table from "./calendar-snapshot-cases.json";

interface Row { readonly name: string; readonly reads: boolean; readonly record: unknown; readonly copy?: unknown }
const ROWS = table.rows as readonly Row[];
const FIRST = ROWS.find((r) => r.reads)!;
const SCOPE = (FIRST.record as { scope: string }).scope;
/** Two pairings, by their local ids. */
const A = "pmb3k2x9aq1z7";

describe("the record, read closed by the contract's reader, over the table the native twins read", () => {
  it("holds every case: reads exactly the records it should, and nothing else", () => {
    expect(ROWS.filter((r) => r.reads).length).toBeGreaterThanOrEqual(10);
    expect(ROWS.filter((r) => !r.reads).length).toBeGreaterThanOrEqual(40);
    for (const row of ROWS) expect(readCalendarSnapshot(row.record) !== null, row.name).toBe(row.reads);
  });

  it("answers a copy, member for member in the record's order, a title cleaned once more", () => {
    for (const row of ROWS.filter((r) => r.reads)) {
      const copy = readCalendarSnapshot(row.record);
      expect(JSON.stringify(copy), row.name).toBe(JSON.stringify(row.copy ?? row.record));
      expect(copy, row.name).not.toBe(row.record);
    }
  });
});

describe("the bridge's guard", () => {
  const head = { id: 1, epoch: "e1", kind: "act", act: "calendar.snapshot" };

  it("lets through the act with a record that reads, and refuses each one that does not as malformed", () => {
    for (const row of ROWS) {
      const read = readRequest({ ...head, snapshot: row.record });
      if (row.reads) expect(read, row.name).toMatchObject({ kind: "act", act: "calendar.snapshot" });
      else expect(read, row.name).toEqual({ refused: "malformed" });
    }
  });

  it("refuses the act with a key beside its own, and without its record", () => {
    expect(readRequest({ ...head, snapshot: FIRST.record, scope: SCOPE })).toEqual({ refused: "malformed" });
    expect(readRequest({ ...head, snapshot: FIRST.record, pairing: A })).toEqual({ refused: "malformed" });
    expect(readRequest({ ...head })).toEqual({ refused: "malformed" });
    expect(readRequest({ ...head, record: FIRST.record })).toEqual({ refused: "malformed" });
  });
});

/** The calendar's module as a recorder: every call it was asked, and what it answers. */
function recordingCalendar(answer: () => boolean | Promise<boolean> = () => true) {
  const kept: [string, string][] = [];
  const native: Pick<CalendarNative, "keep"> = {
    keep: async (pairing, record) => { kept.push([pairing, record]); return answer(); },
  };
  return { native, kept };
}

/** The page's bridge joined to the native end, the act answered by the door: the platform's channel the one double. */
function pageOver(deps: SnapshotDoorDeps): Bridge {
  const door = snapshotDoor(deps);
  const toPage = new Set<(text: string) => void>();
  const host = new BridgeHost({
    post: (_epoch, text) => queueMicrotask(() => toPage.forEach((take) => take(text))),
    config: () => null,
    http: { request: async () => ({ refused: "notReady" as const }) } as never,
    act: async (a) => {
      if (a.act === "calendar.snapshot") return door.keep(a.snapshot, a.publication);
      if (a.act === "calendar.clear") return door.clear(a.publication);
      if (a.act === "calendar.resolve") return door.target(a.generation);
      return {};
    },
    openHeld: async () => false,
    ready: () => {},
    place: () => {},
    note: () => {},
    oldCopy: { page: async () => ({ refused: "notReady" as const }), done: async () => ({ refused: "notReady" as const }) },
    app: "ohcal",
  });
  host.begin("e1");
  const port: PagePort = {
    post: (text) => host.receive({ epoch: "e1", origin: "https://appassets.androidplatform.net", mainFrame: true, data: text }),
    listen: (take) => (toPage.add(take), () => void toPage.delete(take)),
  };
  return createBridge(port, "e1");
}

function phone(over: Partial<SnapshotDoorDeps> = {}) {
  const made = recordingCalendar();
  const deps: SnapshotDoorDeps = { native: made.native, instance: A, scope: () => SCOPE, live: () => true, ...over };
  return { ...made, deps };
}

const expectedStoredText = (record: unknown) => JSON.stringify(record, (key, value) =>
  key === "label" && value?.as === "title" ? { as: "event" } : value,
);

describe("what native is handed", () => {
  it("the pairing and the copy as one JSON text: every record that reads, cleaned, and nothing else", async () => {
    const p = phone();
    const send = calendarRecordSender(pageOver(p.deps));
    for (const row of ROWS.filter((r) => r.reads && (r.record as { scope: string }).scope === SCOPE)) {
      await expect(send(row.record as never), row.name).resolves.toBe("kept");
    }
    expect(p.kept.length).toBe(ROWS.filter((r) => r.reads).length);
    for (const [i, row] of ROWS.filter((r) => r.reads).entries()) {
      expect(p.kept[i]![0]).toBe(A);
      expect(p.kept[i]![1], row.name).toBe(expectedStoredText(row.copy ?? row.record));
    }
  });

  it("replaces the phone's kept record when sync downgrades a shared calendar in place", async () => {
    const now = Date.UTC(2026, 10, 16, 8);
    const updatedAt = new Date(now).toISOString();
    const factory = new IDBFactory();
    const store = new IndexedDbMirrorStore({ owner: SCOPE, factory });
    await store.load();
    const calendar = { id: "shared-calendar", shown: true, access: "reader", defaultAlarms: [] };
    const event = {
      id: "shared-event", calendarId: calendar.id, uid: "shared-event", recurrenceId: "",
      thisAndFuture: false, sequence: 0, status: "confirmed", title: "Budget meeting",
      place: "Room twelve", notes: "Renewal discussion", callLink: null,
      start: { kind: "instant", value: "20261116T090000Z" },
      end: null, duration: "PT30M", startsAt: "2026-11-16T09:00:00.000Z",
      endsAt: "2026-11-16T09:30:00.000Z", occurrenceAt: null, repeat: null,
      busy: true, private: false, organizer: { address: "organizer", name: "Organizer" },
      myAnswer: "none", heldBack: false, invitees: [{ address: "guest" }],
      alarms: [{ minutesBefore: 10, method: "notice" }], writes: [], cut: false, updatedAt,
    };
    await store.applyChanges([
      { seq: 1, type: "calendar", id: calendar.id, op: "create", entity: calendar, updatedAt },
      { seq: 2, type: "calendar_event", id: event.id, op: "create", entity: event, updatedAt },
    ]);
    const choices = (explicit: boolean) => storedWidgetChoices({
      getItem: (key) => key === "ohmail.notices.calendar" && explicit ? '{"showTitles":true}' : null,
    });
    let live = true;
    const current = "00000001-0000-4000-8000-000000000000";
    const stale = "00000002-0000-4000-8000-000000000000";
    const target = { event: event.id, startMs: Date.UTC(2026, 10, 16, 9) };
    const p = phone({ live: () => live });
    const bridge = pageOver({
      ...p.deps, native: { ...p.native, clear: async () => true, target: (id, generation) =>
        id === A && generation === current ? target : null },
    });
    const publish = calendarPublisher(calendarRecordSender(bridge), calendarRecordClearer(bridge));
    const latest = () => readCalendarSnapshot(JSON.parse(p.kept.at(-1)![1]))!;
    const opened: string[] = [];
    const resolve = async (generation: string) => (await bridge.request("act", {
      act: "calendar.resolve", generation,
    })).widget;
    const go = (generation: string, refresh = async () => {}) =>
      followWidget(generation, resolve, refresh, store, "UTC", (fragment) => opened.push(fragment));

    await publish(snapshotFromMirror(store, SCOPE, "UTC", choices(false), now));
    expect(store.get("calendar_event", event.id)).toMatchObject({ title: event.title, place: event.place, notes: event.notes });
    expect(latest().days[0]!.events[0]).toMatchObject({ label: { as: "event" }, toAnswer: true });
    expect(latest().alerts[0]?.label).toEqual({ as: "event" });
    await publish(snapshotFromMirror(store, SCOPE, "UTC", choices(true), now));
    expect(latest().alerts[0]?.label).toEqual({ as: "event" });
    expect(JSON.stringify(latest())).not.toContain(event.title);
    // Both the Android immutable intent and the iOS widget URL carry this form.
    for (const scheme of ["ohcal", "ohcal-preview"]) {
      const path = `${scheme}://calendar-widget/${current}`;
      expect(widgetGeneration(path, scheme)).toBe(current);
      expect(redirectSystemPath({ path, initial: true })).toBe("/");
      const generations: string[] = [];
      const off = watchWidgetLinks((generation) => generations.push(generation));
      off();
      expect(generations).toEqual([current]);
      await go(generations[0]!);
    }
    expect(redirectSystemPath({ path: `ohcal://calendar-widget/${stale}`, initial: false })).toBe("");
    const offHot = watchWidgetLinks((generation) => expect(generation).toBe(stale));
    offHot();
    await go(stale);
    await go(current, async () => { throw new Error("offline"); });
    expect(opened).toEqual(["#/cal/day/2026-11-16/e/shared-event", "#/cal/day/2026-11-16/e/shared-event"]);
    expect(widgetEventFragment(store, "UTC", { ...target, startMs: target.startMs + 60_000 })).toBeNull();

    await store.applyResponse({
      cursor: "3", hasMore: false, serverTime: updatedAt,
      changes: {
        creates: [], moves: [], deletes: [],
        updates: [{ seq: 3, type: "calendar", id: calendar.id, op: "update", entity: { ...calendar, access: "busy" }, updatedAt }],
      },
    });
    await go(current);
    expect(opened).toHaveLength(2);
    store.close();
    const reopened = new IndexedDbMirrorStore({ owner: SCOPE, factory });
    await reopened.load();
    expect(reopened.getCursor()).toBe("3");
    expect(reopened.get("calendar_event", event.id)).toMatchObject({
      title: "", place: null, notes: null, invitees: [], organizer: null, myAnswer: null, alarms: [],
    });
    await publish(snapshotFromMirror(reopened, SCOPE, "UTC", choices(true), now));
    reopened.close();
    expect(p.kept.at(-1)![0]).toBe(A);
    expect(latest().days[0]!.events).toMatchObject([{ label: { as: "busy" }, toAnswer: false }]);
    expect(latest().alerts).toEqual([]);
    expect(latest().toAnswer).toBe(0);
    expect(p.kept.at(-1)![1]).not.toContain(event.title);

    live = false;
    await publish(snapshotFromMirror(null, SCOPE, "UTC", choices(true), now));
    await go(current);
    expect(opened).toHaveLength(2);
    expect(p.kept).toHaveLength(2);
  });

  it("the door strips titles while preserving the rest of its own closed copy", async () => {
    for (const row of ROWS.filter((r) => r.copy !== undefined)) {
      const p = phone();
      await expect(snapshotDoor(p.deps).keep(row.record), row.name).resolves.toEqual({ calendar: "kept" });
      expect(p.kept, row.name).toEqual([[A, expectedStoredText(row.copy)]]);
    }
  });

  it("nothing for a record that does not read: refused on the page, and refused at the door if it is sent", async () => {
    const p = phone();
    const send = calendarRecordSender(pageOver(p.deps));
    for (const row of ROWS.filter((r) => !r.reads)) await expect(send(row.record as never), row.name).resolves.toBe("refused");
    for (const row of ROWS.filter((r) => !r.reads)) {
      await expect(snapshotDoor(p.deps).keep(row.record), row.name).resolves.toEqual({ refused: "malformed" });
    }
    expect(p.kept).toEqual([]);
  });

  it("nothing for a session that no longer stands, a pairing that is not minted, or another account's scope", async () => {
    for (const over of [
      { live: () => false },
      { instance: "default" },
      { instance: `${A}\n` },
      { scope: () => "p00000000000000000000000000000000" },
      { scope: () => null },
    ] satisfies Partial<SnapshotDoorDeps>[]) {
      const p = phone(over);
      await expect(calendarRecordSender(pageOver(p.deps))(FIRST.record as never), JSON.stringify(over)).resolves.toBe("denied");
      expect(p.kept, JSON.stringify(over)).toEqual([]);
    }
  });

  it("nothing kept in a build without the calendar's native side", async () => {
    await expect(calendarRecordSender(pageOver(phone({ native: null }).deps))(FIRST.record as never)).resolves.toBe("unsupported");
  });

  it("denied where native refuses or fails, and the page never throws", async () => {
    for (const answer of [() => false, () => { throw new Error("gone"); }]) {
      const p = phone({ native: recordingCalendar(answer).native });
      await expect(calendarRecordSender(pageOver(p.deps))(FIRST.record as never)).resolves.toBe("denied");
    }
    const broken = { request: async () => { throw new Error("the page is going away"); } } as unknown as Bridge;
    await expect(calendarRecordSender(broken)(FIRST.record as never)).resolves.toBe("refused");
  });
});

it("revokes the visible widget and scheduled reminder before a replacement that fails or completes late", async () => {
  const baseline = readCalendarSnapshot(FIRST.record)!;
  let visible: string | null = "Previous details";
  let scheduled = true;
  let finish: (answer: "denied") => void = () => {};
  let began: () => void = () => {};
  const started = new Promise<void>((resolve) => { began = resolve; });
  const replace = () => new Promise<"denied">((resolve) => { finish = resolve; began(); });
  const clear = async () => { visible = null; scheduled = false; return "kept" as const; };
  const publish = calendarPublisher(replace, clear);
  const write = publish(baseline);
  await started;
  expect([visible, scheduled]).toEqual([null, false]);
  finish("denied");
  await write;
  expect([visible, scheduled]).toEqual([null, false]);
});

it("revokes an in-flight replacement when a newer calendar projection is unavailable", async () => {
  const record = readCalendarSnapshot(FIRST.record)!;
  let permit: string | undefined;
  let saved = false;
  let scheduled = false;
  let began: () => void = () => {};
  let finish: () => void = () => {};
  const started = new Promise<void>((resolve) => { began = resolve; });
  const delayed = new Promise<void>((resolve) => { finish = resolve; });
  const publish = calendarPublisher(
    async (_record, generation) => {
      began();
      await delayed;
      if (permit !== generation) return "denied";
      saved = true;
      scheduled = true;
      return "kept";
    },
    async (generation) => {
      permit = generation;
      saved = false;
      scheduled = false;
      return "kept";
    },
  );
  const old = publish(record);
  await started;
  await publish(null);
  finish();
  await old;
  expect([saved, scheduled]).toEqual([false, false]);
});

it("strips a well-formed title from every label before handing the snapshot to private native storage", async () => {
  const row = ROWS.find((entry) => entry.copy !== undefined)!;
  const p = phone();
  await expect(snapshotDoor(p.deps).keep(row.record)).resolves.toEqual({ calendar: "kept" });
  const snapshot = readCalendarSnapshot(JSON.parse(p.kept[0]![1]))!;
  expect([...snapshot.alerts, ...snapshot.days.flatMap((day) => day.events)].some(({ label }) => label.as === "title")).toBe(false);
});
