/** @vitest-environment jsdom */
/**
 * THE CALENDAR'S TWO SETTINGS PANES: every control stands only where the setup's port has its door; where a member is
 * `none` the page holds no control for it at all. Where it has one, one press is one call, and what is shown follows
 * the mirror with no press.
 */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CalendarSettingsWire } from "@ohmail/app-logic/calendar";
import type { CalendarSetupPort } from "@ohmail/app-logic/calendar/setup";
import { calendarAccountsPane, calendarViewPane } from "../../src/calsettings/index.js";
import type { ComponentType } from "react";
import type { CalendarPlaceId, PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import type { None } from "../../src/host/index.js";
import type { PaneBodyProps } from "../../src/settings/contract.js";
import {
  calendarRecord,
  connectionRecord,
  mirror,
  mountFrame,
  NONE,
  setupPort,
  UPDATED,
} from "../calsetup/world.js";

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

const SAID: CalendarSettingsWire = {
  enabledAt: UPDATED,
  secondZone: null,
  weekNumbers: false,
  dayFromMinute: null,
  dayToMinute: null,
  newEventsCalendarId: "cal-1",
};
const SHUT: CalendarSetupPort = {
  ways: async () => [],
  connect: "none",
  signInAgain: "none",
  remove: "none",
  check: "none",
  setCalendar: "none",
  saveSettings: "none",
};

/** A pane's body standing as the calendar's settings place, in the frame. */
function paneAt(Body: ComponentType<PaneBodyProps>): PlaceEntry {
  return {
    id: "calsettings",
    body: "calsettings",
    rail: null,
    panes: { kind: "wide", Wide: ({ plan }: PaneProps) => <Body plan={plan} keysHere /> },
  };
}

function world() {
  const w = mirror(SAID);
  w.put("calendar_connection", "conn-1", connectionRecord());
  w.put(
    "calendar_connection",
    "conn-2",
    connectionRecord({
      id: "conn-2",
      label: "Home",
      status: "reconnect",
      serverHost: "caldav.icloud.com",
      createdAt: "2026-11-02T08:00:00.000Z",
    }),
  );
  w.put("calendar", "cal-1", calendarRecord());
  w.put("calendar", "cal-2", calendarRecord({ id: "cal-2", connectionId: "conn-2", name: "Family" }));
  return w;
}

function mountPane(which: "accounts" | "view", port: CalendarSetupPort | typeof NONE, w = world()) {
  const Body = which === "accounts" ? calendarAccountsPane.Body : calendarViewPane.Body;
  const made = mountFrame("#/cal/calendars", w, port, {
    entry: { places: { ...emptyPlaces(), calsettings: paneAt(Body) } },
  });
  return { ...made, w };
}
function emptyPlaces(): Record<CalendarPlaceId, PlaceEntry | None> {
  return {
    week: NONE,
    day: NONE,
    month: NONE,
    year: NONE,
    agenda: NONE,
    calsearch: NONE,
    frommail: NONE,
    calsettings: NONE,
  };
}
const openAll = () => {
  for (const row of screen
    .getAllByRole("button", { expanded: false })
    .filter((b) => b.closest(".oh-accountrow-head")))
    fireEvent.click(row);
};

describe("Calendar accounts", () => {
  for (const port of [NONE, SHUT] as const) {
    it(`draws no control where ${port === NONE ? "the host hands in no port" : "every door is none"}`, async () => {
      mountPane("accounts", port);
      await act(async () => undefined);
      openAll();
      expect(screen.getByText("Studio")).toBeTruthy();
      expect(screen.getByText("Family")).toBeTruthy();
      expect(screen.queryByRole("switch")).toBeNull();
      for (const name of [/Add a calendar account/, /Sign in again/, /Check now/, /Remove/, /Rename/])
        expect(screen.queryByRole("button", { name })).toBeNull();
      expect(document.querySelector('[aria-haspopup="menu"]')).toBeNull();
    });
  }

  it("offers a new sign-in to a signed-out iCloud account and opens the setup at its sign-in", async () => {
    const port = setupPort(async () => ["icloud"]);
    const { address } = mountPane("accounts", port);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(address.writes.at(-1)?.next).toMatch(
      /cal-setup\?step=signin&way=icloud&again=conn-2&from=settings/,
    );
    expect(port.signInAgain).not.toHaveBeenCalled();
  });

  it("offers no new sign-in where connecting has no door, for the sign-in is a step of the setup", async () => {
    mountPane(
      "accounts",
      setupPort(async () => ["icloud"], { connect: "none" }),
    );
    await act(async () => undefined);
    expect(screen.getByText("Home")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
  });

  it("offers no new sign-in for a way whose sign-in has no step here", async () => {
    const w = mirror(SAID);
    w.put(
      "calendar_connection",
      "conn-g",
      connectionRecord({ id: "conn-g", provider: "google", serverHost: null, status: "reconnect" }),
    );
    mountPane(
      "accounts",
      setupPort(async () => ["icloud"]),
      w,
    );
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
  });

  it("makes one call a press for Check now, Remove, a calendar's switch and its new name", async () => {
    const port = setupPort(async () => ["caldav"]);
    mountPane("accounts", port);
    await act(async () => undefined);
    openAll();
    const studio = screen.getAllByRole("group", { name: "Calendars" })[0]!;
    fireEvent.click(within(studio).getByRole("switch", { name: "Show Studio" }));
    expect(port.setCalendar).toHaveBeenCalledTimes(1);
    expect(port.setCalendar).toHaveBeenCalledWith("cal-1", { shown: false });

    fireEvent.click(screen.getAllByRole("button", { name: "Check now" })[0]!);
    expect(port.check).toHaveBeenCalledWith("conn-1");

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    expect(port.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    expect(port.remove).toHaveBeenCalledTimes(1);
    expect(port.remove).toHaveBeenCalledWith("conn-1");

    fireEvent.click(within(studio).getByRole("button", { name: /Studio/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename here" }));
    fireEvent.change(screen.getByLabelText("Name here"), { target: { value: "Atelier" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(port.setCalendar).toHaveBeenLastCalledWith("cal-1", { name: "Atelier" });
    expect(port.setCalendar).toHaveBeenCalledTimes(2);
  });

  it("says a failing account's fault, and follows the mirror with no press", async () => {
    const w = world();
    mountPane("accounts", NONE, w);
    await act(async () => undefined);
    act(() =>
      w.put(
        "calendar_connection",
        "conn-1",
        connectionRecord({ status: "failing", errorCode: "host_unresolved" }),
      ),
    );
    expect(screen.getByText("Not checked")).toBeTruthy();
    openAll();
    expect(screen.getByText("That server could not be found.")).toBeTruthy();
    act(() =>
      w.put(
        "calendar_connection",
        "conn-3",
        connectionRecord({ id: "conn-3", label: "Club", provider: "ics" }),
      ),
    );
    expect(screen.getByText("Club")).toBeTruthy();
  });

  it("says there is no account, and offers Add only where connecting has a door", async () => {
    mountPane("accounts", SHUT, mirror(SAID));
    await act(async () => undefined);
    expect(document.body.textContent).toContain("No calendar account");
    expect(screen.queryByRole("button", { name: /Add a calendar account/ })).toBeNull();
    cleanup();
    const { address } = mountPane(
      "accounts",
      setupPort(async () => ["ics"]),
      mirror(SAID),
    );
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: /Add a calendar account/ }));
    expect(address.writes.at(-1)?.next).toMatch(/cal-setup\?step=way&from=settings/);
  });
});

describe("View", () => {
  it("says each value and draws no control where settings cannot be saved", async () => {
    mountPane("view", SHUT);
    await act(async () => undefined);
    expect(screen.getByText("Studio")).toBeTruthy();
    expect(screen.getByText("Off")).toBeTruthy();
    const main = document.querySelector(".fr-main") as HTMLElement;
    expect(within(main).queryByRole("switch")).toBeNull();
    expect(within(main).queryAllByRole("button")).toEqual([]);
  });

  it("saves the week's numbers and a second zone with one call each, and shows our server's answer", async () => {
    const port = setupPort(async () => [], {
      saveSettings: async (body) => ({ ...SAID, ...body }) as CalendarSettingsWire,
    });
    const saved: unknown[] = [];
    const counted: CalendarSetupPort = {
      ...port,
      saveSettings: async (body) => (
        saved.push(body),
        (port.saveSettings as Exclude<CalendarSetupPort["saveSettings"], "none">)(body)
      ),
    };
    mountPane("view", counted);
    await act(async () => undefined);
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Week numbers" })));
    expect(saved).toEqual([{ weekNumbers: true }]);
    expect(
      (screen.getByRole("switch", { name: "Week numbers" }) as HTMLElement).getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Second time zone" }));
    fireEvent.change(screen.getByLabelText("Find a time zone"), { target: { value: "lisbon" } });
    await act(async () => fireEvent.click(screen.getByRole("menuitemradio", { name: "Europe/Lisbon" })));
    expect(saved).toEqual([{ weekNumbers: true }, { secondZone: "Europe/Lisbon" }]);
    expect(screen.getByText("Europe/Lisbon")).toBeTruthy();
  });
});
