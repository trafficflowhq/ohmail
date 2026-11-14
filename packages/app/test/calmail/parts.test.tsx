/** @vitest-environment jsdom */
/**
 * THE CALENDAR'S PARTS INSIDE MAIL: Today lists the rest of the day and follows the mirror with no press, Coming up
 * lists the next events with one person, a row opens its event in the calendar, and neither draws anything where the
 * host has no calendar.
 */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEventRecord } from "@ohmail/app-logic/calendar";
import calmailEn from "../../messages/calmail.en.json" with { type: "json" };
import { ComingUp, TodayBeside } from "../../src/calmail/index.js";
import type { PlaceEntry } from "../../src/frame/contract.js";
import type { Messages } from "../../src/text/index.js";
import {
  calendarRecord,
  connectionRecord,
  mirror,
  mountFrame,
  NONE,
  UPDATED,
  ZURICH,
} from "../calsetup/world.js";

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 10, 16, 9, 0));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function event(
  id: string,
  title: string,
  from: string,
  to: string,
  over: Partial<CalendarEventRecord> = {},
): CalendarEventRecord {
  return {
    id,
    calendarId: "cal-1",
    uid: `${id}@studio.test`,
    recurrenceId: "",
    thisAndFuture: false,
    sequence: 0,
    status: "confirmed",
    title,
    notes: null,
    place: null,
    callLink: null,
    start: { kind: "zoned", value: from, zone: ZURICH },
    end: { kind: "zoned", value: to, zone: ZURICH },
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
    ...over,
  };
}

const ohbox: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: null,
  panes: {
    kind: "wide",
    Wide: () => (
      <>
        <TodayBeside />
        <ComingUp address="petra@studio.test" name="Petra" />
      </>
    ),
  },
};

function world() {
  const w = mirror();
  w.put("calendar_connection", "conn-1", connectionRecord());
  w.put("calendar", "cal-1", calendarRecord());
  w.put("calendar_event", "ev-past", event("ev-past", "Clay order", "20261116T080000", "20261116T083000"));
  w.put("calendar_event", "ev-now", event("ev-now", "Glaze test", "20261116T093000", "20261116T110000"));
  w.put(
    "calendar_event",
    "ev-petra",
    event("ev-petra", "Studio visit", "20261118T140000", "20261118T150000", {
      organizer: { address: "Petra@studio.test", name: "Petra" },
      myAnswer: "none",
    }),
  );
  return w;
}
const WORDS = calmailEn as unknown as Messages;

describe("the calendar inside mail", () => {
  it("lists the rest of today, follows the mirror and opens an event in the calendar", () => {
    const w = world();
    const { address } = mountFrame("#/ohbox", w, NONE, { places: { ohbox }, words: WORDS });
    const today = screen.getByRole("group", { name: /Today/ });
    expect(within(today).queryByText("Clay order")).toBeNull();
    expect(within(today).getByText("Glaze test")).toBeTruthy();
    act(() =>
      w.put(
        "calendar_event",
        "ev-late",
        event("ev-late", "Supplier call", "20261116T160000", "20261116T163000"),
      ),
    );
    expect(within(today).getByText("Supplier call")).toBeTruthy();
    fireEvent.click(within(today).getByText("Glaze test"));
    expect(address.writes.at(-1)?.next).toMatch(/#\/cal\/week\/2026-11-16\/e\/ev-now/);
  });

  it("lists what comes up with one person, with what waits for an answer", () => {
    mountFrame("#/ohbox", world(), NONE, { places: { ohbox }, words: WORDS });
    const coming = screen.getByRole("group", { name: "Coming up with Petra" });
    expect(within(coming).getByText("Studio visit")).toBeTruthy();
    expect(within(coming).getByText("To answer")).toBeTruthy();
  });

  it("draws nothing where the host has no calendar", () => {
    const w = world();
    const made = mountFrame("#/ohbox", w, NONE, { places: { ohbox }, words: WORDS, noCalendar: true });
    expect(screen.queryByRole("group", { name: /Today|Coming up/ })).toBeNull();
    made.unmount();
  });
});
