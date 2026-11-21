/** @vitest-environment jsdom */
/**
 * THE CALENDAR'S BODY IN THE FRAME: it draws what the mirror holds and follows every change with no press (it keeps no
 * list), and says in one line where the host hands in no port.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import type {
  CalendarConnectionRecord,
  CalendarEventRecord,
  CalendarPort,
  CalendarRecord,
  CalendarSettingsWire,
} from "@ohmail/app-logic/calendar";
import agendaEn from "../../messages/agenda.en.json" with { type: "json" };
import calsettingsEn from "../../messages/calsettings.en.json" with { type: "json" };
import calendarEn from "../../messages/calendar.en.json" with { type: "json" };
import calsearchEn from "../../messages/calsearch.en.json" with { type: "json" };
import dayEn from "../../messages/day.en.json" with { type: "json" };
import frommailEn from "../../messages/frommail.en.json" with { type: "json" };
import invitationsEn from "../../messages/invitations.en.json" with { type: "json" };
import eventEn from "../../messages/event.en.json" with { type: "json" };
import calmailEn from "../../messages/calmail.en.json" with { type: "json" };
import monthEn from "../../messages/month.en.json" with { type: "json" };
import weekEn from "../../messages/week.en.json" with { type: "json" };
import settingsEn from "../../messages/settings.en.json" with { type: "json" };
import yearEn from "../../messages/year.en.json" with { type: "json" };
import { NO_DOORS } from "../../src/calsettings/accounts/AccountsPane.js";
import { calendar } from "../../src/calendar/entry.js";
import { settingsPlace } from "../../src/settings/index.js";
import { useFrame } from "../../src/frame/commands.js";
import { Frame } from "../../src/frame/Frame.js";
import { ProductSwitch } from "../../src/frame/ProductSwitch.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import { NONE } from "../../src/host/index.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

const ZURICH = "Europe/Zurich";
const UPDATED = "2026-11-01T08:00:00.000Z";
const WORDS = {
  ...FRAME_WORDS.en,
  ...agendaEn,
  ...calendarEn,
  ...calmailEn,
  ...calsettingsEn,
  ...calsearchEn,
  ...dayEn,
  ...eventEn,
  ...frommailEn,
  ...invitationsEn,
  ...monthEn,
  ...weekEn,
  ...settingsEn,
  ...yearEn,
} as unknown as Messages;

const connection: CalendarConnectionRecord = {
  id: "conn-1",
  provider: "google",
  label: "Studio",
  status: "active",
  errorCode: null,
  grantMailboxId: null,
  serverHost: null,
  consentedAt: UPDATED,
  lastSyncedAt: UPDATED,
  createdAt: UPDATED,
  updatedAt: UPDATED,
};
const studio: CalendarRecord = {
  id: "cal-1",
  connectionId: "conn-1",
  name: "Studio",
  color: "#3366cc",
  access: "owner",
  shown: true,
  timeZone: ZURICH,
  window: null,
  defaultAlarms: [],
  lastSyncedAt: null,
  errorCode: null,
  updatedAt: UPDATED,
};
function event(
  id: string,
  title: string,
  dayStamp: string,
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
    start: { kind: "zoned", value: `${dayStamp}T090000`, zone: ZURICH },
    end: { kind: "zoned", value: `${dayStamp}T093000`, zone: ZURICH },
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

/**
 * A mirror as far as the calendar's body reads one: the records by kind, a version that moves with every change, and
 * who hears it move. The port reads the same records; the real queue over a real mirror is held in app-logic's tests.
 */
function mirror(load: CalendarPort["load"] = "none") {
  const kinds = new Map<string, Map<string, unknown>>();
  const heard = new Set<() => void>();
  /* What the queue says waits for a record, by its id. */
  const waits = new Map<string, "device" | "provider">();
  let version = 0;
  let settings: CalendarSettingsWire = {
    enabledAt: UPDATED,
    secondZone: null,
    weekNumbers: false,
    dayFromMinute: null,
    dayToMinute: null,
    newEventsCalendarId: null,
  };
  const entries = (type: string) => [...(kinds.get(type)?.values() ?? [])].map((entity) => ({ entity }));
  const subscribe = (listener: () => void) => {
    heard.add(listener);
    return () => {
      heard.delete(listener);
    };
  };
  const engine = {
    store: { entries },
    subscribe,
    read: () => ({ version: () => version }),
  } as unknown as OhmailEngine;
  const check = vi.fn(async (_id: string) => undefined);
  const port: CalendarPort = {
    newId: () => "new",
    press: () => new Promise(() => undefined),
    flush: async () => undefined,
    verdict: () => null,
    events: () =>
      entries("calendar_event").map(({ entity }) => ({
        record: entity as CalendarEventRecord,
        waiting: waits.get((entity as CalendarEventRecord).id) ?? null,
        refusal: null,
        refusedWriteId: null,
      })),
    settings: async () => settings,
    setup: {
      ...NO_DOORS,
      check,
      setCalendar: async (id, change) => {
        const held = kinds.get("calendar")?.get(id) as CalendarRecord;
        put("calendar", id, { ...held, ...change });
      },
      saveSettings: async (body) => {
        const { enabled, ...changes } = body;
        settings = {
          ...settings,
          ...changes,
          ...(enabled === undefined ? {} : { enabledAt: enabled ? UPDATED : null }),
        };
        return settings;
      },
    },
    held: () => ({ window: { daysBack: 30, daysAhead: 365, maxRows: 5000 }, loaded: [] }),
    load,
    version: () => version,
    subscribe,
  };
  const put = (type: string, id: string, entity: unknown) => {
    const kind = kinds.get(type) ?? new Map<string, unknown>();
    kinds.set(type, kind);
    if (entity === null) kind.delete(id);
    else kind.set(id, entity);
    version += 1;
    for (const listener of [...heard]) listener();
  };
  return { engine, port, put, waits, check };
}

const sharedSettings = settingsPlace(null, function useBeside() {
  const { commands, route } = useFrame();
  const place = route.place === "calsettings" ? "calsettings" : "settings";
  return { startAt: null, go: (sub) => commands.go({ place, sub }) };
});

function mount(
  engine: OhmailEngine,
  port: CalendarPort | typeof NONE,
  at = "#/cal/agenda/2026-11-16",
  room: "desktop" | "phone" = "desktop",
  withSharedSettings = false,
  mailWaiting = false,
) {
  const made = fakeHost({
    engine,
    service: "managed",
    scope: "acct-1",
    calendar,
    products: "both",
    wires: { calendar: port },
    places: {
      ...(withSharedSettings ? { settings: sharedSettings } : {}),
      ...(mailWaiting
        ? {
            ohbox: {
              id: "ohbox",
              body: "ohbox",
              rail: {
                group: "main",
                icon: "ohbox",
                label: "title",
                useCount: () => ({ count: "1", hot: false }),
              },
              panes: { kind: "wide", Wide: () => <ProductSwitch kind="round" /> },
            },
          }
        : {}),
    },
    address: fakeAddress(at),
    window: fakeWindow(room),
  });
  render(
    <TextProvider locale="en" messages={WORDS} timeZone={ZURICH}>
      <Frame host={made.host} />
    </TextProvider>,
  );
  return made;
}

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the calendar's body", () => {
  it("draws what the mirror holds, and follows every change of it with no press", () => {
    const { engine, port, put } = mirror();
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, studio);
    put("calendar_event", "ev-1", event("ev-1", "Kiln check", "20261116"));
    mount(engine, port);
    expect(screen.getAllByText(/Kiln check/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Glaze firing/)).toBeNull();

    act(() => put("calendar_event", "ev-2", event("ev-2", "Glaze firing", "20261117")));
    expect(screen.getAllByText(/Glaze firing/).length).toBeGreaterThan(0);

    act(() => put("calendar_event", "ev-1", null));
    expect(screen.queryByText(/Kiln check/)).toBeNull();
    expect(screen.getAllByText(/Glaze firing/).length).toBeGreaterThan(0);
  });

  it("searches the calendar from its week with the search key", () => {
    const { engine, port } = mirror();
    const { address } = mount(engine, port, "#/cal/week");
    fireEvent.keyDown(document.body, { key: "/" });
    expect(address.read()).toBe("#/cal/find");
  });

  it("returns to each product's previous place and leaves the browser history intact", () => {
    const { engine, port } = mirror();
    const made = mount(engine, port, "#/cal/month/2026-11-16");
    const address = made.host.device.address;
    fireEvent.click(screen.getByRole("button", { name: "Mail" }));
    expect(address.read()).toBe("#/ohbox");
    fireEvent.click(screen.getByRole("button", { name: "Calendar" }));
    expect(address.read()).toBe("#/cal/month/2026-11-16");
  });

  it("opens the event details from the week and closes them without leaving that week", () => {
    const { engine, port, put } = mirror();
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, studio);
    put("calendar_event", "ev-1", event("ev-1", "Kiln check", "20261116", { notes: "Inspect the glaze" }));
    const made = mount(engine, port, "#/cal/week/2026-11-16");
    fireEvent.click(screen.getByRole("button", { name: /Kiln check/ }));
    const details = screen.getByRole("dialog", { name: "Kiln check" });
    expect(within(details).getByText("Inspect the glaze")).toBeTruthy();
    expect(document.documentElement.dataset.product).toBe("cal");
    fireEvent.click(within(details).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Kiln check" })).toBeNull();
    expect(made.host.device.address.read()).toBe("#/cal/week/2026-11-16");
  });

  it("keeps an open event's details private when its calendar changes to availability only", () => {
    const { engine, port, put } = mirror();
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, studio);
    put(
      "calendar_event",
      "ev-1",
      event("ev-1", "Kiln check", "20261116", {
        notes: "Inspect the glaze",
        place: "Studio loft",
        organizer: { name: "Kiln organizer", address: "organizer@example.test" },
      }),
    );
    mount(engine, port, "#/cal/week/2026-11-16");
    fireEvent.click(screen.getByRole("button", { name: /Kiln check/ }));
    expect(screen.getByRole("dialog", { name: "Kiln check" })).toBeTruthy();
    act(() => put("calendar", studio.id, { ...studio, access: "busy" }));
    expect(screen.getByRole("dialog", { name: "Busy" })).toBeTruthy();
    for (const detail of ["Kiln check", "Inspect the glaze", "Studio loft", "Kiln organizer"]) {
      expect(screen.queryAllByText(detail, { exact: false })).toHaveLength(0);
    }
  });

  it("follows a calendar that is hidden and shown again", () => {
    const { engine, port, put } = mirror();
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, studio);
    put("calendar_event", "ev-1", event("ev-1", "Kiln check", "20261116"));
    mount(engine, port);
    act(() => put("calendar", studio.id, { ...studio, shown: false }));
    expect(screen.queryByText(/Kiln check/)).toBeNull();
    act(() => put("calendar", studio.id, studio));
    expect(screen.getAllByText(/Kiln check/).length).toBeGreaterThan(0);
  });

  it("says in the Week and the Month that an event in a zone this device does not know is not shown", () => {
    const outlook = event("ev-ol", "Supplier call", "20261118", {
      start: { kind: "zoned", value: "20261118T090000", zone: "Customized Time Zone" },
      end: { kind: "zoned", value: "20261118T100000", zone: "Customized Time Zone" },
    });
    for (const at of ["#/cal/week/2026-11-16", "#/cal/month/2026-11-16"]) {
      const { engine, port, put } = mirror();
      put("calendar_connection", connection.id, connection);
      put("calendar", studio.id, studio);
      put("calendar_event", outlook.id, outlook);
      mount(engine, port, at);
      expect(
        screen.getByText(
          at.includes("week")
            ? "1 event is not shown: its time zone is not known on this device."
            : "1 event in a time zone this device does not know",
        ),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Supplier call/ })).toBeNull();
      cleanup();
    }
  });

  it("says in the Year, the Agenda and under Search's results that an event in a zone this device does not know is not shown", () => {
    const outlook = event("ev-ol", "Supplier call", "20261118", {
      start: { kind: "zoned", value: "20261118T090000", zone: "Customized Time Zone" },
      end: { kind: "zoned", value: "20261118T100000", zone: "Customized Time Zone" },
    });
    for (const at of ["#/cal/year/2026-11-16", "#/cal/agenda/2026-11-16", "#/cal/find?q=supplier"]) {
      const { engine, port, put } = mirror();
      put("calendar_connection", connection.id, connection);
      put("calendar", studio.id, studio);
      put("calendar_event", outlook.id, outlook);
      mount(engine, port, at);
      expect(screen.getByText("1 event in a time zone this device does not know")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Supplier call/ })).toBeNull();
      cleanup();
    }
  });

  it("says under Search, where its only match cannot be placed, that it exists and not that nothing was found", () => {
    const outlook = event("ev-ol", "Supplier call", "20261118", {
      start: { kind: "zoned", value: "20261118T090000", zone: "Customized Time Zone" },
      end: { kind: "zoned", value: "20261118T100000", zone: "Customized Time Zone" },
    });
    const { engine, port, put } = mirror();
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, studio);
    put("calendar_event", outlook.id, outlook);
    mount(engine, port, "#/cal/find?q=supplier");
    expect(screen.getByText("1 event in a time zone this device does not know")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Nothing found");
  });

  it.each([
    { outlookOnly: true, title: "Microsoft 365" },
    { outlookOnly: false, title: "Calendar" },
  ])("names the earlier window $title for the calendars shown", ({ outlookOnly, title }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 16, 9));
    onTestFinished(() => vi.useRealTimers());
    const { engine, port, put } = mirror(async () => true);
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, { ...studio, shown: !outlookOnly });
    const outlook = { ...connection, id: "outlook", provider: "microsoft" };
    put("calendar_connection", outlook.id, outlook);
    put("calendar", "outlook-cal", { ...studio, id: "outlook-cal", connectionId: outlook.id });
    mount(engine, port, "#/cal/agenda/2026-05-04");
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain(`${title} From`);
    expect(within(notice).getByRole("button", { name: "Load earlier" })).toBeTruthy();
  });

  it("keeps the Week, Day and Year clear past the last held day", () => {
    // The mirror holds 365 days ahead of today; a span 400 days ahead reaches past them.
    const far = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
    for (const view of ["week", "day", "year"]) {
      const { engine, port, put } = mirror();
      put("calendar_connection", connection.id, connection);
      put("calendar", studio.id, studio);
      mount(engine, port, `#/cal/${view}/${far}`);
      expect(screen.queryByText("Later days stay with the calendar.")).toBeNull();
      cleanup();
    }
  });

  it("lists in the Agenda beside the Week the days after the week, not only the week's", () => {
    // The week's own Monday is today: the case reads the week's days and the days after it, whatever the date it runs on.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 16, 9));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { engine, port, put } = mirror();
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, studio);
    put("calendar_event", "ev-1", event("ev-1", "Kiln check", "20261117"));
    put("calendar_event", "ev-2", event("ev-2", "Glaze firing", "20261125"));
    mount(engine, port, "#/cal/week/2026-11-16?panel=agenda");
    const beside = screen.getByRole("complementary", { name: "Agenda" });
    expect(within(beside).getByText("Kiln check")).toBeTruthy();
    expect(within(beside).getByText("Glaze firing")).toBeTruthy();
  });

  it("lists in the Agenda place every day it was scrolled to, however far", () => {
    const { engine, port, put } = mirror();
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, studio);
    // Two hundred days after the Agenda's first day.
    put("calendar_event", "ev-far", event("ev-far", "Kiln service", "20270604"));
    mount(engine, port, "#/cal/agenda/2026-11-16");
    expect(screen.queryByText("Kiln service")).toBeNull();
    const list = document.querySelector("[data-scroll='calagenda']") as HTMLElement;
    Object.defineProperty(list, "scrollHeight", { value: 1000 });
    Object.defineProperty(list, "clientHeight", { value: 800 });
    for (let i = 0; i < 3; i++) act(() => void fireEvent.scroll(list, { target: { scrollTop: 0 } }));
    expect(screen.getByText("Kiln service")).toBeTruthy();
  });

  it("uses Waiting on Week chips for both stages of an unsaved change", () => {
    const { engine, port, put, waits } = mirror();
    waits.set("ev-1", "device");
    waits.set("ev-2", "provider");
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, studio);
    // Two hours long, so each chip has room for its second line.
    const long = (stamp: string) =>
      ({ end: { kind: "zoned", value: `${stamp}T110000`, zone: ZURICH } }) as const;
    put("calendar_event", "ev-1", event("ev-1", "Kiln check", "20261117", long("20261117")));
    put("calendar_event", "ev-2", event("ev-2", "Glaze firing", "20261118", long("20261118")));
    mount(engine, port, "#/cal/week/2026-11-16");
    expect(screen.getByRole("button", { name: /Kiln check/ }).textContent).toContain("Waiting");
    expect(screen.getByRole("button", { name: /Glaze firing/ }).textContent).toContain("Waiting");
  });

  it("opens a changed day under the key our server stored, also where the device would key it otherwise", () => {
    const { engine, port, put } = mirror();
    const stored = "Europe/Zurich|20261116T0900|false";
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, studio);
    put(
      "calendar_event",
      "standup",
      event("standup", "Standup", "20261102", {
        uid: "standup@studio.test",
        repeat: { rules: ["FREQ=WEEKLY;COUNT=4"], excluded: [], added: [] },
      }),
    );
    put(
      "calendar_event",
      "standup-moved",
      event("standup-moved", "Standup, moved", "20261117", {
        uid: "standup@studio.test",
        recurrenceId: stored,
        start: { kind: "zoned", value: "20261117T100000", zone: ZURICH },
        end: { kind: "zoned", value: "20261117T103000", zone: ZURICH },
      }),
    );
    mount(engine, port, `#/cal/week/2026-11-16/e/${encodeURIComponent(`standup@${stored}`)}`);
    expect(screen.getByRole("button", { name: /Standup, moved/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("says in one line that the calendar cannot be read where the host hands in no port", () => {
    const { engine } = mirror();
    mount(engine, NONE);
    expect(screen.getByText("The calendar cannot be read on this device.")).toBeTruthy();
  });
});

describe("the calendar frame", () => {
  it("signals waiting mail and invitations on the round switch to the other product", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 16, 9));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { engine, port, put } = mirror();
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, studio);
    put(
      "calendar_event",
      "invited",
      event("invited", "Kiln check", "20261117", {
        organizer: { address: "organizer@studio.test", name: "Organizer" },
        myAnswer: "none",
      }),
    );
    mount(engine, port, "#/cal/day/2026-11-16", "phone", false, true);
    const mail = screen.getByRole("button", { name: "Mail", description: "Mail is waiting" });
    fireEvent.click(mail);
    const calendar = screen.getByRole("button", { name: "Calendar", description: "Invitations are waiting" });
    expect(calendar).toBeTruthy();
    act(() => put("calendar_event", "invited", null));
    expect(
      screen.queryByRole("button", { name: "Calendar", description: "Invitations are waiting" }),
    ).toBeNull();
  });

  it("opens Agenda on a phone's first switch to Calendar and remembers a later view", () => {
    const { engine, port } = mirror();
    const { address } = mount(engine, port, "#/ohbox", "phone");
    const chord = (key: string) => {
      fireEvent.keyDown(document.body, { key: "g" });
      fireEvent.keyDown(document.body, { key });
    };
    chord("c");
    expect(address.read()).toBe("#/cal/agenda");
    fireEvent.keyDown(document.body, { key: "3" });
    expect(address.read()).toBe("#/cal/month");
    chord("m");
    expect(address.read()).toBe("#/ohbox");
    chord("c");
    expect(address.read()).toBe("#/cal/month");
  });

  it("browses from the picked day's current event when no event is open", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T09:15:00+01:00"));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { engine, port, put } = mirror();
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, studio);
    put("calendar_event", "previous", event("previous", "Previous workshop", "20261116"));
    put("calendar_event", "current", event("current", "Current workshop", "20261118"));
    put("calendar_event", "next", event("next", "Next workshop", "20261119"));
    mount(engine, port, "#/cal/week/2026-11-18");
    fireEvent.keyDown(document.body, { key: "j" });
    const current = screen.getByRole("dialog", { name: "Current workshop" });
    fireEvent.keyDown(current, { key: "k" });
    expect(screen.getByRole("dialog", { name: "Previous workshop" })).toBeTruthy();
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Previous workshop" })).getByRole("button", {
        name: "Close",
      }),
    );
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    fireEvent.keyDown(document.body, { key: "k" });
    expect(screen.getByRole("dialog", { name: "Previous workshop" })).toBeTruthy();
  });

  it("shows saved Calendar View preferences in the Settings menu and follows edits", async () => {
    const { engine, port, put } = mirror();
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, studio);
    const setup = port.setup;
    if (!setup || setup.saveSettings === "none") throw new Error("Calendar settings are required");
    await setup.saveSettings({ dayFromMinute: 420, dayToMinute: 1260, newEventsCalendarId: studio.id });
    mount(engine, port, "#/cal/calendars", "phone");
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const row = within(nav).getByRole("button", { name: "View" });
    expect(await within(row).findByText("07:00 – 21:00 · Studio")).toBeTruthy();
    fireEvent.click(row);
    fireEvent.click(await screen.findByRole("button", { name: /From/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "08:00" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(await screen.findByText("08:00 – 21:00 · Studio")).toBeTruthy();
  });

  it.each([false, true])(
    "queues two Settings edits even when the first rejects (%s)",
    async (rejectFirst) => {
      const { engine, port } = mirror();
      const setup = port.setup;
      if (!setup || setup.saveSettings === "none") throw new Error("Calendar settings are required");
      const save = setup.saveSettings;
      await save({ dayFromMinute: 420, dayToMinute: 1260 });
      let release = () => {};
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const saveSettings = vi.fn<typeof save>(async (patch) => {
        if (patch.weekNumbers === undefined) return save(patch);
        const reply = rejectFirst ? null : await save(patch);
        await wait;
        if (reply === null) throw new Error("Refused");
        return reply;
      });
      mount(engine, { ...port, setup: { ...setup, saveSettings } }, "#/cal/calendars/calview");
      const weeks = await screen.findByRole("switch", { name: "Week numbers" });
      await act(async () => fireEvent.click(weeks));
      fireEvent.click(screen.getByRole("button", { name: "From" }));
      await act(async () => fireEvent.click(screen.getByRole("menuitemradio", { name: "08:00" })));
      const pending = saveSettings.mock.calls.length;
      await act(async () => release());
      expect(await screen.findByText("08:00", { exact: true })).toBeTruthy();
      expect(weeks.getAttribute("aria-checked")).toBe(String(!rejectFirst));
      expect(await port.settings()).toMatchObject({
        weekNumbers: !rejectFirst,
        dayFromMinute: 480,
        dayToMinute: 1260,
      });
      expect(pending).toBe(1);
      expect(saveSettings).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps both ends of the visible hours and saves the last choice", async () => {
    const { engine, port } = mirror();
    const setup = port.setup;
    if (!setup || setup.saveSettings === "none") throw new Error("Calendar setup is required");
    const save = setup.saveSettings;
    await save({ dayFromMinute: 420, dayToMinute: 1260 });
    let release = () => {};
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saveSettings = vi.fn(save).mockImplementationOnce(async (patch) => {
      const reply = await save(patch);
      await wait;
      return reply;
    });
    mount(engine, { ...port, setup: { ...setup, saveSettings } }, "#/cal/calendars/calview");
    await screen.findByText("07:00", { exact: true });
    const pick = async (label: string, time: string) => {
      fireEvent.click(screen.getByRole("button", { name: label }));
      await act(async () => fireEvent.click(screen.getByRole("menuitemradio", { name: time })));
    };
    await pick("From", "08:00");
    await pick("To", "20:00");
    await pick("From", "09:00");
    expect(saveSettings).toHaveBeenCalledTimes(1);
    await act(async () => release());
    expect(await port.settings()).toMatchObject({ dayFromMinute: 540, dayToMinute: 1200 });
    expect(await screen.findByText("09:00", { exact: true })).toBeTruthy();
    expect(screen.getByText("20:00", { exact: true })).toBeTruthy();
  });

  it("opens the calendar list and shows or hides its events through the calendar switch", async () => {
    const { engine, port, put } = mirror();
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, studio);
    put("calendar_event", "ev-1", event("ev-1", "Kiln check", "20261116"));
    mount(engine, port);
    expect(screen.getByRole("button", { name: /Kiln check/ })).toBeTruthy();
    const calendars = screen.getByRole("button", { name: "Calendars" });
    expect(calendars.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(calendars);
    const toggle = screen.getByRole("switch", { name: "Show Studio" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.click(toggle));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("button", { name: /Kiln check/ })).toBeNull();
    await act(async () => fireEvent.click(toggle));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: /Kiln check/ })).toBeTruthy();
  });

  it("opens Calendar accounts and saves Calendar preferences from the rail", async () => {
    const { engine, port } = mirror();
    const { host } = mount(engine, port, "#/cal/week/2026-11-16");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("button", { name: /Calendar accounts/ })).toBeTruthy();
    fireEvent.click(
      within(screen.getByRole("navigation", { name: /settings/i })).getByRole("button", { name: /^View$/ }),
    );
    expect(host.device.address.read()).toBe("#/cal/calendars/calview");
    const weekNumbers = await screen.findByRole("switch", { name: "Week numbers" });
    expect(weekNumbers.getAttribute("aria-checked")).toBe("false");
    await act(async () => fireEvent.click(weekNumbers));
    expect(weekNumbers.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(host.device.address.read()).toBe("#/cal/week/2026-11-16");
    const head = screen.getByRole("heading", { level: 1 }).closest("header")!;
    expect(await within(head).findByLabelText("Week 47")).toBeTruthy();
  });

  it("changes the visible hours from the timed view without leaving it", async () => {
    const { engine, port } = mirror();
    const { host } = mount(engine, port, "#/cal/day/2026-11-16");
    await act(async () => {});
    const head = screen.getByRole("heading", { level: 1 }).closest("header")!;
    fireEvent.click(within(head).getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Hours in view/ }));
    const hours = screen.getByRole("dialog", { name: "Hours in view" });
    const from = within(hours).getByRole("group", { name: "From" });
    expect(within(from).getByText("06:00")).toBeTruthy();
    expect(within(hours).getByRole("group", { name: "To" }).textContent).toContain("22:00");
    await act(async () => fireEvent.click(within(from).getByRole("button", { name: "An hour later" })));
    expect(await port.settings()).toMatchObject({ dayFromMinute: 420, dayToMinute: 1320 });
    expect(from.textContent).toContain("07:00");
    expect(host.device.address.read()).toBe("#/cal/day/2026-11-16");
  });

  it("steps visible hours to both midnight boundaries", async () => {
    const { engine, port } = mirror();
    const setup = port.setup;
    if (!setup || setup.saveSettings === "none") throw new Error("Calendar setup is required");
    await setup.saveSettings({ dayFromMinute: 30, dayToMinute: 1410 });
    const saveSettings = vi.fn(setup.saveSettings);
    mount(engine, { ...port, setup: { ...setup, saveSettings } }, "#/cal/day/2026-11-16");
    await act(async () => {});
    const head = screen.getByRole("heading", { level: 1 }).closest("header")!;
    fireEvent.click(within(head).getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Hours in view/ }));
    const hours = within(screen.getByRole("dialog", { name: "Hours in view" }));
    const from = within(hours.getByRole("group", { name: "From" }));
    const to = within(hours.getByRole("group", { name: "To" }));
    const earlier = from.getByRole<HTMLButtonElement>("button", { name: "An hour earlier" });
    const later = to.getByRole<HTMLButtonElement>("button", { name: "An hour later" });
    expect(earlier.disabled).toBe(false);
    expect(later.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(earlier);
      fireEvent.click(later);
    });
    expect(saveSettings.mock.calls).toEqual([
      [{ dayFromMinute: 0, dayToMinute: 1410 }],
      [{ dayFromMinute: 0, dayToMinute: 1440 }],
    ]);
    expect(await port.settings()).toMatchObject({ dayFromMinute: 0, dayToMinute: 1440 });
    expect(from.getByText("00:00")).toBeTruthy();
    expect(to.getByText("24:00")).toBeTruthy();
    expect(earlier.disabled).toBe(true);
    expect(later.disabled).toBe(true);
  });

  it("keeps Today visible in the phone head on a different day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 16, 9));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { engine, port } = mirror();
    mount(engine, port, "#/cal/day/2026-11-17", "phone");
    const { chromium, pageOf } = await import("../support/browser-page.js");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
      await page.route("**/*", (request) => request.abort());
      const root = [...document.documentElement.attributes]
        .map(({ name, value }) => `${name}="${value}"`)
        .join(" ");
      await page.setContent(pageOf({ html: document.body.innerHTML, root }));
      expect(await page.getByRole("button", { name: "Today", exact: true }).isVisible()).toBe(true);
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("turns Calendar off and can turn it back on from the shared Settings", async () => {
    const { engine, port } = mirror();
    const { host } = mount(engine, port, "#/cal/calendars", "desktop", true);
    const off = await screen.findByRole("switch", { name: "Use ohcal" });
    expect(off.getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.click(off));
    expect(host.device.address.read()).toBe("#/settings/calaccounts");
    expect(screen.queryByRole("group", { name: "Mail or Calendar" })).toBeNull();
    const on = await screen.findByRole("switch", { name: "Use ohcal" });
    expect(on.getAttribute("aria-checked")).toBe("false");
    await act(async () => fireEvent.click(on));
    expect(screen.getByRole("group", { name: "Mail or Calendar" })).toBeTruthy();
  });

  it("draws the saved second zone beside the reader's hours", async () => {
    const { engine, port } = mirror();
    const save = port.setup?.saveSettings;
    if (typeof save === "function") await save({ secondZone: "America/New_York" });
    mount(engine, port, "#/cal/day/2026-11-10");
    const axis = await screen.findByLabelText("America/New_York");
    expect(within(axis).getByText("12:00")).toBeTruthy();
  });

  it("puts the studio views on the phone dock and makes the other views reachable", () => {
    const { engine, port } = mirror();
    const { host } = mount(engine, port, "#/cal/week/2026-11-16", "phone");
    const dock = screen.getByRole("navigation", { name: "Calendar" });
    for (const view of ["Agenda", "Day", "Month"])
      expect(within(dock).getByRole("button", { name: view })).toBeTruthy();
    fireEvent.click(within(dock).getByRole("button", { name: "Day" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("16 Nov");
    expect(screen.getByRole("button", { name: /17 November/ })).toBeTruthy();
    fireEvent.click(within(dock).getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("button", { name: "Year" }));
    expect(host.device.address.read()).toBe("#/cal/year/2026-11-16");
  });

  it("steps Agenda by day and shares the numbered views and Today with the keyboard", () => {
    const { engine, port } = mirror();
    const { host } = mount(engine, port, "#/cal/agenda/2026-11-16");
    const head = screen.getByRole("heading", { level: 1 }).closest("header")!;
    fireEvent.click(within(head).getByRole("button", { name: "After" }));
    expect(host.device.address.read()).toBe("#/cal/agenda/2026-11-17");
    fireEvent.keyDown(document.body, { key: "[" });
    expect(host.device.address.read()).toBe("#/cal/agenda/2026-11-16");
    fireEvent.keyDown(document.body, { key: "1" });
    expect(host.device.address.read()).toBe("#/cal/day/2026-11-16");
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(host.device.address.read()).toBe("#/cal/day/2026-11-17");
    fireEvent.keyDown(document.body, { key: "t" });
    expect(host.device.address.read()).toBe("#/cal/day");
  });

  it.each([
    ["day", "2026-11-17"],
    ["week", "2026-11-23"],
    ["month", "2026-12-01"],
    ["year", "2027-11-16"],
    ["agenda", "2026-11-17"],
  ])("steps the %s with the keyboard from a focused event card", (view, next) => {
    const { engine, port, put } = mirror();
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, studio);
    put("calendar_event", "ev-1", event("ev-1", "Kiln check", "20261116"));
    const { address } = mount(engine, port, `#/cal/${view}/2026-11-16`);
    fireEvent.keyDown(document.body, { key: "j" });
    const card = screen.getByRole("dialog", { name: "Kiln check" });
    expect(card.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "]" });
    expect(address.read()).toBe(`#/cal/${view}/${next}`);
    expect(screen.queryByRole("dialog", { name: "Kiln check" })).toBeNull();
  });

  it("opens the next event with Enter from the Day itself", () => {
    const { engine, port, put } = mirror();
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, studio);
    put("calendar_event", "ev-1", event("ev-1", "Kiln check", "20261116"));
    mount(engine, port, "#/cal/day/2026-11-16");
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Kiln check" })).toBeTruthy();
  });

  it("keeps calendar navigation keys out of the event editor", () => {
    const { engine, port, put } = mirror();
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, studio);
    put("calendar_event", "ev-1", event("ev-1", "Kiln check", "20261116"));
    const { address } = mount(engine, port, "#/cal/day/2026-11-16");
    fireEvent.keyDown(document.body, { key: "j" });
    const card = screen.getByRole("dialog", { name: "Kiln check" });
    fireEvent.click(within(card).getAllByRole("button", { name: "Edit" })[0]!);
    const editor = screen.getByRole("dialog", { name: "Edit event" });
    const close = within(editor).getByRole("button", { name: "Close" });
    close.focus();
    for (const key of ["]", "t", "3", "ArrowRight"]) fireEvent.keyDown(close, { key });
    expect(address.read()).toBe("#/cal/day/2026-11-16/e/ev-1");
    expect(screen.getByRole("dialog", { name: "Edit event" })).toBe(editor);
  });

  it.each(["desktop", "phone"] as const)(
    "opens Calendar Search from a read card and keeps slash in the editor on %s",
    (room) => {
      const { engine, port, put } = mirror();
      const press = vi.spyOn(port, "press");
      put("calendar_connection", connection.id, connection);
      put("calendar", studio.id, studio);
      put("calendar_event", "ev-1", event("ev-1", "Kiln check", "20261116"));
      const day = "#/cal/day/2026-11-16";
      const openCard = () => {
        fireEvent.keyDown(document.body, { key: "j" });
        return screen.getByRole("dialog", { name: "Kiln check" });
      };
      const first = mount(engine, port, day, room);
      expect(openCard().contains(document.activeElement)).toBe(true);
      fireEvent.keyDown(document.activeElement!, { key: "/" });
      expect(first.address.read()).toBe("#/cal/find");
      cleanup();

      const second = mount(engine, port, day, room);
      fireEvent.click(within(openCard()).getAllByRole("button", { name: "Edit" })[0]!);
      const editor = screen.getByRole("dialog", { name: "Edit event" });
      for (const target of [
        within(editor).getByRole("button", { name: "Close" }),
        within(editor).getAllByRole("textbox")[0]!,
      ]) {
        expect(fireEvent.keyDown(target, { key: "/" })).toBe(true);
        expect(second.address.read()).toBe(day + "/e/ev-1");
      }
      expect(press).not.toHaveBeenCalled();
    },
  );

  it("opens and closes Invitations with the same shortcut without leaving Agenda", () => {
    const { engine, port } = mirror();
    const { address } = mount(engine, port, "#/cal/agenda/2026-11-16");
    const invitations = () => {
      fireEvent.keyDown(document.body, { key: "g" });
      fireEvent.keyDown(document.body, { key: "i" });
    };
    invitations();
    expect(address.read()).toBe("#/cal/agenda/2026-11-16?panel=invitations");
    expect(screen.getByRole("complementary", { name: "Invitations" })).toBeTruthy();
    invitations();
    expect(address.read()).toBe("#/cal/agenda/2026-11-16");
  });

  it("takes the next month from the weeks on screen without changing the picked date on scroll", () => {
    const size = vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (
      this: Element,
    ) {
      return this.getAttribute("aria-label") === "Month" ? 720 : 0;
    });
    onTestFinished(() => size.mockRestore());
    const { engine, port } = mirror();
    const { host } = mount(engine, port, "#/cal/month/2026-11-10");
    const area = screen.getByRole("region", { name: "Month" });
    area.dataset.rm = "1";
    expect(screen.getByRole("heading", { name: /November 2026/ })).toBeTruthy();
    fireEvent.scroll(area, { target: { scrollTop: area.scrollTop + 480 } });
    expect(screen.getByRole("heading", { name: /December 2026/ })).toBeTruthy();
    const sidebar = screen.getByRole("navigation", { name: "Calendar places" });
    expect(within(sidebar).getByRole("grid", { name: /December/ })).toBeTruthy();
    expect(host.device.address.read()).toBe("#/cal/month/2026-11-10");
    fireEvent.keyDown(document.body, { key: "]" });
    expect(host.device.address.read()).toBe("#/cal/month/2027-01-01");
    expect(screen.getByRole("heading", { name: /January 2027/ })).toBeTruthy();
  });

  it("walks Agenda events with the next and previous event keys", () => {
    const { engine, port, put } = mirror();
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, studio);
    put("calendar_event", "ev-1", event("ev-1", "Kiln check", "20261116"));
    put("calendar_event", "ev-2", event("ev-2", "Glaze firing", "20261117"));
    mount(engine, port);
    fireEvent.keyDown(document.body, { key: "j" });
    const kiln = screen.getByRole("dialog", { name: "Kiln check" });
    expect(kiln.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "j" });
    const glaze = screen.getByRole("dialog", { name: "Glaze firing" });
    expect(glaze.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "k" });
    expect(screen.getByRole("dialog", { name: "Kiln check" })).toBeTruthy();
  });

  it.each([
    ["day", "day"],
    ["week", "week"],
    ["month", "month"],
    ["year", "week"],
  ])("moves the %s from desktop Agenda without moving its list start", (view, revealedIn) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T07:00:00Z"));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { engine, port, put } = mirror();
    const press = vi.spyOn(port, "press");
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, studio);
    put("calendar_event", "first", event("first", "Kiln check", "20261116"));
    put("calendar_event", "second", event("second", "Glaze firing", "20261124"));
    put("calendar_event", "third", event("third", "Open bench", "20261125"));
    const { address } = mount(engine, port, `#/cal/${view}/2026-11-16?panel=agenda`);
    const agenda = screen.getByRole("complementary", { name: "Agenda" });
    fireEvent.click(within(agenda).getByRole("button", { name: /Glaze firing/ }));
    expect(address.read()).toBe(`#/cal/${revealedIn}/2026-11-24/e/second?panel=agenda`);
    expect(within(agenda).getByRole("button", { name: /Kiln check/ })).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "j" });
    expect(address.read()).toBe(`#/cal/${revealedIn}/2026-11-25/e/third?panel=agenda`);
    fireEvent.click(within(agenda).getByRole("button", { name: /Open bench/ }));
    expect(address.read()).toBe(`#/cal/${revealedIn}/2026-11-25?panel=agenda`);
    expect(within(agenda).getByRole("button", { name: /Kiln check/ })).toBeTruthy();
    expect(press).not.toHaveBeenCalled();
  });

  it("uses the hour cursor to open the event at that hour", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 15, 9));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { engine, port, put } = mirror();
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, studio);
    put("calendar_event", "ev-1", event("ev-1", "Kiln check", "20261116"));
    put(
      "calendar_event",
      "ev-2",
      event("ev-2", "Glaze firing", "20261116", {
        start: { kind: "zoned", value: "20261116T100000", zone: ZURICH },
        end: { kind: "zoned", value: "20261116T103000", zone: ZURICH },
      }),
    );
    mount(engine, port, "#/cal/day/2026-11-16");
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Glaze firing" })).toBeTruthy();
  });

  it.each([
    ["day", "2026-01-31", "2026-02-01"],
    ["week", "2026-01-31", "2026-02-07"],
    ["month", "2026-01-31", "2026-02-01"],
    ["year", "2028-02-29", "2029-02-28"],
    ["agenda", "2026-01-31", "2026-02-01"],
  ])("steps the visible %s forward and returns to Today", (view, start, next) => {
    const { engine, port } = mirror();
    const { host } = mount(engine, port, `#/cal/${view}/${start}`);
    const head = screen.getByRole("heading", { level: 1 }).closest("header")!;
    fireEvent.click(within(head).getByRole("button", { name: "After" }));
    expect(host.device.address.read()).toBe(`#/cal/${view}/${next}`);
    fireEvent.click(within(head).getByRole("button", { name: "Before" }));
    expect(host.device.address.read()).not.toBe(`#/cal/${view}/${next}`);
    fireEvent.click(within(head).getByRole("button", { name: "Today" }));
    expect(host.device.address.read()).toBe(`#/cal/${view}`);
  });

  it.each([
    ["month", false, "ring", 700],
    ["week", false, "ring", 700],
    ["day", false, "ring", 700],
    ["month", true, "outline", 1200],
    ["week", true, "outline", 1200],
  ] as const)(
    "draws and clears the Today signal in %s (reduced motion: %s)",
    (view, reduced, signal, duration) => {
      vi.useFakeTimers({
        toFake: ["Date", "requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"],
      });
      vi.setSystemTime(new Date("2026-11-21T10:00:00Z"));
      vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
      onTestFinished(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
      });
      const { engine, port } = mirror();
      const { host } = mount(engine, port, `#/cal/${view}/2026-12-07`);
      const calendar = screen.getByRole("region", { name: "Calendar", exact: true });
      calendar.style.setProperty("--d-today-pulse", "700ms");
      calendar.style.setProperty("--d-today-outline", "1200ms");
      const today = within(calendar).getByRole("button", { name: "Today", exact: true });
      const badge = () => within(calendar).getByRole("button", { current: "date" });

      fireEvent.click(today);
      act(() => vi.advanceTimersByTime(48));
      expect(host.device.address.read()).toBe(`#/cal/${view}`);
      expect(badge().querySelector("[data-today-pulse]")?.getAttribute("data-today-pulse")).toBe(signal);
      const line = calendar.querySelector('[data-today-pulse-target="now"]');
      expect(line?.getAttribute("data-today-pulse") ?? null).toBe(
        view !== "month" && !reduced ? "ring" : null,
      );

      // Today is already in view. Another press restarts its full display time.
      act(() => vi.advanceTimersByTime(duration / 2));
      fireEvent.click(today);
      act(() => vi.advanceTimersByTime(48 + duration / 2));
      expect(badge().querySelector("[data-today-pulse]")?.getAttribute("data-today-pulse")).toBe(signal);
      act(() => vi.advanceTimersByTime(duration / 2));
      expect(badge().querySelector("[data-today-pulse]")).toBeNull();

      fireEvent.keyDown(document.body, { key: "t" });
      act(() => vi.advanceTimersByTime(48));
      expect(badge().querySelector("[data-today-pulse]")?.getAttribute("data-today-pulse")).toBe(signal);
    },
  );

  it("counts waiting invitations and suggestions from mail in the calendar rail", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 16, 9));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { engine, port, put } = mirror();
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, studio);
    put(
      "calendar_event",
      "invited",
      event("invited", "Kiln check", "20261117", {
        organizer: { address: "organizer@studio.test", name: "Organizer" },
        myAnswer: "none",
      }),
    );
    put("calendar_suggestion", "found", {
      id: "found",
      messageId: "message",
      mailboxId: "mailbox",
      evidence: "calendar",
      proposed: {
        title: "Exhibition",
        start: { kind: "zoned", value: "20261117T190000", zone: ZURICH },
        end: null,
        place: null,
      },
      sourceWords: null,
      createdAt: UPDATED,
      updatedAt: UPDATED,
    });
    mount(engine, port, "#/cal/week/2026-11-16");
    const rail = screen.getByRole("navigation", { name: "Calendar places" });
    expect(within(within(rail).getByRole("button", { name: "Invitations, 1" })).getByText("1")).toBeTruthy();
    expect(within(within(rail).getByRole("button", { name: "From mail, 1" })).getByText("1")).toBeTruthy();

    fireEvent.click(within(rail).getByRole("button", { name: "Settings" }));
    const mail = screen.getByRole("button", { name: "Mail and calendar" });
    expect(within(mail).getByText("1")).toBeTruthy();

    act(() => put("calendar_suggestion", "found", null));
    expect(within(rail).getByRole("button", { name: "From mail" })).toBeTruthy();
    expect(within(mail).queryByText("1")).toBeNull();
  });

  it("shows the calendar provider and account count in the Settings menu", () => {
    const { engine, port, put } = mirror();
    put("calendar_connection", connection.id, connection);
    mount(engine, port, "#/cal/calendars", "phone");
    const navigation = screen.getByRole("navigation", { name: "Settings sections" });
    const row = within(navigation).getByRole("button", { name: "Calendar accounts" });
    expect(within(row).getByText("Google")).toBeTruthy();
    expect(within(row).getByText("1")).toBeTruthy();
  });

  it("shows waiting invitations on the phone dock's More button", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 16, 9));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { engine, port, put } = mirror();
    put("calendar_connection", connection.id, connection);
    put("calendar", studio.id, studio);
    put(
      "calendar_event",
      "invited",
      event("invited", "Kiln check", "20261117", {
        organizer: { address: "organizer@studio.test", name: "Organizer" },
        myAnswer: "none",
      }),
    );
    mount(engine, port, "#/cal/day/2026-11-16", "phone");
    const dock = screen.getByRole("navigation", { name: "Calendar" });
    expect(within(within(dock).getByRole("button", { name: "More, 1" })).getByText("1")).toBeTruthy();
    act(() => put("calendar_event", "invited", null));
    expect(within(dock).getByRole("button", { name: "More" })).toBeTruthy();
  });

  it("checks the calendar accounts from the phone head and the p shortcut", async () => {
    const { engine, port, put, check } = mirror();
    put("calendar_connection", connection.id, connection);
    mount(engine, port, "#/cal/day/2026-11-16", "phone");
    const head = screen.getByRole("heading", { level: 1 }).closest("header")!;

    fireEvent.click(within(head).getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Check now" }));
    await act(async () => {});
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(connection.id);

    fireEvent.keyDown(document.body, { key: "p" });
    await act(async () => {});
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("checks all accounts from the calendar accounts toolbar", async () => {
    const { engine, port, put, check } = mirror();
    put("calendar_connection", connection.id, connection);
    mount(engine, port, "#/cal/calendars/calaccounts");
    const toolbar = screen.getByRole("toolbar", { name: "Calendar accounts" });
    fireEvent.click(within(toolbar).getByRole("button", { name: "Check now" }));
    await act(async () => {});
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(connection.id);
  });

  it("switches to mail from the phone's From mail place", () => {
    const { engine, port } = mirror();
    const { host } = mount(engine, port, "#/cal/from-mail", "phone");
    const heading = screen.getByRole("heading", { name: "From mail", level: 1 });
    fireEvent.click(within(heading.closest("header")!).getByRole("button", { name: "Mail" }));
    expect(host.device.address.read()).toBe("#/ohbox");
  });

  it("returns to the open view when Settings is pressed again in the calendar rail", () => {
    const { engine, port } = mirror();
    const { host } = mount(engine, port, "#/cal/month/2026-11-16");
    const rail = screen.getByRole("navigation", { name: "Calendar places" });
    fireEvent.click(within(rail).getByRole("button", { name: "Settings" }));
    expect(host.device.address.read()).toBe("#/cal/calendars");
    fireEvent.click(within(rail).getByRole("button", { name: "Settings" }));
    expect(host.device.address.read()).toBe("#/cal/month/2026-11-16");
  });

  it("closes the Invitations panel when its rail entry is pressed again", () => {
    const { engine, port } = mirror();
    const { host } = mount(engine, port, "#/cal/week/2026-11-16");
    const rail = screen.getByRole("navigation", { name: "Calendar places" });
    fireEvent.click(within(rail).getByRole("button", { name: "Invitations" }));
    expect(host.device.address.read()).toBe("#/cal/week/2026-11-16?panel=invitations");
    fireEvent.click(within(rail).getByRole("button", { name: "Invitations" }));
    expect(host.device.address.read()).toBe("#/cal/week/2026-11-16");
  });

  it("animates the product switch knob when the calendar rail replaces the mail rail", () => {
    const { engine, port } = mirror();
    const style = document.createElement("style");
    style.textContent = ".oh-switcher-knob { --d-knob: 180ms; }";
    document.head.append(style);
    const animation = vi.spyOn(Element.prototype, "animate").mockReturnValue({
      addEventListener() {},
      cancel() {},
    } as unknown as Animation);
    onTestFinished(() => {
      style.remove();
      animation.mockRestore();
    });
    mount(engine, port, "#/cal/month/2026-11-16");
    fireEvent.click(screen.getByRole("button", { name: "Mail" }));
    fireEvent.click(screen.getByRole("button", { name: "Calendar" }));
    expect(
      animation.mock.calls.some(
        ([frames]) => Array.isArray(frames) && frames[0]?.transform === "translateX(-100%)",
      ),
    ).toBe(true);
  });
});
