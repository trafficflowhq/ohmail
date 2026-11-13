/** @vitest-environment jsdom */
/**
 * THE CALENDAR'S BODY IN THE FRAME: it draws what the mirror holds and follows every change with no press (it keeps no
 * list), and says in one line where the host hands in no port.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import type {
  CalendarConnectionRecord,
  CalendarEventRecord,
  CalendarPort,
  CalendarRecord,
} from "@ohmail/app-logic/calendar";
import agendaEn from "../../messages/agenda.en.json" with { type: "json" };
import calendarEn from "../../messages/calendar.en.json" with { type: "json" };
import calsearchEn from "../../messages/calsearch.en.json" with { type: "json" };
import dayEn from "../../messages/day.en.json" with { type: "json" };
import eventEn from "../../messages/event.en.json" with { type: "json" };
import monthEn from "../../messages/month.en.json" with { type: "json" };
import weekEn from "../../messages/week.en.json" with { type: "json" };
import yearEn from "../../messages/year.en.json" with { type: "json" };
import { calendar } from "../../src/calendar/entry.js";
import { Frame } from "../../src/frame/Frame.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import { NONE } from "../../src/host/index.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

const ZURICH = "Europe/Zurich";
const UPDATED = "2026-11-01T08:00:00.000Z";
const WORDS = {
  ...FRAME_WORDS.en,
  ...agendaEn,
  ...calendarEn,
  ...calsearchEn,
  ...dayEn,
  ...eventEn,
  ...monthEn,
  ...weekEn,
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
  isDefault: true,
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
function mirror() {
  const kinds = new Map<string, Map<string, unknown>>();
  const heard = new Set<() => void>();
  /* What the queue says waits for a record, by its id. */
  const waits = new Map<string, "device" | "provider">();
  let version = 0;
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
    settings: () => new Promise(() => undefined),
    held: () => ({ window: { daysBack: 30, daysAhead: 365, maxRows: 5000 }, loaded: [] }),
    load: "none",
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
  return { engine, port, put, waits };
}

function mount(engine: OhmailEngine, port: CalendarPort | typeof NONE, at = "#/cal/agenda/2026-11-16") {
  const made = fakeHost({
    engine,
    service: "managed",
    scope: "acct-1",
    calendar,
    products: "both",
    wires: { calendar: port },
    address: fakeAddress(at),
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

  it("says in the Week, the Day and the Year where their days reach past the last day this device holds", () => {
    // The mirror holds 365 days ahead of today; a span 400 days ahead reaches past them.
    const far = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
    for (const view of ["week", "day", "year"]) {
      const { engine, port, put } = mirror();
      put("calendar_connection", connection.id, connection);
      put("calendar", studio.id, studio);
      mount(engine, port, `#/cal/${view}/${far}`);
      expect(screen.getByText("Later days stay with the calendar.")).toBeTruthy();
      cleanup();
    }
  });

  it("lists in the Agenda beside the Week the days after the week, not only the week's", () => {
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

  it("says on the Week's chips which of the two kinds of waiting each event waits for, never one for the other", () => {
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
    expect(screen.getByRole("button", { name: /Kiln check/ }).textContent).toContain(
      "Not sent yet from this device",
    );
    expect(screen.getByRole("button", { name: /Glaze firing/ }).textContent).toContain(
      "Waiting for the calendar",
    );
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
