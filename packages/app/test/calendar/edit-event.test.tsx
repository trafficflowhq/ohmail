/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CalendarEventRecord } from "@ohmail/app-logic/calendar";
import calmail from "../../messages/calmail.en.json" with { type: "json" };
import * as room from "../../src/frame/room.js";
import { draftOfRecord, eventChanges } from "../../src/calendar/edit-draft.js";
import {
  calendarRecord,
  connectionRecord,
  mirror,
  mountFrame,
  NONE,
  UPDATED,
  ZURICH,
} from "../calsetup/world.js";

function meeting(over: Partial<CalendarEventRecord> = {}): CalendarEventRecord {
  return {
    id: "firing",
    calendarId: "cal-1",
    uid: "firing",
    recurrenceId: "",
    thisAndFuture: false,
    sequence: 0,
    status: "confirmed",
    title: "Kiln check",
    notes: null,
    place: "Workshop",
    callLink: null,
    start: { kind: "zoned", value: "20261116T090000", zone: ZURICH },
    end: { kind: "zoned", value: "20261116T100000", zone: ZURICH },
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
function open(record: CalendarEventRecord) {
  const world = mirror();
  world.put("calendar_connection", "conn-1", connectionRecord());
  world.put("calendar", "cal-1", calendarRecord());
  world.put("calendar_event", record.id, record);
  const mounted = mountFrame("#/cal/week/2026-11-16/e/firing", world, NONE, { words: calmail });
  return { world, ...mounted };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-16T08:00:00Z"));
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("submits only the fields changed in a personal event when its card closes", async () => {
  const record = meeting();
  const { world } = open(record);
  const press = vi.fn(async () => ({ key: "change" }));
  world.port.press = press;
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const edit = within(screen.getByRole("dialog", { name: "Edit event" }));
  fireEvent.change(edit.getByRole("textbox", { name: "Event title" }), { target: { value: "Glaze check" } });
  expect(press).not.toHaveBeenCalled();
  fireEvent.click(edit.getByRole("button", { name: "Close" }));
  await act(async () => {});
  expect(press.mock.calls).toEqual([
    [
      {
        kind: "calendar_event_update",
        scope: { kind: "record" },
        base: record.updatedAt,
        eventId: record.id,
        change: { title: "Glaze check" },
        audience: { organizer: null, guests: [] },
      },
    ],
  ]);
  expect(screen.queryByRole("dialog", { name: "Edit event" })).toBeNull();
});
it("withdraws the editor and its unsent words when the calendar becomes busy-only", async () => {
  const { world } = open(meeting());
  const press = vi.fn(async () => ({ key: "change" }));
  world.port.press = press;
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Event title" }), {
    target: { value: "New private words" },
  });
  act(() => world.put("calendar", "cal-1", calendarRecord({ access: "busy" })));
  expect(screen.getByRole("dialog", { name: "Busy" })).toBeTruthy();
  expect(screen.queryByDisplayValue("New private words")).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  expect(press).not.toHaveBeenCalled();
});
it("preserves an existing long event and its provider fields when only the place changes", () => {
  const r = meeting({
    end: { kind: "zoned", value: "20261120T120000", zone: ZURICH },
    notes: "Provider note",
    private: true,
  });
  const initial = draftOfRecord(r);
  expect(initial.timeEditable).toBe(false);
  expect(eventChanges(r, { ...initial.draft, place: "Studio" }, calendarRecord(), ZURICH)).toEqual({
    place: "Studio",
  });
});
it("keeps the clock type and exclusive end when rescheduling a simple event", () => {
  const r = meeting({
    start: { kind: "instant", value: "20261116T220000Z" },
    end: { kind: "instant", value: "20261116T230000Z" },
  });
  const initial = draftOfRecord(r);
  expect(initial.timeEditable).toBe(true);
  expect(eventChanges(r, { ...initial.draft, to: "01:30" }, calendarRecord(), ZURICH)).toEqual({
    start: r.start,
    end: { kind: "instant", value: "20261117T013000Z" },
  });
  expect(eventChanges(r, { ...initial.draft, allDay: true }, calendarRecord(), ZURICH)).toEqual({
    start: { kind: "date", value: "20261116" },
    end: { kind: "date", value: "20261117" },
  });
});

const organizer = { name: "Clay Studio", address: "studio@example.invalid" };
const guest = {
  name: "Morgan Glass",
  address: "morgan@example.invalid",
  role: "required",
  answer: "accepted",
} as const;

it("keeps a shared event read-only when its organizer cannot be identified as this account", async () => {
  vi.spyOn(room, "useKnownOwnAddresses").mockReturnValue([organizer.address]);
  open(meeting({ invitees: [guest] }));
  const card = await screen.findByRole("dialog", { name: "Kiln check" });
  expect(within(card).queryByRole("button", { name: "Edit" })).toBeNull();
});

it("asks the organizer before any guest update, keeps a cancelled edit, and sends only the named change", async () => {
  vi.spyOn(room, "useKnownOwnAddresses").mockReturnValue([organizer.address]);
  const record = meeting({ organizer, invitees: [guest] });
  const { world } = open(record);
  const press = vi.fn(async () => ({ key: "edit" }));
  world.port.press = press;
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const form = within(screen.getByRole("dialog", { name: "Edit event" }));
  const title = form.getByRole("textbox", { name: "Event title" });
  fireEvent.change(title, { target: { value: "Moved firing" } });
  fireEvent.click(form.getByRole("button", { name: "Close" }));
  const question = () => within(screen.getByRole("dialog", { name: /Morgan Glass/ }));
  expect(press).not.toHaveBeenCalled();
  fireEvent.click(question().getByRole("button", { name: "Cancel" }));
  expect((title as HTMLInputElement).value).toBe("Moved firing");
  expect(press).not.toHaveBeenCalled();
  fireEvent.click(form.getByRole("button", { name: "Close" }));
  fireEvent.click(question().getByRole("button", { name: "Send update" }));
  await act(async () => {});
  expect(press.mock.calls).toEqual([
    [
      {
        kind: "calendar_event_update",
        scope: { kind: "record" },
        eventId: record.id,
        base: record.updatedAt,
        change: { title: "Moved firing" },
        audience: { organizer: organizer.address, guests: [guest.address] },
      },
    ],
  ]);
});

it("requires a fresh decision when the guest list changes before confirmation", async () => {
  vi.spyOn(room, "useKnownOwnAddresses").mockReturnValue([organizer.address]);
  const record = meeting({ organizer, invitees: [guest] });
  const { world } = open(record);
  const press = vi.fn(async () => ({ key: "once" }));
  world.port.press = press;
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const form = within(screen.getByRole("dialog", { name: "Edit event" }));
  fireEvent.change(form.getByRole("textbox", { name: "Event title" }), { target: { value: "Open kiln" } });
  fireEvent.click(form.getByRole("button", { name: "Close" }));
  const first = within(screen.getByRole("dialog", { name: /Morgan Glass/ })).getByRole("button", {
    name: "Send update",
  });
  act(() =>
    world.put(
      "calendar_event",
      record.id,
      meeting({
        organizer,
        invitees: [guest, { ...guest, name: "Riley Clay", address: "riley@example.test" }],
      }),
    ),
  );
  fireEvent.click(first);
  expect(press).not.toHaveBeenCalled();
  const latest = within(screen.getByRole("dialog", { name: /Riley Clay/ }));
  fireEvent.click(latest.getByRole("button", { name: "Send update" }));
  await act(async () => {});
  expect(press).toHaveBeenCalledTimes(1);
});

it("asks about an invited mailbox even when the same account owns it", async () => {
  vi.spyOn(room, "useKnownOwnAddresses").mockReturnValue([organizer.address, guest.address]);
  const { world } = open(meeting({ organizer, invitees: [guest] }));
  const press = vi.fn(async () => ({ key: "edit" }));
  world.port.press = press;
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const form = within(screen.getByRole("dialog", { name: "Edit event" }));
  fireEvent.change(form.getByRole("textbox", { name: "Event title" }), { target: { value: "Moved firing" } });
  fireEvent.click(form.getByRole("button", { name: "Close" }));
  await act(async () => {});
  expect(press).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: /Morgan Glass/ })).toBeTruthy();
});

it.each(["This event", "This and following", "All events"])(
  "asks which dates to change and honors %s",
  async (label) => {
    const at = String(Date.UTC(2026, 10, 17));
    const world = mirror();
    world.put("calendar_connection", "conn-1", { ...connectionRecord(), provider: "caldav" });
    world.put("calendar", "cal-1", calendarRecord());
    const event = meeting({
      start: { kind: "date", value: "20261116" },
      end: { kind: "date", value: "20261117" },
      startsAt: "2026-11-16T00:00:00Z",
      personalSeries: true,
      repeat: { rules: ["FREQ=DAILY;COUNT=4"], added: [], excluded: [] },
    });
    world.put("calendar_event", event.id, event);
    const press = vi.fn(async () => ({ key: "change" }));
    world.port.press = press;
    mountFrame(`#/cal/week/2026-11-17/e/firing@${at}`, world, NONE, { words: calmail });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const form = within(screen.getByRole("dialog", { name: "Edit event" }));
    fireEvent.change(form.getByRole("textbox", { name: "Event title" }), { target: { value: "New firing" } });
    fireEvent.click(form.getByRole("button", { name: "Close" }));
    const question = () => within(screen.getByRole("dialog", { name: "Which events will change?" }));
    fireEvent.click(question().getByRole("button", { name: "Cancel" }));
    expect(press).not.toHaveBeenCalled();
    expect((form.getByRole("textbox", { name: "Event title" }) as HTMLInputElement).value).toBe("New firing");
    fireEvent.click(form.getByRole("button", { name: "Close" }));
    fireEvent.click(question().getByRole("menuitem", { name: new RegExp(label) }));
    await act(async () => {});
    const scope =
      label === "All events"
        ? { kind: "record" }
        : label === "This event"
          ? { kind: "occurrence", at }
          : { kind: "following", at, newEventId: "new" };
    expect(press).toHaveBeenCalledTimes(1);
    expect(press).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "calendar_event_update",
        eventId: event.id,
        scope,
        change: { title: "New firing" },
        personalSeries: true,
      }),
    );
  },
);
