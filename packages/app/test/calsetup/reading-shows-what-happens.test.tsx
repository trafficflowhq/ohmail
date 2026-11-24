/** @vitest-environment jsdom */
/**
 * WHILE A NEW CALENDAR ACCOUNT IS READ, THE STEP SAYS WHAT IS HAPPENING, FROM THE MIRROR ALONE: the account is connected,
 * its calendars are being found, each calendar stands ready to choose as it arrives, and its events are counted while
 * they are read, done only once every calendar says it was read. Nothing holds the person: the calendars are chosen
 * while the events still come, the way out is the step's close, and past 8 seconds with nothing found one line offers
 * to keep going, after which the frame's report says when the calendars are there. A refusal says why and offers Try
 * again. There is no "Not now".
 */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEventRecord } from "@ohmail/app-logic/calendar";
import { calendarRecord, connectionRecord, mirror, mountFrame, setupPort, UPDATED } from "./world.js";

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const AT = "#/cal/cal-setup?step=calendars&way=caldav&connection=conn-1";

function reading() {
  const world = mirror();
  world.put("calendar_connection", "conn-1", connectionRecord({ lastSyncedAt: null }));
  const port = setupPort(async () => ["caldav"]);
  const mounted = mountFrame(AT, world, port);
  return { world, port, ...mounted };
}

/** An invented event of a calendar, as the store keeps one. */
const event = (id: string, calendarId: string): CalendarEventRecord => ({
  id,
  calendarId,
  uid: `${id}@studio.test`,
  recurrenceId: "",
  thisAndFuture: false,
  sequence: 0,
  status: "confirmed",
  title: id,
  notes: null,
  place: null,
  callLink: null,
  start: { kind: "zoned", value: "20261103T090000", zone: "Europe/Zurich" },
  end: { kind: "zoned", value: "20261103T093000", zone: "Europe/Zurich" },
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

/** What a screen reader says of an element after its name: the notes it is described by. */
const saidOf = (el: Element) =>
  (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");

describe("the step while a new account is read", () => {
  it("says the account is connected and its calendars are being found, with no Not now", async () => {
    reading();
    await act(async () => undefined);
    expect(screen.getByRole("heading", { name: "Reading your calendars" })).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Finding calendars")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
    expect(screen.queryByText(/Calendar connected\./)).toBeNull();
  });

  it("leaves by the step's close", async () => {
    const { address } = reading();
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Close setup" }));
    await act(async () => undefined);
    expect(address.writes.at(-1)?.next).not.toMatch(/cal-setup/);
  });

  it("shows each calendar as it arrives, ready to choose, and counts the events until every calendar was read", async () => {
    const { world } = reading();
    await act(async () => undefined);
    act(() => world.put("calendar", "cal-1", calendarRecord()));
    expect(screen.getByRole("heading", { name: "My calendars" })).toBeTruthy();
    expect(screen.queryByText("Finding calendars")).toBeNull();
    expect(screen.getByText("Studio")).toBeTruthy();
    expect(screen.getByText("Reading events")).toBeTruthy();

    act(() => world.put("calendar", "cal-2", calendarRecord({ id: "cal-2", name: "Home" })));
    expect(screen.getByText("Home")).toBeTruthy();
    act(() => {
      world.put("calendar_event", "e1", event("e1", "cal-1"));
      world.put("calendar_event", "e2", event("e2", "cal-2"));
      world.put("calendar_event", "e3", event("e3", "cal-2"));
    });
    expect(screen.getByText("Reading events").closest("[role=status]")?.textContent).toBe("Reading events3");

    act(() => world.put("calendar", "cal-1", calendarRecord({ lastSyncedAt: UPDATED })));
    expect(screen.getByText("Reading events")).toBeTruthy();
    act(() =>
      world.put("calendar", "cal-2", calendarRecord({ id: "cal-2", name: "Home", lastSyncedAt: UPDATED })),
    );
    expect(screen.queryByText("Reading events")).toBeNull();
    expect(screen.getByText("3 events")).toBeTruthy();
  });

  it("counts a calendar whose first reading failed as finished, and says why on its line", async () => {
    const { world } = reading();
    await act(async () => undefined);
    act(() => {
      world.put("calendar", "cal-1", calendarRecord({ lastSyncedAt: UPDATED }));
      world.put("calendar", "cal-2", calendarRecord({ id: "cal-2", name: "Home", errorCode: "timeout" }));
      world.put("calendar_event", "e1", event("e1", "cal-1"));
      world.put("calendar_event", "e2", event("e2", "cal-1"));
    });
    expect(screen.queryByText("Reading events")).toBeNull();
    expect(screen.getByText("2 events")).toBeTruthy();
    expect(saidOf(screen.getByRole("group", { name: "Home" }))).toMatch(/The server did not answer\./);
    expect(saidOf(screen.getByRole("group", { name: "Studio" }))).not.toMatch(/did not answer/);
  });

  it("says an account without calendars has none once its listing is done, and closes", async () => {
    const { world, address } = reading();
    await act(async () => undefined);
    expect(screen.getByText("Finding calendars")).toBeTruthy();
    act(() => world.put("calendar_connection", "conn-1", connectionRecord({ lastSyncedAt: UPDATED })));
    expect(screen.queryByText("Finding calendars")).toBeNull();
    expect(screen.getByText("No calendars in this account")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => undefined);
    expect(address.writes.at(-1)?.next).not.toMatch(/cal-setup/);
  });

  it("does not announce the event count at every change, only the finished phase", async () => {
    const { world } = reading();
    await act(async () => undefined);
    act(() => world.put("calendar", "cal-1", calendarRecord()));
    act(() => world.put("calendar_event", "e1", event("e1", "cal-1")));
    const phase = screen.getByText("Reading events").closest("[role=status]") as HTMLElement;
    expect(within(phase).getByText("1").closest("[aria-live=off]")).not.toBeNull();
    act(() => world.put("calendar", "cal-1", calendarRecord({ lastSyncedAt: UPDATED })));
    const done = screen.getByText("1 event");
    expect(done.closest("[role=status]")).not.toBeNull();
    expect(done.closest("[aria-live=off]")).toBeNull();
  });

  it("lets the calendars be chosen and the step left while the events are still read", async () => {
    const { world, port, address } = reading();
    await act(async () => undefined);
    act(() => world.put("calendar", "cal-1", calendarRecord()));
    expect(screen.getByText("Reading events")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Studio" }));
    expect(port.setCalendar).toHaveBeenCalledWith("cal-1", { shown: false });
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    await act(async () => undefined);
    expect(address.writes.at(-1)?.next).toMatch(/step=default/);
  });
});

describe("a reading that takes long", () => {
  it("offers to keep going only past 8 seconds with nothing found, then reports when the calendars are there", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { world, address } = reading();
    await act(async () => undefined);
    act(() => vi.advanceTimersByTime(7_900));
    expect(screen.queryByRole("button", { name: "Keep going" })).toBeNull();
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByText(/This takes a moment\. You can keep going/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep going" }));
    await act(async () => undefined);
    expect(address.writes.at(-1)?.next).not.toMatch(/cal-setup/);

    act(() => world.put("calendar", "cal-1", calendarRecord()));
    expect(document.body.textContent).toMatch(/Another CalDAV server: 1 calendar ready/);
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    await act(async () => undefined);
    expect(address.writes.at(-1)?.next).toMatch(/calsettings|calaccounts|calendar-accounts/);
  });

  it("reports later also when the connection reaches the device only after Keep going", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const world = mirror();
    const { address } = mountFrame(
      AT,
      world,
      setupPort(async () => ["caldav"]),
    );
    await act(async () => undefined);
    act(() => vi.advanceTimersByTime(8_100));
    fireEvent.click(screen.getByRole("button", { name: "Keep going" }));
    await act(async () => undefined);
    expect(address.writes.at(-1)?.next).not.toMatch(/cal-setup/);

    act(() => world.put("calendar_connection", "conn-1", connectionRecord({ lastSyncedAt: null })));
    act(() => world.put("calendar", "cal-1", calendarRecord()));
    expect(document.body.textContent).toMatch(/Another CalDAV server: 1 calendar ready/);
  });

  it("puts the calendars in place of the line when they arrive while the step still stands", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { world } = reading();
    await act(async () => undefined);
    act(() => vi.advanceTimersByTime(9_000));
    expect(screen.getByRole("button", { name: "Keep going" })).toBeTruthy();
    act(() => world.put("calendar", "cal-1", calendarRecord()));
    expect(screen.queryByRole("button", { name: "Keep going" })).toBeNull();
    expect(screen.queryByText(/This takes a moment/)).toBeNull();
    expect(screen.getByText("Studio")).toBeTruthy();
  });
});

describe("a reading that is refused", () => {
  it("says why in one sentence and offers Try again, with no Not now", async () => {
    const { world } = reading();
    await act(async () => undefined);
    act(() =>
      world.put(
        "calendar_connection",
        "conn-1",
        connectionRecord({ status: "failing", errorCode: "timeout", lastSyncedAt: null }),
      ),
    );
    expect(screen.getByRole("heading", { name: "Nothing was connected" })).toBeTruthy();
    expect(screen.getByText(/The server did not answer\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
  });
});
