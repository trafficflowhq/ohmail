/** @vitest-environment jsdom */
/**
 * FROM MAIL in the frame, over a mirror: only what the gate lets through is listed (never a reading of a letter's
 * sentences), Add is one create under one key into the settings' calendar, Add for all is one press per event, an
 * event already on a shown calendar offers no Add and leads to it, and with no shown calendar that can be written
 * nothing offers Add. One found event is made once, whichever Add is pressed, and only into a shown calendar.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import type {
  CalendarAct,
  CalendarConnectionRecord,
  CalendarEventRecord,
  CalendarPort,
  CalendarRecord,
} from "@ohmail/app-logic/calendar";
import type { CalendarSuggestionRecord } from "@ohmail/app-logic/calendar/found";
import calendarEn from "../../messages/calendar.en.json" with { type: "json" };
import eventEn from "../../messages/event.en.json" with { type: "json" };
import frommailEn from "../../messages/frommail.en.json" with { type: "json" };
import { calendar } from "../../src/calendar/entry.js";
import { Frame } from "../../src/frame/Frame.js";
import type { CalendarEntry } from "../../src/frame/contract.js";
import { fromMailPlace } from "../../src/frommail/index.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, type FakeAddress } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

const ZURICH = "Europe/Zurich";
const UPDATED = "2026-11-01T08:00:00.000Z";
const WORDS = { ...FRAME_WORDS.en, ...calendarEn, ...eventEn, ...frommailEn } as unknown as Messages;
const withPlace: CalendarEntry = { ...calendar, places: { ...calendar.places, frommail: fromMailPlace } };

const connection: CalendarConnectionRecord = {
  id: "conn-1",
  provider: "caldav",
  label: "Home",
  status: "active",
  errorCode: null,
  grantMailboxId: null,
  serverHost: null,
  consentedAt: UPDATED,
  lastSyncedAt: UPDATED,
  createdAt: UPDATED,
  updatedAt: UPDATED,
};
const cal = (id: string, over: Partial<CalendarRecord> = {}): CalendarRecord => ({
  id,
  connectionId: "conn-1",
  name: id === "cal-1" ? "Home" : "Studio",
  color: "#3366cc",
  access: "owner",
  shown: true,
  timeZone: ZURICH,
  window: null,
  defaultAlarms: [],
  lastSyncedAt: null,
  errorCode: null,
  updatedAt: UPDATED,
  ...over,
});
const found = (id: string, title: string, evidence: string, day = "20261120"): CalendarSuggestionRecord => ({
  id,
  messageId: `m-${id}`,
  mailboxId: "mb-1",
  evidence,
  proposed: {
    title,
    start: { kind: "zoned", value: `${day}T190000`, zone: ZURICH },
    end: null,
    place: "Kunsthalle",
  },
  sourceWords: `${title} on Friday at 7pm`,
  createdAt: UPDATED,
  updatedAt: UPDATED,
});
const onCalendar = (id: string, title: string, day: string): CalendarEventRecord => ({
  id,
  calendarId: "cal-1",
  uid: `${id}@home.test`,
  recurrenceId: "",
  thisAndFuture: false,
  sequence: 0,
  status: "confirmed",
  title,
  notes: null,
  place: null,
  callLink: null,
  start: { kind: "zoned", value: `${day}T190000`, zone: ZURICH },
  end: { kind: "zoned", value: `${day}T200000`, zone: ZURICH },
  duration: null,
  startsAt: UPDATED,
  endsAt: UPDATED,
  occurrenceAt: null,
  repeat: null,
  busy: true,
  private: false,
  organizer: null,
  myAnswer: null,
  heldBack: false,
  invitees: [],
  alarms: [],
  cut: false,
  writes: [],
  updatedAt: UPDATED,
});

/**
 * A mirror as far as From mail reads one, and a port that keeps every press and takes it. `lays`: a made event stands
 * in the mirror at its press, as the queue's overlay lays it; `holds`: our server answers only on `answer()`.
 */
function mirror(
  settings: { newEventsCalendarId: string | null },
  how: { readonly lays?: boolean; readonly holds?: boolean } = {},
) {
  const kinds = new Map<string, Map<string, unknown>>();
  const heard = new Set<() => void>();
  const pressed: { key: string; act: CalendarAct }[] = [];
  const held: (() => void)[] = [];
  let version = 0;
  let ids = 0;
  const entries = (type: string) => [...(kinds.get(type)?.values() ?? [])].map((entity) => ({ entity }));
  const subscribe = (listener: () => void) => {
    heard.add(listener);
    return () => void heard.delete(listener);
  };
  const engine = {
    store: { entries },
    subscribe,
    read: () => ({ version: () => version }),
  } as unknown as OhmailEngine;
  const put = (type: string, id: string, entity: unknown) => {
    const kind = kinds.get(type) ?? new Map<string, unknown>();
    kinds.set(type, kind);
    kind.set(id, entity);
    version += 1;
    for (const listener of [...heard]) listener();
  };
  const port: CalendarPort = {
    newId: () => `ev-new-${++ids}`,
    async press(a) {
      const key = `key-${pressed.length + 1}`;
      pressed.push({ key, act: a });
      if (how.lays && a.kind === "calendar_event_create")
        put("calendar_event", a.eventId, {
          ...onCalendar(a.eventId, a.event.title, "20261120"),
          calendarId: a.calendarId,
          start: a.event.start,
          end: a.event.end,
        });
      return { key };
    },
    flush: () => (how.holds ? new Promise<void>((resolve) => held.push(resolve)) : Promise.resolve()),
    verdict: () => ({ kind: "taken", write: null }),
    events: () =>
      entries("calendar_event").map(({ entity }) => ({
        record: entity as CalendarEventRecord,
        waiting: null,
        refusal: null,
        refusedWriteId: null,
      })),
    settings: async () => ({
      enabledAt: UPDATED,
      secondZone: null,
      weekNumbers: false,
      dayFromMinute: null,
      dayToMinute: null,
      ...settings,
    }),
    held: () => ({ window: { daysBack: 30, daysAhead: 365, maxRows: 5000 }, loaded: [] }),
    load: "none",
    version: () => version,
    subscribe,
  };
  put("calendar_connection", connection.id, connection);
  const answer = () => {
    for (const resolve of held.splice(0)) resolve();
  };
  return { engine, port, put, pressed, answer };
}

function mount(m: ReturnType<typeof mirror>, at = "#/cal/from-mail"): FakeAddress {
  const address = fakeAddress(at);
  const made = fakeHost({
    engine: m.engine,
    service: "managed",
    scope: "acct-1",
    calendar: withPlace,
    products: "both",
    wires: { calendar: m.port },
    address,
  });
  render(
    <TextProvider locale="en" messages={WORDS} timeZone={ZURICH}>
      <Frame host={made.host} />
    </TextProvider>,
  );
  return address;
}

const list = () => screen.getByRole("list", { name: "From mail" });
const rowOf = (title: string) =>
  within(list())
    .getAllByText(title)
    .map((el) => el.closest(".oh-erow"))
    .find((el): el is HTMLElement => el !== null)!;
const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-16T08:00:00Z"));
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("From mail", () => {
  it("lists what a letter's calendar part or data proposed, and no reading of its sentences", async () => {
    const m = mirror({ newEventsCalendarId: null });
    m.put("calendar", "cal-1", cal("cal-1"));
    m.put("calendar_suggestion", "a", found("a", "Opening", "calendar"));
    m.put("calendar_suggestion", "b", found("b", "Train to Basel", "data", "20261121"));
    m.put("calendar_suggestion", "c", found("c", "Dinner at mine", "sentence"));
    m.put("calendar_suggestion", "d", found("d", "Court booking", "sentence_model"));
    mount(m);
    await settle();
    expect(within(list()).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText("Dinner at mine")).toBeNull();
    expect(screen.queryByText("Court booking")).toBeNull();
    expect(screen.queryByText(/Dinner at mine on Friday/)).toBeNull();
  });

  it("adds one event under one press into the settings' calendar, and then says it is on the calendar", async () => {
    const m = mirror({ newEventsCalendarId: "cal-2" });
    m.put("calendar", "cal-1", cal("cal-1"));
    m.put("calendar", "cal-2", cal("cal-2"));
    m.put("calendar_suggestion", "a", found("a", "Opening", "calendar"));
    mount(m);
    await settle();
    fireEvent.click(within(rowOf("Opening")).getByRole("button", { name: "Add" }));
    await settle();
    expect(m.pressed).toHaveLength(1);
    expect(m.pressed[0]!.act).toEqual({
      kind: "calendar_event_create",
      eventId: "ev-new-1",
      calendarId: "cal-2",
      event: {
        title: "Opening",
        start: { kind: "zoned", value: "20261120T190000", zone: ZURICH },
        end: { kind: "zoned", value: "20261120T200000", zone: ZURICH },
        notes: null,
        place: "Kunsthalle",
        callLink: null,
        busy: true,
        private: false,
        repeat: null,
        invitees: [],
        alarms: [],
      },
    });
    act(() =>
      m.put("calendar_event", "ev-new-1", {
        ...onCalendar("ev-new-1", "Opening", "20261120"),
        calendarId: "cal-2",
      }),
    );
    const row = rowOf("Opening");
    expect(within(row).queryByRole("button", { name: "Add" })).toBeNull();
    expect(within(row).getByText("On your calendar")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Show in calendar" })).toBeTruthy();
  });

  it("adds every offer once with Add for all, one press after the other, and says how many", async () => {
    const m = mirror({ newEventsCalendarId: null });
    m.put("calendar", "cal-1", cal("cal-1"));
    m.put("calendar_suggestion", "a", found("a", "Opening", "calendar"));
    m.put("calendar_suggestion", "b", found("b", "Train to Basel", "data", "20261121"));
    m.put("calendar_suggestion", "c", found("c", "Fair", "data", "20261122"));
    m.put("calendar_event", "ev-9", onCalendar("ev-9", "Fair", "20261122"));
    mount(m);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add 2" }));
    await settle();
    expect(m.pressed.map((p) => p.act.kind === "calendar_event_create" && p.act.event.title)).toEqual([
      "Opening",
      "Train to Basel",
    ]);
    expect(new Set(m.pressed.map((p) => p.key)).size).toBe(2);
    expect(
      m.pressed.every((p) => p.act.kind === "calendar_event_create" && p.act.calendarId === "cal-1"),
    ).toBe(true);
    expect(
      screen
        .queryAllByRole("status")
        .map((s) => s.textContent)
        .join(" "),
    ).toContain("2 events added");
  });

  it("offers no Add where no calendar can be written", async () => {
    const m = mirror({ newEventsCalendarId: null });
    m.put("calendar", "cal-1", cal("cal-1", { access: "reader" }));
    m.put("calendar_suggestion", "a", found("a", "Opening", "calendar"));
    mount(m);
    await settle();
    expect(within(rowOf("Opening")).queryByRole("button", { name: "Add" })).toBeNull();
    expect(m.pressed).toEqual([]);
  });

  it("makes a found event once when Add for all and the open card's Add are both pressed", async () => {
    const m = mirror({ newEventsCalendarId: null }, { lays: true, holds: true });
    m.put("calendar", "cal-1", cal("cal-1"));
    m.put("calendar_suggestion", "a", found("a", "Opening", "calendar"));
    m.put("calendar_suggestion", "b", found("b", "Train to Basel", "calendar", "20261121"));
    mount(m, "#/cal/from-mail/e/b");
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add 2" }));
    await settle();
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Train to Basel" })).getByRole("button", { name: "Add" }),
    );
    await settle();
    for (let i = 0; i < 4; i += 1) {
      m.answer();
      await settle();
    }
    const made = m.pressed.filter(
      (p) => p.act.kind === "calendar_event_create" && p.act.event.title === "Train to Basel",
    );
    expect(made).toHaveLength(1);
  });

  it("writes only into a shown calendar, so the event it made stops the row's Add", async () => {
    const m = mirror({ newEventsCalendarId: "cal-1" }, { lays: true });
    m.put("calendar", "cal-1", cal("cal-1", { shown: false }));
    m.put("calendar", "cal-2", cal("cal-2"));
    m.put("calendar_suggestion", "a", found("a", "Opening", "calendar"));
    mount(m);
    await settle();
    fireEvent.click(within(rowOf("Opening")).getByRole("button", { name: "Add" }));
    await settle();
    expect(m.pressed.map((p) => p.act.kind === "calendar_event_create" && p.act.calendarId)).toEqual([
      "cal-2",
    ]);
    const row = rowOf("Opening");
    expect(within(row).queryByRole("button", { name: "Add" })).toBeNull();
    expect(within(row).getByText("On your calendar")).toBeTruthy();
  });

  it("offers no Add where the only calendar that can be written is hidden", async () => {
    const m = mirror({ newEventsCalendarId: null });
    m.put("calendar", "cal-1", cal("cal-1", { shown: false }));
    m.put("calendar_suggestion", "a", found("a", "Opening", "calendar"));
    m.put("calendar_suggestion", "b", found("b", "Train to Basel", "data", "20261121"));
    mount(m);
    await settle();
    expect(screen.queryAllByRole("button", { name: /Add/ })).toEqual([]);
    expect(m.pressed).toEqual([]);
  });

  it("opens a found event beside the list with the letter's words and the calendar it goes to", async () => {
    const m = mirror({ newEventsCalendarId: null });
    m.put("calendar", "cal-1", cal("cal-1"));
    m.put("calendar_suggestion", "a", found("a", "Opening", "calendar"));
    mount(m, "#/cal/from-mail/e/a");
    await settle();
    const card = screen.getByRole("dialog", { name: "Opening" });
    expect(within(card).getByText("Opening on Friday at 7pm")).toBeTruthy();
    expect(within(card).getByText("Home")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Add" }));
    await settle();
    expect(m.pressed).toHaveLength(1);
  });
});
