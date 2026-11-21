/**
 * THE ONE PRESS SEAM over the real queue and a scripted door: a sentence only after our server's verdict, the
 * refusal's own word, nothing while the press is still owed, and the verdict of a press the queue tracks by no event.
 */
import { describe, expect, it, vi } from "vitest";
import {
  IndexedDbMirrorStore,
  MemoryMirrorStore,
  MutationRejectedError,
  type MirrorStore,
} from "@ohmail/client-engine";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { CalendarWriteTransport } from "@ohmail/client-engine/calendar-writes";
import type { CalendarAct, CalendarWriteAnswer } from "@ohmail/wire";
import { calendarPortOf, calendarRefusalSentence, pressAndHear } from "../../src/calendar/index.js";

const PRESSED_AT = Date.UTC(2026, 10, 16, 9);
type Answer = { answer: CalendarWriteAnswer; seq: number | null };

function portOver(
  door: (key: string) => Promise<Answer>,
  store: MirrorStore = new MemoryMirrorStore(),
  now: () => number = () => PRESSED_AT,
) {
  let n = 0;
  const transport: CalendarWriteTransport = {
    writeCalendar: (_act, key) => door(key),
    retryCalendarWrite: (_id, key) => door(key),
    dismissCalendarWrite: (_id, key) => door(key),
  };
  return calendarPortOf({
    engine: { store, subscribe: () => () => undefined, read: () => ({ version: () => 0 }) } as never,
    transport,
    clock: { uuid: () => `key-${++n}`, now },
    settings: async () => ({
      enabledAt: null,
      secondZone: null,
      weekNumbers: false,
      dayFromMinute: null,
      dayToMinute: null,
      newEventsCalendarId: null,
    }),
    held: () => ({ window: { daysBack: 30, daysAhead: 365, maxRows: 5000 }, loaded: [] }),
    load: "none",
  });
}

const create: CalendarAct = {
  kind: "calendar_event_create",
  eventId: "ev-new",
  calendarId: "cal-1",
  event: {
    title: "Glaze firing",
    start: { kind: "zoned", value: "20261117T090000", zone: "Europe/Zurich" },
    end: { kind: "zoned", value: "20261117T100000", zone: "Europe/Zurich" },
    notes: null,
    place: null,
    callLink: null,
    busy: true,
    private: false,
    repeat: null,
    invitees: [],
    alarms: [],
  },
};
const retry: CalendarAct = { kind: "calendar_write_retry", writeId: "w-9" };

describe("a press and what is said of it", () => {
  it("says the act's own sentence once our server has taken it", async () => {
    const port = portOver(async (key) => ({
      answer: { write: { id: "w-1", key, state: "pending", reason: null }, events: [] },
      seq: null,
    }));
    const heard = await pressAndHear(port, create);
    expect(heard.say).toBe("taken.create");
    expect(heard.verdict).toEqual({
      kind: "taken",
      write: { id: "w-1", key: heard.key, state: "pending", reason: null },
    });
  });

  it("says the refusal's word, and the press leaves nothing behind on the device", async () => {
    const port = portOver(async () => {
      throw new MutationRejectedError("read only", {
        status: 409,
        code: "calendar_read_only",
        retryable: false,
        details: { calendarId: "cal-1" },
      });
    });
    const heard = await pressAndHear(port, create);
    expect(heard.say).toBe("refusal.readOnly");
    expect(heard.verdict).toEqual({
      kind: "refused",
      word: "calendar_read_only",
      details: { calendarId: "cal-1" },
    });
    expect(port.events().map((e) => e.record.id)).toEqual([]);
  });

  it("says no sentence before our server has answered, and its word once it has", async () => {
    let answer = (): void => undefined;
    const port = portOver(
      () =>
        new Promise<Answer>((_, refuse) => {
          answer = () =>
            refuse(
              new MutationRejectedError("full", {
                status: 429,
                code: "calendar_writes_full",
                retryable: false,
              }),
            );
        }),
    );
    let heard: Awaited<ReturnType<typeof pressAndHear>> | null = null;
    const pressing = pressAndHear(port, create).then((h) => (heard = h));
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    expect(heard).toBeNull();
    answer();
    await pressing;
    expect(heard).toMatchObject({ say: "refusal.full" });
  });

  it("says nothing while the press is still owed, and keeps it to be sent again", async () => {
    const port = portOver(async () => {
      throw new MutationRejectedError("offline", { status: null, code: null, retryable: true });
    });
    const heard = await pressAndHear(port, create);
    expect(heard).toMatchObject({ verdict: null, say: null });
    expect(port.events().map((e) => [e.record.id, e.waiting])).toEqual([["ev-new", "device"]]);
  });

  it("keeps the verdict of a refused retry, which names no event", async () => {
    const port = portOver(async () => {
      throw new MutationRejectedError("left", { status: 409, code: "calendar_write_left", retryable: false });
    });
    expect((await pressAndHear(port, retry)).say).toBe("refusal.left");
  });

  it("reads a word it does not know as unknown, never as it came", async () => {
    const port = portOver(async () => {
      throw new MutationRejectedError("Some provider text", {
        status: 400,
        code: "something_new",
        retryable: false,
      });
    });
    expect((await pressAndHear(port, create)).verdict).toMatchObject({ kind: "refused", word: "unknown" });
  });
});

it("returns a refusal to the pressing tab after another tab sends the queued change", async () => {
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  const factory = new IDBFactory();
  const pressingStore = new IndexedDbMirrorStore({ factory, owner: "acct-calendar" });
  const sendingStore = new IndexedDbMirrorStore({ factory, owner: "acct-calendar" });
  await pressingStore.load();
  await sendingStore.load();
  const offline = vi.fn(async () => {
    throw new MutationRejectedError("offline", { code: "network", retryable: true });
  });
  const refuse = vi.fn(async () => {
    throw new MutationRejectedError("read only", {
      code: "calendar_read_only",
      retryable: false,
      details: { remote: "private diagnostic" },
    });
  });
  let now = PRESSED_AT;
  const pressing = portOver(offline, pressingStore, () => now);
  const sending = portOver(refuse, sendingStore);
  const stopPressing = pressing.activate();
  const reports = vi.fn();
  const stopReports = pressing.subscribeLateRefusals((word) => reports(calendarRefusalSentence(word)));
  const peerReports = vi.fn();
  const stopPeerReports = sending.subscribeLateRefusals(peerReports);
  try {
    const act: CalendarAct = {
      kind: "calendar_event_update",
      eventId: "ev",
      base: new Date(PRESSED_AT).toISOString(),
      scope: { kind: "record" },
      change: { title: "A new time" },
    };
    const heard = await pressAndHear(pressing, act);
    expect(heard).toMatchObject({ verdict: null, say: null });
    await sending.flush();
    expect(refuse.mock.calls).toHaveLength(1);
    await vi.waitFor(() => expect(pressing.hasOwedWrites()).toBe(false));
    expect(pressing.verdict(heard.key)).toEqual({
      kind: "refused",
      word: "calendar_read_only",
      details: null,
    });
    expect(reports.mock.calls).toEqual([["refusal.readOnly"]]);
    expect(peerReports).not.toHaveBeenCalled();
    expect(pressingStore.entries("calendar_settlement")).toEqual([
      {
        id: heard.key,
        seq: 0,
        entity: {
          expiresAt: PRESSED_AT + 5 * 60_000,
          reference: { type: "event", id: act.eventId },
          result: { kind: "refused", word: "calendar_read_only" },
        },
      },
    ]);
    pressing.resumeWrites();
    sending.resumeWrites();
    await Promise.all([pressing.flush(), sending.flush()]);
    expect(refuse.mock.calls).toHaveLength(1);
    expect(offline.mock.calls).toHaveLength(1);
    expect(reports.mock.calls).toEqual([["refusal.readOnly"]]);
    now += 5 * 60_000;
    await pressing.flush();
    expect(pressing.verdict(heard.key)).toBeNull();
    expect(pressingStore.entries("calendar_settlement")).toEqual([]);
  } finally {
    stopReports();
    stopPeerReports();
    stopPressing();
    sending.suspendWrites();
    pressingStore.close();
    sendingStore.close();
    vi.unstubAllGlobals();
  }
});

it("reconciles two peer settlements in the pressing tab once per original key", async () => {
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  const factory = new IDBFactory();
  const store = () => new IndexedDbMirrorStore({ factory, owner: "acct-calendar", notices: () => null });
  const pressingStore = store();
  const sendingStore = store();
  await pressingStore.load();
  await sendingStore.load();
  const pressing = portOver(async () => {
    throw new MutationRejectedError("offline", { code: "network", retryable: true });
  }, pressingStore);
  const send = vi.fn(async (key: string) => {
    const code = key === "key-1" ? "calendar_read_only" : "calendar_writes_full";
    throw new MutationRejectedError("refused", { code, retryable: false });
  });
  const sending = portOver(send, sendingStore);
  const report = vi.fn();
  const retire = vi.fn();
  const stop = pressing.activate();
  const off = pressing.subscribeLateRefusals(report, retire);
  try {
    const first = await pressAndHear(pressing, create);
    const second = await pressAndHear(pressing, { ...create, eventId: "second-event" });
    expect([first.say, second.say]).toEqual([null, null]);
    await sending.flush();
    expect(send.mock.calls).toEqual([[first.key], [second.key]]);
    expect(report).not.toHaveBeenCalled();

    pressing.resumeWrites();
    await pressing.flush();
    pressing.watchLateRefusal(first.key);
    pressing.watchLateRefusal(second.key);
    expect(report.mock.calls).toEqual([["calendar_read_only"], ["calendar_writes_full"]]);
    pressing.suspendWrites();
    expect(retire).toHaveBeenCalledOnce();
  } finally {
    off();
    stop();
    sending.suspendWrites();
    pressingStore.close();
    sendingStore.close();
    vi.unstubAllGlobals();
  }
});
