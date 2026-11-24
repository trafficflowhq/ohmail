/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayShort, type CalendarEventRecord, type CalendarPort } from "@ohmail/app-logic/calendar";
import calendarDe from "../../messages/calendar.de.json" with { type: "json" };
import calmail from "../../messages/calmail.en.json" with { type: "json" };
import invitationsEn from "../../messages/invitations.en.json" with { type: "json" };
import { calendar } from "../../src/calendar/entry.js";
import { fakeMail, mountReader, WORDS as readerWords } from "../reader/support/mail.js";
import type { EngineMessage, MessageDTO } from "@ohmail/wire";
import { letter } from "../reader/support/fake-mail.js";
import { fakeAddress } from "../support/fake-window.js";
import { draftOfRecord, eventChanges } from "../../src/calendar/edit-draft.js";
import {
  calendarRecord,
  connectionRecord,
  mirror,
  mountFrame,
  setupPort,
  NONE,
  UPDATED,
  ZURICH,
  WORDS as calendarWords,
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
    portableCopy: true,
    updatedAt: UPDATED,
    ...(over.repeat && {
      deleteScopes: ["record", "occurrence", "following"] as const,
      deleteMembers: [{ at: null, range: false, organizer: null, guests: [] }],
    }),
    ...over,
  };
}
function eventWorld(record: CalendarEventRecord) {
  const world = mirror();
  world.put("calendar_connection", "conn-1", connectionRecord());
  world.put("calendar", "cal-1", calendarRecord());
  world.put("calendar_event", record.id, record);
  return world;
}
function open(record: CalendarEventRecord) {
  const world = eventWorld(record);
  const mounted = mountFrame("#/cal/week/2026-11-16/e/firing", world, NONE, { words: calmail });
  return { world, ...mounted };
}
it.each([
  ["en", "overlaps Crossing", "overlaps Later"],
  ["de", "überschneidet sich mit Crossing", "überschneidet sich mit Later"],
] as const)(
  "shows a calendar square for an overlap in %s and skips adjacent events",
  (locale, crossing, later) => {
    const world = eventWorld(meeting());
    world.put("calendar_event", "crossing", meeting({ id: "crossing", uid: "crossing", title: "Crossing" }));
    world.put(
      "calendar_event",
      "later",
      meeting({
        id: "later",
        uid: "later",
        title: "Later",
        start: { kind: "zoned", value: "20261116T100000", zone: ZURICH },
        end: { kind: "zoned", value: "20261116T110000", zone: ZURICH },
      }),
    );
    mountFrame("#/cal/week/2026-11-16/e/firing", world, NONE, {
      locale,
      words: locale === "de" ? calendarDe : undefined,
    });
    const card = within(screen.getByRole("dialog", { name: "Kiln check" }));
    expect(card.getByText(crossing).firstElementChild).toBeTruthy();
    expect(card.queryByText(later)).toBeNull();
  },
);

it.each(["version_stale", "expired", "read_only"] as const)(
  "uses the read layout for a %s write",
  async (refusal) => {
    const world = eventWorld(meeting());
    const events = world.port.events();
    world.port.events = () => events.map((event) => ({ ...event, refusal, refusedWriteId: "failed-write" }));
    const press = vi.fn(async () => ({ key: "retry" }));
    world.port.press = press;
    mountFrame("#/cal/week/2026-11-16/e/firing", world, NONE, { words: invitationsEn });
    const card = within(screen.getByRole("dialog", { name: "Kiln check" }));
    if (refusal === "version_stale") {
      expect(card.getByText("changed elsewhere").hasAttribute("data-hot")).toBe(true);
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    } else {
      expect(card.getByText("Not saved")).toBeTruthy();
      const toolbar = within(screen.getByRole("toolbar", { name: "Event actions" }));
      const primary = toolbar.getByRole("button", { name: "Try again" });
      expect(toolbar.getAllByRole("button")[0]).toBe(primary);
      expect(toolbar.getByRole("button", { name: "Edit" })).toBeTruthy();
      fireEvent.click(primary);
      expect(press.mock.calls).toEqual([[{ kind: "calendar_write_retry", writeId: "failed-write" }]]);
      await act(async () => {});
    }
  },
);

it("offers Duplicate and moves Hide this calendar under More for a read-only event", async () => {
  const world = eventWorld(meeting());
  world.put("calendar", "cal-1", calendarRecord({ access: "reader" }));
  world.put("calendar", "personal", calendarRecord({ id: "personal", name: "Personal" }));
  const setup = setupPort(async () => []);
  mountFrame("#/cal/week/2026-11-16/e/firing", world, setup);
  expect(screen.getByRole("button", { name: "Duplicate" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  const toolbar = within(screen.getByRole("toolbar", { name: "Event actions" }));
  fireEvent.click(toolbar.getByRole("button", { name: "More" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Hide this calendar" }));
  expect(setup.setCalendar).toHaveBeenCalledWith("cal-1", { shown: false });
  await act(async () => {});
  const press = vi.fn(async () => ({ key: "create" }));
  world.port.press = press;
  fireEvent.click(toolbar.getByRole("button", { name: "Duplicate" }));
  const draft = within(screen.getByRole("dialog", { name: "New event" }));
  expect((draft.getByRole("textbox", { name: "New event" }) as HTMLInputElement).value).toBe("Kiln check");
  expect(draft.getByRole("button", { name: "Calendar" }).textContent).toContain("Personal");
  expect(press).not.toHaveBeenCalled();
});

it("opens the event selected from the Week context menu", () => {
  const world = eventWorld(meeting());
  mountFrame("#/cal/week/2026-11-16", world, NONE);
  const event = screen.getByRole("button", { name: /Kiln check/ });
  fireEvent.contextMenu(event, { clientX: 200, clientY: 180 });
  const menu = within(screen.getByRole("menu", { name: "Event actions" }));
  fireEvent.click(menu.getByRole("menuitem", { name: "Open event" }));
  expect(screen.getByRole("dialog", { name: "Kiln check" })).toBeTruthy();
});

it("opens the Week event menu from the keyboard and returns focus to the event on Escape", () => {
  const world = eventWorld(meeting());
  mountFrame("#/cal/week/2026-11-16", world, NONE);
  const event = screen.getByRole("button", { name: /Kiln check/ });
  event.focus();
  fireEvent.keyDown(event, { key: "F10", shiftKey: true });
  const menu = within(screen.getByRole("menu", { name: "Event actions" }));
  const first = menu.getByRole("menuitem", { name: "Open event" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "Escape" });
  expect(screen.queryByRole("menu", { name: "Event actions" })).toBeNull();
  expect(document.activeElement).toBe(event);
});

it("opens the same editor directly from the Week event context menu", () => {
  const world = eventWorld(meeting());
  mountFrame("#/cal/week/2026-11-16", world, NONE);
  fireEvent.contextMenu(screen.getByRole("button", { name: /Kiln check/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  const editor = within(screen.getByRole("dialog", { name: "Edit event" }));
  expect(editor.getByRole("textbox", { name: "Event title" })).toHaveProperty("value", "Kiln check");
});

it("duplicates the event from its Week context menu without saving the copy", () => {
  const world = eventWorld(meeting());
  const press = vi.fn();
  world.port.press = press;
  mountFrame("#/cal/week/2026-11-16", world, NONE);
  fireEvent.contextMenu(screen.getByRole("button", { name: /Kiln check/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
  const draft = within(screen.getByRole("dialog", { name: "New event" }));
  expect(draft.getByRole("textbox", { name: "New event" })).toHaveProperty("value", "Kiln check");
  expect(press).not.toHaveBeenCalled();
});

it("uses the selected grid half hour for a new event", () => {
  const world = eventWorld(meeting());
  mountFrame("#/cal/week/2026-11-16", world, NONE);
  const tuesday = screen.getByRole("group", { name: /Tuesday, November 17/ });
  vi.spyOn(tuesday, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 90, 1440));
  fireEvent.contextMenu(tuesday, { clientX: 45, clientY: 687 });
  fireEvent.click(screen.getByRole("menuitem", { name: "New event" }));
  const editor = within(screen.getByRole("dialog", { name: "New event" }));
  expect(editor.getByLabelText("Start time")).toHaveProperty("value", "09:30");
  expect(editor.getByLabelText("End time")).toHaveProperty("value", "10:30");
});

it("goes to the day selected from the Week grid context menu", () => {
  const world = eventWorld(meeting());
  const { address } = mountFrame("#/cal/week/2026-11-16", world, NONE);
  const friday = screen.getByRole("group", { name: /Friday, November 20/ });
  vi.spyOn(friday, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 90, 1440));
  fireEvent.contextMenu(friday, { clientX: 45, clientY: 687 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Day" }));
  expect(address.read()).toBe("#/cal/day/2026-11-20");
});

function openWithMailboxes(
  record: CalendarEventRecord,
  mailboxes: () => Promise<unknown[]>,
  route = "#/cal/week/2026-11-16/e/firing",
  letters: readonly EngineMessage[] = [],
) {
  const world = eventWorld(record);
  mountReader({
    letters,
    open: null,
    host: {
      engine: Object.assign(fakeMail([]).engine, { store: world.engine.store }),
      calendar,
      products: "both",
      wires: { calendar: world.port },
      mailboxes,
      address: fakeAddress(route),
    },
    words: { ...readerWords.en, ...calendarWords.en, ...calmail, ...invitationsEn },
  });
  return world;
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

it("saves only the fields changed in a personal event and returns to its card", async () => {
  const record = meeting();
  const { world } = open(record);
  const press = vi.fn(async () => ({ key: "change" }));
  world.port.press = press;
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const edit = within(screen.getByRole("dialog", { name: "Edit event" }));
  fireEvent.change(edit.getByRole("textbox", { name: "Event title" }), { target: { value: "Glaze check" } });
  expect(press).not.toHaveBeenCalled();
  fireEvent.click(edit.getByRole("button", { name: "Save" }));
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
  expect(screen.getByRole("dialog", { name: record.title })).toBeTruthy();
});

it("the event date opens the current calendar picker and accepts a day with the keyboard", async () => {
  open(meeting());
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const edit = within(screen.getByRole("dialog", { name: "Edit event" }));
  const date = edit.getByRole("button", { name: "Event date" });
  fireEvent.click(date);
  const grid = within(screen.getByRole("dialog", { name: "Event date" })).getByRole("grid");
  expect(grid.closest(".calendar-date-picker")).not.toBeNull();
  const current = grid.querySelector<HTMLButtonElement>('[data-day="2026-11-16"]')!;
  const next = grid.querySelector<HTMLButtonElement>('[data-day="2026-11-17"]')!;
  expect(document.activeElement).toBe(current);
  fireEvent.keyDown(current, { key: "ArrowRight" });
  expect(document.activeElement).toBe(next);
  fireEvent.keyDown(next, { key: "Enter" });
  expect(screen.queryByRole("dialog", { name: "Event date" })).toBeNull();
  expect(date.textContent).toBe(dayShort("2026-11-17", "en", "2026"));
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
  expect(initial.timeEditable).toBe(true);
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

function mailbox(address: string) {
  return { id: address, address, addressIsOwn: true, status: "connected" };
}

it.each(["google", "microsoft", "caldav"] as const)(
  "offers Edit for a meeting the account organized and attends on %s",
  async (provider) => {
    const me = { ...guest, ...organizer };
    const record = meeting({ organizer, invitees: [me, guest], myAnswer: "accepted" });
    const world = openWithMailboxes(record, async () => [mailbox(organizer.address)]);
    act(() => world.put("calendar_connection", "conn-1", connectionRecord({ provider })));
    const card = within(await screen.findByRole("dialog", { name: record.title }));
    fireEvent.click(await card.findByRole("button", { name: "Edit" }));
    expect(screen.getByRole("dialog", { name: "Edit event" })).toBeTruthy();
  },
);

it("keeps a shared event read-only when its organizer cannot be identified as this account", async () => {
  const read = vi.fn(async () => [mailbox(organizer.address)]);
  openWithMailboxes(meeting({ invitees: [guest] }), read);
  const card = await screen.findByRole("dialog", { name: "Kiln check" });
  await act(async () => {});
  expect(read).toHaveBeenCalled();
  expect(within(card).queryByRole("button", { name: "Edit" })).toBeNull();
});

it("asks the organizer before any guest update, keeps a cancelled edit, and sends only the named change", async () => {
  const record = meeting({ organizer, invitees: [guest] });
  const world = openWithMailboxes(record, async () => [mailbox(organizer.address)]);
  const press = vi.fn(async () => ({ key: "edit" }));
  world.port.press = press;
  world.port.verdict = () => ({ kind: "taken", write: null });
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const form = within(screen.getByRole("dialog", { name: "Edit event" }));
  const title = form.getByRole("textbox", { name: "Event title" });
  fireEvent.change(title, { target: { value: "Moved firing" } });
  fireEvent.click(form.getByRole("button", { name: "Save" }));
  const question = () => within(screen.getByRole("dialog", { name: /Morgan Glass/ }));
  expect(press).not.toHaveBeenCalled();
  fireEvent.click(question().getByRole("button", { name: "Cancel" }));
  expect((title as HTMLInputElement).value).toBe("Moved firing");
  expect(press).not.toHaveBeenCalled();
  fireEvent.click(form.getByRole("button", { name: "Save" }));
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
  expect(standingReports().join(" ")).toContain("Update sent to Morgan Glass");
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});

it("requires a fresh decision when the guest list changes before confirmation", async () => {
  const record = meeting({ organizer, invitees: [guest] });
  const world = openWithMailboxes(record, async () => [mailbox(organizer.address)]);
  const press = vi.fn(async () => ({ key: "once" }));
  world.port.press = press;
  world.port.verdict = () => ({ kind: "refused", word: "version_stale", details: null });
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const form = within(screen.getByRole("dialog", { name: "Edit event" }));
  fireEvent.change(form.getByRole("textbox", { name: "Event title" }), { target: { value: "Open kiln" } });
  fireEvent.click(form.getByRole("button", { name: "Save" }));
  const first = within(screen.getByRole("dialog", { name: /Morgan Glass/ })).getByRole("button", {
    name: "Send update",
  });
  const added = { ...guest, name: "Riley Clay", address: "riley@example.test" };
  const latestRecord = meeting({
    organizer,
    invitees: [guest, added],
    updatedAt: "2026-11-16T07:30:00Z",
  });
  act(() => world.put("calendar_event", record.id, latestRecord));
  fireEvent.click(first);
  expect(press).not.toHaveBeenCalled();
  const latest = within(screen.getByRole("dialog", { name: /Riley Clay/ }));
  fireEvent.click(latest.getByRole("button", { name: "Send update" }));
  await act(async () => {});
  expect(press.mock.calls).toEqual([
    [
      {
        kind: "calendar_event_update",
        scope: { kind: "record" },
        eventId: record.id,
        base: record.updatedAt,
        change: { title: "Open kiln" },
        audience: { organizer: organizer.address, guests: [guest.address, added.address] },
      },
    ],
  ]);
  // Confirming the new audience leaves the original edit version in place for the conflict check.
  expect(form.getByText("Changed elsewhere")).toBeTruthy();
  expect(form.getByRole("button", { name: "Keep mine" })).toBeTruthy();
  expect(form.getByRole("button", { name: "Keep theirs" })).toBeTruthy();
});

it("asks about an invited mailbox even when the same account owns it", async () => {
  const record = meeting({ organizer, invitees: [guest] });
  let publish!: (rows: unknown[]) => void;
  const read = vi.fn(
    () =>
      new Promise<unknown[]>((resolve) => {
        publish = resolve;
      }),
  );
  const world = openWithMailboxes(record, read);
  const press = vi.fn(async () => ({ key: "edit" }));
  world.port.press = press;
  const card = await screen.findByRole("dialog", { name: record.title });
  expect(read).toHaveBeenCalled();
  expect(within(card).queryByRole("button", { name: "Edit" })).toBeNull();
  await act(async () => publish([mailbox(organizer.address), mailbox(guest.address)]));
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const form = within(screen.getByRole("dialog", { name: "Edit event" }));
  fireEvent.change(form.getByRole("textbox", { name: "Event title" }), { target: { value: "Moved firing" } });
  fireEvent.click(form.getByRole("button", { name: "Save" }));
  await act(async () => {});
  expect(press).not.toHaveBeenCalled();
  const question = within(screen.getByRole("dialog", { name: /Morgan Glass/ }));
  fireEvent.click(question.getByRole("button", { name: "Send update" }));
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

it.each([
  ["caldav", "This event", "occurrence"],
  ["google", "This and following", "following"],
  ["microsoft", "All events", "record"],
] as const)("asks before saving an owned timed series with guests on %s", async (provider, label, scope) => {
  const at = String(Date.UTC(2026, 10, 17, 8));
  const event = meeting({
    startsAt: "2026-11-16T08:00:00Z",
    endsAt: "2026-11-16T09:00:00Z",
    repeat: { rules: ["FREQ=DAILY;COUNT=4"], added: [], excluded: [] },
    organizer,
    invitees: [guest],
    deleteMembers: undefined,
  });
  const world = openWithMailboxes(
    event,
    async () => [mailbox(organizer.address)],
    `#/cal/week/2026-11-17/e/firing@${at}`,
  );
  act(() => world.put("calendar_connection", "conn-1", connectionRecord({ provider })));
  const press = vi.fn(async () => ({ key: "change" }));
  world.port.press = press;
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const form = within(screen.getByRole("dialog", { name: "Edit event" }));
  fireEvent.change(form.getByRole("textbox", { name: "Event title" }), { target: { value: "New firing" } });
  fireEvent.click(form.getByRole("button", { name: "Save" }));
  const asks = within(screen.getByRole("dialog", { name: "Change New firing" }));
  expect(asks.getByText("Daily, 4 times")).toBeTruthy();
  fireEvent.click(asks.getByRole("menuitem", { name: new RegExp(label) }));
  const consent = () => within(screen.getByRole("dialog", { name: "Tell Morgan Glass" }));
  expect(press).not.toHaveBeenCalled();
  const reviewedAt = provider === "microsoft" ? "2026-11-16T09:00:00.000Z" : event.updatedAt;
  if (provider === "microsoft") {
    act(() => world.put("calendar_event", event.id, { ...event, updatedAt: reviewedAt }));
    fireEvent.click(consent().getByRole("button", { name: "Send update" }));
    expect(press).not.toHaveBeenCalled();
    const fresh = within(screen.getByRole("dialog", { name: "Change New firing" }));
    fireEvent.click(fresh.getByRole("menuitem", { name: new RegExp(label) }));
  }
  fireEvent.click(consent().getByRole("button", { name: "Send update" }));
  await vi.waitFor(() => {
    expect(press).toHaveBeenCalledTimes(1);
    expect(press).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "calendar_event_update",
        base: reviewedAt,
        eventId: event.id,
        scope:
          scope === "record"
            ? { kind: scope }
            : { kind: scope, at, ...(scope === "following" && { newEventId: "new" }) },
        change: { title: "New firing" },
        audience: { organizer: organizer.address, guests: [guest.address] },
      }),
    );
  });
});

it.each([
  ["caldav", "This event", "occurrence"],
  ["google", "This and following", "following"],
  ["microsoft", "All events", "record"],
] as const)("edits a changed occurrence with guests on %s", async (provider, label, kind) => {
  const at = String(Date.UTC(2026, 10, 17, 8));
  const recipient =
    kind === "occurrence"
      ? { ...guest, name: "Rowan Clay", address: ["rowan", "example.invalid"].join("@") }
      : guest;
  const master = meeting({
    startsAt: "2026-11-16T08:00:00Z",
    endsAt: "2026-11-16T09:00:00Z",
    repeat: { rules: ["FREQ=DAILY;COUNT=4"], added: [], excluded: [] },
    organizer,
    invitees: [guest],
    deleteMembers:
      provider === "caldav"
        ? [
            {
              at: null,
              range: false,
              organizer: organizer.address,
              guests: [{ name: guest.name, address: guest.address }],
            },
            {
              at: Number(at),
              range: false,
              organizer: organizer.address,
              guests: [{ name: recipient.name, address: recipient.address }],
            },
          ]
        : undefined,
  });
  const exception = meeting({
    id: "firing-changed",
    recurrenceId: at,
    occurrenceAt: "2026-11-17T08:00:00Z",
    start: { ...master.start, value: "20261117T110000" },
    end: { ...master.end!, value: "20261117T120000" },
    startsAt: "2026-11-17T10:00:00Z",
    endsAt: "2026-11-17T11:00:00Z",
    title: "Special firing",
    notes: "Use the side door",
    organizer,
    invitees: [recipient],
    updatedAt: "2026-11-16T10:00:00.000Z",
  });
  const world = openWithMailboxes(
    master,
    async () => [mailbox(organizer.address)],
    `#/cal/day/2026-11-17/e/firing@${at}`,
  );
  act(() => {
    world.put("calendar_connection", "conn-1", connectionRecord({ provider }));
    world.put("calendar_event", exception.id, exception);
  });
  const press = vi.fn(async () => ({ key: "edit-changed" }));
  world.port.press = press;
  const card = within(await screen.findByRole("dialog", { name: exception.title }));
  fireEvent.click(await card.findByRole("button", { name: "Edit" }));
  const form = within(screen.getByRole("dialog", { name: "Edit event" }));
  const title = form.getByRole("textbox", { name: "Event title" });
  expect(title).toHaveProperty("value", exception.title);
  fireEvent.change(title, { target: { value: "New firing" } });
  fireEvent.click(form.getByRole("button", { name: "Save" }));
  const select = () => within(screen.getByRole("dialog", { name: "Change New firing" }));
  expect(select().getByText(/All events keeps its other changes/)).toBeTruthy();
  fireEvent.click(select().getByRole("menuitem", { name: new RegExp(label) }));
  const recipientLabel = provider === "caldav" ? `${guest.name} and ${recipient.name}` : recipient.name;
  const confirm = () => within(screen.getByRole("dialog", { name: `Tell ${recipientLabel}` }));
  expect(press).not.toHaveBeenCalled();
  const reviewedAt = "2026-11-16T11:00:00.000Z";
  act(() => world.put("calendar_event", exception.id, { ...exception, updatedAt: reviewedAt }));
  fireEvent.click(confirm().getByRole("button", { name: "Send update" }));
  expect(press).not.toHaveBeenCalled();
  fireEvent.click(select().getByRole("menuitem", { name: new RegExp(label) }));
  const masterAt = "2026-11-16T12:00:00.000Z";
  if (kind !== "occurrence") {
    act(() => world.put("calendar_event", master.id, { ...master, updatedAt: masterAt }));
    fireEvent.click(confirm().getByRole("button", { name: "Send update" }));
    expect(press).not.toHaveBeenCalled();
    fireEvent.click(select().getByRole("menuitem", { name: new RegExp(label) }));
  }
  fireEvent.click(confirm().getByRole("button", { name: "Send update" }));
  await vi.waitFor(() => {
    expect(press).toHaveBeenCalledTimes(1);
    expect(press).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "calendar_event_update",
        eventId: exception.id,
        base: kind === "occurrence" ? reviewedAt : `${reviewedAt}/${masterAt}`,
        scope:
          kind === "record" ? { kind } : { kind, at, ...(kind === "following" && { newEventId: "new" }) },
        change: { title: "New firing" },
        audience: {
          organizer: organizer.address,
          guests: (provider === "caldav" ? [guest.address, recipient.address] : [recipient.address]).sort(),
        },
      }),
    );
  });
});

it.each(["master", "exception"] as const)(
  "does not reapply an old edited time after the %s moves",
  async (which) => {
    const at = String(Date.UTC(2026, 10, 17, 8));
    const master = meeting({
      startsAt: "2026-11-16T08:00:00Z",
      endsAt: "2026-11-16T09:00:00Z",
      repeat: { rules: ["FREQ=DAILY;COUNT=4"], added: [], excluded: [] },
    });
    const exception = meeting({
      id: "firing-changed",
      recurrenceId: at,
      occurrenceAt: "2026-11-17T08:00:00Z",
      start: { ...master.start, value: "20261117T110000" },
      end: { ...master.end!, value: "20261117T120000" },
      startsAt: "2026-11-17T10:00:00Z",
      endsAt: "2026-11-17T11:00:00Z",
      title: "Special firing",
      updatedAt: "2026-11-16T10:00:00.000Z",
    });
    const world = eventWorld(master);
    world.put("calendar_event", exception.id, exception);
    const press = vi.fn(async () => ({ key: "move-changed" }));
    world.port.press = press;
    mountFrame(`#/cal/day/2026-11-17/e/firing@${at}`, world, NONE, { words: calmail });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const form = within(screen.getByRole("dialog", { name: "Edit event" }));
    fireEvent.change(form.getByLabelText("Start time"), { target: { value: "11:30" } });
    fireEvent.click(form.getByRole("button", { name: "Save" }));
    const all = () => screen.queryByRole("menuitem", { name: /All events/ });
    expect(all()).toBeTruthy();
    const changed = which === "master" ? master : exception;
    act(() =>
      world.put("calendar_event", changed.id, {
        ...changed,
        start: { ...changed.start, value: which === "master" ? "20261116T091500" : "20261117T111500" },
        updatedAt: "2026-11-16T12:00:00.000Z",
      }),
    );
    fireEvent.click(all()!);
    const reasked = all();
    if (reasked) fireEvent.click(reasked);
    await act(async () => {});
    expect(press).not.toHaveBeenCalled();
    expect(form.getByText(/Open it again to see the latest version/)).toBeTruthy();
  },
);

it.each(["google", "microsoft", "caldav", "ics"] as const)(
  "explains why a read-only recurring event is unavailable on %s",
  async (provider) => {
    const at = String(Date.UTC(2026, 10, 17));
    const world = eventWorld(
      meeting({
        start: { kind: "date", value: "20261116" },
        end: { kind: "date", value: "20261117" },
        startsAt: "2026-11-16T00:00:00Z",
        endsAt: "2026-11-21T00:00:00Z",
        repeat: { rules: ["FREQ=DAILY;COUNT=4"], added: [], excluded: [] },
      }),
    );
    world.put("calendar_connection", "conn-1", connectionRecord({ provider }));
    world.put("calendar", "cal-1", calendarRecord({ access: "reader" }));
    mountFrame(`#/cal/week/2026-11-17/e/firing@${at}`, world, NONE);
    const press = vi.fn(async () => ({ key: "change" }));
    world.port.press = press;
    const card = within(await screen.findByRole("dialog", { name: "Kiln check" }));
    expect(card.getByText("View only")).toBeTruthy();
    expect(card.getByText("This calendar is view only")).toBeTruthy();
    expect(card.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(press).not.toHaveBeenCalled();
  },
);

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
    fireEvent.click(form.getByRole("button", { name: "Save" }));
    const question = () => within(screen.getByRole("dialog", { name: "Change New firing" }));
    expect(question().getByText("Daily, 4 times")).toBeTruthy();
    fireEvent.click(question().getByRole("button", { name: "Cancel" }));
    expect(press).not.toHaveBeenCalled();
    expect((form.getByRole("textbox", { name: "Event title" }) as HTMLInputElement).value).toBe("New firing");
    fireEvent.click(form.getByRole("button", { name: "Save" }));
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
        audience: { organizer: null, guests: [] },
      }),
    );
  },
);

it("opens Edit from an event with the E key and writes the changed form", async () => {
  const record = meeting();
  const { world } = open(record);
  const press = vi.fn(async () => ({ key: "edit" }));
  world.port.press = press;
  const card = await screen.findByRole("dialog", { name: record.title });
  const close = within(card).getByRole("button", { name: "Close" });
  close.focus();
  fireEvent.keyDown(close, { key: "e" });
  const edit = within(screen.getByRole("dialog", { name: "Edit event" }));
  fireEvent.change(edit.getByRole("textbox", { name: "Event title" }), { target: { value: "Glaze check" } });
  fireEvent.click(edit.getByRole("button", { name: "Save" }));
  await act(async () => {});
  expect(press).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "calendar_event_update",
      eventId: record.id,
      change: { title: "Glaze check" },
    }),
  );
});

it("deletes the opened personal event through the calendar queue", async () => {
  const record = meeting();
  const { world } = open(record);
  const press = vi.fn(async () => ({ key: "delete" }));
  world.port.press = press;
  await screen.findByRole("dialog", { name: record.title });
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await act(async () => {});
  expect(press.mock.calls).toEqual([
    [
      {
        kind: "calendar_event_delete",
        eventId: record.id,
        base: record.updatedAt,
        scope: { kind: "record" },
      },
    ],
  ]);
  expect(screen.queryByRole("dialog", { name: record.title })).toBeNull();
});

it("offers a guest-free event another provider’s owned calendar", async () => {
  const { world } = open(meeting());
  act(() => {
    world.put(
      "calendar_connection",
      "elsewhere",
      connectionRecord({ id: "elsewhere", provider: "microsoft" }),
    );
    world.put(
      "calendar",
      "personal",
      calendarRecord({ id: "personal", name: "Personal", connectionId: "elsewhere" }),
    );
  });
  const toolbar = within(await screen.findByRole("toolbar", { name: "Event actions" }));
  fireEvent.click(await toolbar.findByRole("button", { name: "Move to" }));
  expect(screen.getByRole("menuitem", { name: "Personal" })).toBeTruthy();
});

it("explains why fields that cannot be copied keep an event in its original calendar", async () => {
  const { world } = open(meeting({ portableCopy: undefined }));
  act(() => {
    world.put(
      "calendar_connection",
      "elsewhere",
      connectionRecord({ id: "elsewhere", provider: "microsoft" }),
    );
    world.put(
      "calendar",
      "personal",
      calendarRecord({ id: "personal", name: "Personal", connectionId: "elsewhere" }),
    );
  });
  const toolbar = within(await screen.findByRole("toolbar", { name: "Event actions" }));
  expect(toolbar.queryByRole("button", { name: "Move to" })).toBeNull();
  fireEvent.click(toolbar.getByRole("button", { name: "More" }));
  expect(screen.getByText("This event has details that another calendar can’t keep")).toBeTruthy();
});

it("explains why guests cannot move to a calendar on another connection", async () => {
  const world = openWithMailboxes(meeting({ organizer, invitees: [guest] }), async () => [
    mailbox(organizer.address),
  ]);
  act(() => {
    world.put("calendar_connection", "conn-1", connectionRecord({ provider: "google" }));
    world.put(
      "calendar_connection",
      "elsewhere",
      connectionRecord({ id: "elsewhere", provider: "microsoft" }),
    );
    world.put(
      "calendar",
      "personal",
      calendarRecord({ id: "personal", name: "Personal", connectionId: "elsewhere" }),
    );
  });
  const panel = within(await screen.findByRole("toolbar", { name: "Event actions" }));
  fireEvent.click(await panel.findByRole("button", { name: "More" }));
  expect(screen.getByText("Events with guests stay in their account’s calendars")).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Personal" })).toBeNull();
});

it("moves an event to another writable calendar of its Google connection", async () => {
  const record = meeting();
  const { world } = open(record);
  const press = vi.fn(async () => ({ key: "move" }));
  world.port.press = press;
  world.port.verdict = () => ({ kind: "taken", write: null });
  act(() => {
    world.put("calendar_connection", "conn-1", connectionRecord({ provider: "google" }));
    world.put("calendar", "other", calendarRecord({ id: "other", name: "Other work" }));
    world.put(
      "calendar",
      "read-only",
      calendarRecord({ id: "read-only", name: "Read only", access: "reader" }),
    );
    world.put(
      "calendar",
      "elsewhere",
      calendarRecord({ id: "elsewhere", name: "Other account", connectionId: "elsewhere" }),
    );
  });
  await screen.findByRole("dialog", { name: record.title });
  const move = screen.getByRole("button", { name: "Move to" });
  move.focus();
  fireEvent.keyDown(move, { key: "m" });
  const menu = within(screen.getByRole("menu", { name: "Move to" }));
  expect(menu.queryByRole("menuitem", { name: "Read only" })).toBeNull();
  expect(menu.queryByRole("menuitem", { name: "Other account" })).toBeNull();
  fireEvent.click(menu.getByRole("menuitem", { name: "Other work" }));
  await act(async () => {});
  expect(press.mock.calls).toEqual([
    [{ kind: "calendar_event_move", eventId: record.id, base: record.updatedAt, toCalendarId: "other" }],
  ]);
  expect(standingReports().join(" ")).toContain("Other work");
});

it("moves an opened event by fifteen minutes with Shift and an arrow", async () => {
  const record = meeting();
  const { world } = open(record);
  const press = vi.fn(async () => ({ key: "move" }));
  world.port.press = press;
  const card = within(await screen.findByRole("dialog", { name: record.title }));
  const close = card.getByRole("button", { name: "Close" });
  close.focus();
  fireEvent.keyDown(close, { key: "ArrowDown", shiftKey: true });
  await act(async () => {});
  expect(press).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "calendar_event_update",
      eventId: record.id,
      base: record.updatedAt,
      change: {
        start: { ...record.start, value: "20261116T091500" },
        end: { ...record.end, value: "20261116T101500" },
      },
    }),
  );
});

it.each(["caldav", "google", "microsoft"] as const)(
  "opens editing and moves an event on a shared writable %s calendar",
  async (provider) => {
    const record = meeting({
      organizer: { address: ["sharer", "example.test"].join("@"), name: "Other organizer" },
    });
    const world = eventWorld(record);
    world.put("calendar_connection", "conn-1", connectionRecord({ provider }));
    world.put("calendar", "cal-1", calendarRecord({ access: "writer" }));
    const press = vi.fn(async () => ({ key: "move" }));
    world.port.press = press;
    mountFrame("#/cal/week/2026-11-16/e/firing", world, NONE, { words: calmail });
    const card = within(await screen.findByRole("dialog", { name: record.title }));
    expect(card.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(card.queryByText("View only")).toBeNull();
    const close = card.getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.keyDown(close, { key: "ArrowDown", shiftKey: true });
    await act(async () => {});
    expect(press).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "calendar_event_update",
        eventId: record.id,
        change: {
          start: { ...record.start, value: "20261116T091500" },
          end: { ...record.end, value: "20261116T101500" },
        },
      }),
    );
  },
);

it.each(["owner", "writer", "reader"] as const)(
  "shows editing controls according to %s access when the invitation address is unknown",
  async (access) => {
    const record = meeting({ organizer, invitees: [guest] });
    const world = openWithMailboxes(record, async () => []);
    await act(async () => world.put("calendar", "cal-1", calendarRecord({ access })));
    const press = vi.fn(async () => ({ key: "move" }));
    world.port.press = press;
    const card = within(await screen.findByRole("dialog", { name: record.title }));
    const edit = card.queryByRole("button", { name: "Edit" });
    if (access === "writer") {
      expect(edit).toBeTruthy();
      expect(screen.getByRole("button", { name: "Cancel event" })).toBeTruthy();
    } else {
      expect(edit).toBeNull();
      expect(screen.queryByRole("button", { name: /^(Delete|Cancel event)$/ })).toBeNull();
      const close = card.getByRole("button", { name: "Close" });
      close.focus();
      fireEvent.keyDown(close, { key: "ArrowDown", shiftKey: true });
      await act(async () => {});
      expect(press).not.toHaveBeenCalled();
    }
  },
);

it("keeps the answer controls on an invitation on a writable shared calendar", async () => {
  const record = meeting({ organizer, invitees: [guest], myAnswer: "none" });
  const world = openWithMailboxes(record, async () => [mailbox(guest.address)]);
  await act(async () => world.put("calendar", "cal-1", calendarRecord({ access: "writer" })));
  const card = within(await screen.findByRole("dialog", { name: record.title }));
  expect(screen.getByRole("button", { name: "Yes" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "No" })).toBeTruthy();
  expect(card.queryByRole("button", { name: "Edit" })).toBeNull();
});

it.each(["caldav", "google", "microsoft"] as const)(
  "offers Delete on a writable shared %s series occurrence once the feed serves its scopes",
  async (provider) => {
    const at = Date.UTC(2026, 10, 16, 8);
    const record = meeting({
      organizer,
      repeat: { rules: ["FREQ=WEEKLY;COUNT=10"], added: [], excluded: [] },
      deleteScopes: undefined,
      deleteMembers: undefined,
    });
    const world = eventWorld(record);
    world.put("calendar_connection", "conn-1", connectionRecord({ provider }));
    world.put("calendar", "cal-1", calendarRecord({ access: "reader" }));
    mountFrame(`#/cal/week/2026-11-16/e/firing@${at}`, world, NONE, { words: calmail });
    await screen.findByRole("dialog", { name: record.title });
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    await act(async () => {
      world.put("calendar", "cal-1", calendarRecord({ access: "writer" }));
      world.put("calendar_event", record.id, {
        ...record,
        deleteScopes: ["record"],
        deleteMembers: [{ at: null, range: false, organizer: organizer.address, guests: [] }],
      });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(
      within(screen.getByRole("dialog", { name: /^Delete / })).getByRole("menuitem", { name: "All events" }),
    ).toBeTruthy();
  },
);

it.each(["week", "day", "guest confirmation", "invitee", "escape", "changed occurrence"])(
  "keeps a calendar drag usable with another event selected: %s",
  async (scenario) => {
    const changed = scenario === "changed occurrence";
    const invited = scenario === "guest confirmation";
    const invitee = scenario === "invitee";
    const view = scenario === "day" ? "day" : "week";
    const selected = meeting();
    const target = meeting({
      id: "workshop",
      uid: "workshop",
      title: "Workshop",
      start: { kind: "zoned", value: "20261116T110000", zone: ZURICH },
      end: { kind: "zoned", value: "20261116T120000", zone: ZURICH },
      ...((invited || changed) && { organizer, invitees: [guest] }),
      ...(changed && {
        recurrenceId: String(Date.UTC(2026, 10, 16, 8)),
        occurrenceAt: "2026-11-16T08:00:00Z",
      }),
      ...(invitee && {
        organizer: { address: guest.address, name: guest.name },
        invitees: [{ ...guest, ...organizer }],
        myAnswer: "accepted" as const,
      }),
    });
    const world = openWithMailboxes(
      selected,
      async () => [mailbox(organizer.address)],
      `#/cal/${view}/2026-11-16/e/${selected.id}`,
    );
    const press = vi.fn(async () => ({ key: "move" }));
    world.port.press = press;
    if (invited || changed) world.port.verdict = () => ({ kind: "taken", write: null });
    act(() => {
      if (changed)
        world.put(
          "calendar_event",
          "workshop-series",
          meeting({
            id: "workshop-series",
            uid: target.uid,
            startsAt: "2026-11-16T08:00:00Z",
            endsAt: "2026-11-16T09:00:00Z",
            repeat: { rules: ["FREQ=DAILY;COUNT=4"], added: [], excluded: [] },
          }),
        );
      if (changed) world.put("calendar_connection", "conn-1", connectionRecord({ provider: "google" }));
      world.put("calendar_event", target.id, target);
    });
    await act(async () => {});
    const event = screen.getByRole("button", { name: /^Workshop/ });
    const column = event.closest<HTMLElement>('[data-cal-drop-kind="time"]')!;
    vi.spyOn(column, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ width: 140, height: 1440 }));
    vi.spyOn(column, "clientHeight", "get").mockReturnValue(1440);
    vi.stubGlobal("PointerEvent", MouseEvent);
    const old = Object.getOwnPropertyDescriptor(document, "elementsFromPoint");
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [column] });
    const pointer = (node: EventTarget, type: string, y: number) =>
      fireEvent(
        node,
        Object.assign(new MouseEvent(type, { bubbles: true, clientX: 70, clientY: y }), {
          pointerId: 1,
          pointerType: "mouse",
        }),
      );
    try {
      pointer(event, "pointerdown", 674);
      pointer(document, "pointermove", 708);
      if (invitee) {
        expect(within(column).queryByText("11:30")).toBeNull();
        pointer(document, "pointerup", 708);
        expect(press).not.toHaveBeenCalled();
        fireEvent.click(event);
        const read = within(await screen.findByRole("dialog", { name: "Workshop" }));
        expect(read.getByText("The organizer sets the time")).toBeTruthy();
        return;
      }
      expect(within(column).getByText("11:30")).toBeTruthy();
      expect(press).not.toHaveBeenCalled();
      if (scenario === "escape") {
        fireEvent.keyDown(document, { key: "Escape" });
        expect(within(column).queryByText("11:30")).toBeNull();
      }
      pointer(document, "pointerup", 708);
      if (scenario === "escape") {
        expect(press).not.toHaveBeenCalled();
        expect(screen.getByRole("dialog", { name: selected.title })).toBeTruthy();
        return;
      }
      if (changed) {
        expect(press).not.toHaveBeenCalled();
        const ask = within(await screen.findByRole("dialog", { name: /^Move to / }));
        fireEvent.click(ask.getByRole("menuitem", { name: /This event/ }));
      }
      if (invited || changed) {
        const ask = within(await screen.findByRole("dialog", { name: "Tell Morgan Glass" }));
        expect(press).not.toHaveBeenCalled();
        fireEvent.click(ask.getByRole("button", { name: "Send update" }));
      }
      await vi.waitFor(() =>
        expect(press.mock.calls).toEqual([
          [
            expect.objectContaining({
              kind: "calendar_event_update",
              eventId: target.id,
              change: {
                start: { ...target.start, value: "20261116T113000" },
                end: { ...target.end, value: "20261116T123000" },
              },
            }),
          ],
        ]),
      );
      if (invited || changed) {
        await vi.waitFor(() => expect(standingReports().join(" ")).toContain("Update sent to Morgan Glass"));
        expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
      }
    } finally {
      vi.unstubAllGlobals();
      if (old) Object.defineProperty(document, "elementsFromPoint", old);
      else Reflect.deleteProperty(document, "elementsFromPoint");
    }
  },
);

it.each(["the empty slot", "the time axis", "another event"])(
  "an open calendar card yields to %s without opening a draft",
  async (where) => {
    const selected = meeting();
    const world = eventWorld(selected);
    const target = meeting({ id: "workshop", uid: "workshop", title: "Workshop" });
    world.put("calendar_event", target.id, target);
    const { address } = mountFrame("#/cal/week/2026-11-16/e/firing", world, NONE);
    const press = vi.fn();
    world.port.press = press;
    await screen.findByRole("dialog", { name: selected.title });
    const targetElement =
      where === "another event"
        ? screen.getByRole("button", { name: /^Workshop/ })
        : where === "the empty slot"
          ? screen.getByRole("group", { name: /Tue/ })
          : document.querySelector(".oh-tg-axis")!;
    fireEvent.pointerDown(targetElement, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(targetElement, { button: 0, pointerId: 1 });
    fireEvent.click(targetElement);
    expect(screen.queryByRole("dialog", { name: selected.title })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "New event" })).toBeNull();
    expect(press).not.toHaveBeenCalled();
    if (where === "another event") expect(screen.getByRole("dialog", { name: target.title })).toBeTruthy();
    else expect(address.read()).toBe("#/cal/week/2026-11-16");
  },
);

it.each([
  ["090000", "100000", "100000", "110000", false],
  ["090000", "100000", "100000", "110000", true],
  ["090700", "100700", "100000", "110000", false],
])(
  "drags a week event from %s to the snapped time, keeping its length",
  async (start, end, toStart, toEnd, altKey) => {
    const record = meeting({
      start: { kind: "zoned", zone: ZURICH, value: `20261116T${start}` },
      end: { kind: "zoned", zone: ZURICH, value: `20261116T${end}` },
    });
    const world = eventWorld(record);
    const press = vi.fn(async () => ({ key: "move" }));
    world.port.press = press;
    mountFrame("#/cal/week/2026-11-16", world, NONE);
    const chip = await screen.findByRole("button", { name: /Kiln check/ });
    const nextDay = screen.getByRole("group", { name: /Tue/ });
    const bounds = () => ({ top: 0, height: 1440 }) as DOMRect;
    vi.spyOn(chip.parentElement!, "getBoundingClientRect").mockImplementation(bounds);
    vi.spyOn(nextDay, "getBoundingClientRect").mockImplementation(bounds);
    const hit = vi.fn().mockReturnValue(nextDay);
    const originalHit = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hit });
    const pointer = (target: EventTarget, type: string, x: number, y: number) =>
      fireEvent(
        target,
        Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, altKey }), {
          pointerId: 1,
          pointerType: "mouse",
        }),
      );
    try {
      pointer(chip, "pointerdown", 100, 540);
      pointer(chip, "pointermove", 220, 600);
      pointer(chip, "pointerup", 220, 600);
      await act(async () => {});
    } finally {
      if (originalHit) Object.defineProperty(document, "elementFromPoint", originalHit);
      else Reflect.deleteProperty(document, "elementFromPoint");
    }
    if (altKey) {
      expect(press).not.toHaveBeenCalled();
      return;
    }
    expect(press).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "calendar_event_update",
        eventId: record.id,
        base: record.updatedAt,
        change: {
          start: { ...record.start, value: `20261117T${toStart}` },
          end: { ...record.end, value: `20261117T${toEnd}` },
        },
      }),
    );
  },
);

it("asks which dates to delete when the open occurrence has been changed", async () => {
  const at = String(Date.UTC(2026, 10, 17));
  const series = meeting({
    start: { kind: "date", value: "20261116" },
    end: { kind: "date", value: "20261117" },
    startsAt: "2026-11-16T00:00:00Z",
    repeat: { rules: ["FREQ=DAILY;COUNT=4"], added: [], excluded: [] },
  });
  const occurrence = meeting({
    id: "firing-changed",
    recurrenceId: at,
    occurrenceAt: "2026-11-17T00:00:00Z",
    start: { kind: "date", value: "20261117" },
    end: { kind: "date", value: "20261118" },
    title: "Later kiln check",
  });
  const world = eventWorld(series);
  const press = vi.fn(async () => ({ key: "delete" }));
  world.port.press = press;
  world.put("calendar_event", occurrence.id, occurrence);
  mountFrame(`#/cal/week/2026-11-17/e/firing@${at}`, world, NONE, { words: calmail });
  const card = within(await screen.findByRole("dialog", { name: occurrence.title }));
  const close = card.getByRole("button", { name: "Close" });
  act(() => world.put("calendar_event", occurrence.id, { ...occurrence, organizer, invitees: [guest] }));
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  fireEvent.keyDown(close, { key: "Delete" });
  expect(press).not.toHaveBeenCalled();
  act(() => world.put("calendar_event", occurrence.id, occurrence));
  fireEvent.keyDown(close, { key: "Delete" });
  const choice = within(screen.getByRole("dialog", { name: /^Delete / }));
  expect(press).not.toHaveBeenCalled();
  fireEvent.click(choice.getByRole("menuitem", { name: /This event/ }));
  await act(async () => {});
  expect(press.mock.calls).toEqual([
    [
      {
        kind: "calendar_event_delete",
        eventId: series.id,
        base: series.updatedAt,
        scope: { kind: "occurrence", at },
        audience: { organizer: null, guests: [] },
      },
    ],
  ]);
});

it("does not use a cancellation confirmed for an earlier guest list", async () => {
  const record = meeting({ organizer, invitees: [guest] });
  const world = openWithMailboxes(record, async () => [mailbox(organizer.address)]);
  const press = vi.fn(async () => ({ key: "delete" }));
  world.port.press = press;
  fireEvent.click(await screen.findByRole("button", { name: "Cancel event" }));
  const confirmation = within(screen.getByRole("dialog", { name: /Morgan Glass/ }));
  expect(press).not.toHaveBeenCalled();
  const otherGuest = { ...guest, address: "later@example.invalid", name: "Another guest" };
  act(() =>
    world.put("calendar_event", record.id, {
      ...record,
      invitees: [guest, otherGuest],
    }),
  );
  fireEvent.click(confirmation.getByRole("button", { name: "Send cancellation" }));
  await act(async () => {});
  expect(press).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: record.title })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel event" }));
  const current = within(screen.getByRole("dialog", { name: /Another guest/ }));
  fireEvent.click(current.getByRole("button", { name: "Send cancellation" }));
  await act(async () => {});
  expect(press.mock.calls).toEqual([
    [
      {
        kind: "calendar_event_delete",
        eventId: record.id,
        base: record.updatedAt,
        scope: { kind: "record" },
        audience: { organizer: organizer.address, guests: [guest.address, otherGuest.address].sort() },
      },
    ],
  ]);
});

it("keeps read-only events and invitations free of destructive shortcuts", async () => {
  const record = meeting({ organizer, myAnswer: "accepted" });
  const { world } = open(record);
  const press = vi.fn(async () => ({ key: "any" }));
  world.port.press = press;
  const card = within(await screen.findByRole("dialog", { name: record.title }));
  const close = card.getByRole("button", { name: "Close" });
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Move to" })).toBeNull();
  fireEvent.keyDown(close, { key: "Backspace" });
  fireEvent.keyDown(close, { key: "ArrowRight", shiftKey: true });
  act(() => {
    world.put("calendar_event", record.id, meeting());
    world.put("calendar", "cal-1", calendarRecord({ access: "reader" }));
  });
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  fireEvent.keyDown(close, { key: "Delete" });
  expect(press).not.toHaveBeenCalled();
});

it("withdraws a guest cancellation when the calendar becomes busy-only", async () => {
  const record = meeting({ organizer, invitees: [guest] });
  const world = openWithMailboxes(record, async () => [mailbox(organizer.address)]);
  const press = vi.fn(async () => ({ key: "delete" }));
  world.port.press = press;
  fireEvent.click(await screen.findByRole("button", { name: "Cancel event" }));
  expect(screen.getByRole("dialog", { name: /Morgan Glass/ })).toBeTruthy();
  act(() => world.put("calendar", "cal-1", calendarRecord({ access: "busy" })));
  expect(screen.queryByRole("dialog", { name: /Morgan Glass/ })).toBeNull();
  expect(press).not.toHaveBeenCalled();
});

it.each([
  ["This event", "occurrence"],
  ["This and following", "following"],
])("deletes %s from the later date governed by a range override", async (label, kind) => {
  const at = String(Date.UTC(2026, 10, 18));
  const series = meeting({
    start: { kind: "date", value: "20261116" },
    end: { kind: "date", value: "20261117" },
    startsAt: "2026-11-16T00:00:00Z",
    repeat: { rules: ["FREQ=DAILY;COUNT=4"], added: [], excluded: [] },
  });
  const override = meeting({
    id: "firing-range",
    recurrenceId: String(Date.UTC(2026, 10, 17)),
    thisAndFuture: true,
    start: { kind: "date", value: "20261117" },
    end: { kind: "date", value: "20261118" },
    title: "Changed kiln check",
  });
  const world = eventWorld(series);
  world.put("calendar_event", override.id, override);
  const press = vi.fn(async () => ({ key: "delete" }));
  world.port.press = press;
  mountFrame(`#/cal/week/2026-11-18/e/firing@${at}`, world, NONE, { words: calmail });
  await screen.findByRole("dialog", { name: override.title });
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  const menu = within(screen.getByRole("dialog", { name: /^Delete / }));
  fireEvent.click(menu.getByRole("menuitem", { name: new RegExp(label) }));
  await act(async () => {});
  expect(press).toHaveBeenCalledTimes(1);
  expect(press).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "calendar_event_delete",
      eventId: series.id,
      scope: { kind, at },
    }),
  );
});

it("keeps Shift-Up on the date of a midnight event", async () => {
  const record = meeting({
    start: { kind: "zoned", zone: ZURICH, value: "20261116T000000" },
    end: { kind: "zoned", zone: ZURICH, value: "20261116T010000" },
  });
  const { world } = open(record);
  const press = vi.fn(async () => ({ key: "move" }));
  world.port.press = press;
  const card = within(await screen.findByRole("dialog", { name: record.title }));
  const close = card.getByRole("button", { name: "Close" });
  fireEvent.keyDown(close, { key: "ArrowUp", shiftKey: true });
  await act(async () => {});
  expect(press).not.toHaveBeenCalled();
  fireEvent.keyDown(close, { key: "ArrowLeft", shiftKey: true });
  await act(async () => {});
  expect(press).toHaveBeenCalledWith(
    expect.objectContaining({
      change: {
        start: { ...record.start, value: "20261115T000000" },
        end: { ...record.end, value: "20261115T010000" },
      },
    }),
  );
});

it.each([
  ["All events", "record"],
  ["This and following", "following"],
])("confirms off-screen guests affected by %s", async (label, kind) => {
  const at = Date.UTC(2026, 10, 17);
  const record = meeting({
    start: { kind: "date", value: "20261116" },
    end: { kind: "date", value: "20261117" },
    startsAt: "2026-11-16T00:00:00Z",
    repeat: { rules: ["FREQ=DAILY;COUNT=120"], added: [], excluded: [] },
    deleteMembers: [
      { at: null, range: false, organizer: null, guests: [] },
      {
        at: Date.UTC(2026, 11, 21),
        range: false,
        organizer: organizer.address,
        guests: [{ address: guest.address, name: guest.name }],
      },
    ],
  });
  const world = openWithMailboxes(
    record,
    async () => [mailbox(organizer.address)],
    `#/cal/week/2026-11-17/e/firing@${at}`,
  );
  const press = vi.fn(async () => ({ key: "delete" }));
  world.port.press = press;
  fireEvent.click(await screen.findByRole("button", { name: "Cancel event", exact: true }));
  const choices = within(screen.getByRole("dialog", { name: /^Delete / }));
  fireEvent.click(choices.getByRole("menuitem", { name: new RegExp(label) }));
  expect(press).not.toHaveBeenCalled();
  const confirmation = within(screen.getByRole("dialog", { name: /Morgan Glass/ }));
  fireEvent.click(confirmation.getByRole("button", { name: "Send cancellation" }));
  await act(async () => {});
  expect(press).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "calendar_event_delete",
      scope: kind === "record" ? { kind } : { kind, at: String(at) },
      audience: { organizer: organizer.address, guests: [guest.address] },
    }),
  );
});

it.each(["google", "microsoft", "caldav"] as const)(
  "withholds Delete on an unproven %s series",
  async (provider) => {
    const at = Date.UTC(2026, 10, 17);
    const record = meeting({
      start: { kind: "date", value: "20261116" },
      end: { kind: "date", value: "20261117" },
      startsAt: "2026-11-16T00:00:00Z",
      repeat: { rules: ["FREQ=DAILY;COUNT=4"], added: [], excluded: [] },
    });
    delete record.deleteScopes;
    const world = eventWorld(record);
    world.put("calendar_connection", "conn-1", connectionRecord({ provider }));
    const press = vi.fn(async () => ({ key: "delete" }));
    world.port.press = press;
    mountFrame(`#/cal/week/2026-11-17/e/firing@${at}`, world, NONE, { words: calmail });
    const card = within(await screen.findByRole("dialog", { name: record.title }));
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.keyDown(card.getByRole("button", { name: "Close" }), { key: "Delete" });
    expect(press).not.toHaveBeenCalled();
  },
);

it("offers Undo for a personal delete before sending it", async () => {
  const record = meeting();
  const { world } = open(record);
  const press = vi.fn(async () => ({ key: "delete" }));
  const undo = vi.fn(async () => true);
  const holdDelete = vi.fn(async () => ({
    key: "held",
    deadline: Date.now() + 4000,
    remainingMs: () => 4000,
    undo,
  }));
  world.port.press = press;
  world.port.holdDelete = holdDelete;
  await screen.findByRole("dialog", { name: record.title });
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  const control = await screen.findByRole("button", { name: "Undo" });
  expect(holdDelete).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "calendar_event_delete", eventId: record.id }),
    8000,
  );
  expect(press).not.toHaveBeenCalled();
  fireEvent.click(control);
  await act(async () => {});
  expect(undo).toHaveBeenCalledTimes(1);
  expect(press).not.toHaveBeenCalled();
});

it("places the desktop Delete control in the shared event action panel", async () => {
  const record = meeting();
  open(record);
  const card = await screen.findByRole("dialog", { name: record.title });
  const actions = within(screen.getByRole("toolbar", { name: "Event actions" }));
  expect(actions.getByRole("button", { name: "Delete" })).toBeTruthy();
  expect(within(card).queryByRole("button", { name: "Delete" })).toBeNull();
});

it("names the series and its repeat in the Delete scope prompt", async () => {
  const at = Date.UTC(2026, 10, 17);
  const record = meeting({
    start: { kind: "date", value: "20261116" },
    end: { kind: "date", value: "20261117" },
    startsAt: "2026-11-16T00:00:00Z",
    repeat: { rules: ["FREQ=DAILY;COUNT=4"], added: [], excluded: [] },
  });
  mountFrame(`#/cal/week/2026-11-17/e/firing@${at}`, eventWorld(record), NONE, { words: calmail });
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  const prompt = within(screen.getByRole("dialog", { name: "Delete Kiln check" }));
  expect(prompt.getByText("Daily, 4 times")).toBeTruthy();
  for (const label of ["This event", "This and following", "All events"]) {
    expect(prompt.getByRole("menuitem", { name: new RegExp(label) })).toBeTruthy();
  }
});

it("withholds only the single-date deletion at a range override's anchor", async () => {
  const at = Date.UTC(2026, 10, 17);
  const master = meeting({
    start: { kind: "date", value: "20261116" },
    end: { kind: "date", value: "20261117" },
    startsAt: "2026-11-16T00:00:00Z",
    repeat: { rules: ["FREQ=DAILY;COUNT=4"], added: [], excluded: [] },
    deleteMembers: [
      { at: null, range: false, organizer: null, guests: [] },
      { at, range: true, organizer: null, guests: [] },
    ],
  });
  const override = meeting({
    id: "firing-range",
    recurrenceId: String(at),
    thisAndFuture: true,
    start: { kind: "date", value: "20261117" },
    end: { kind: "date", value: "20261118" },
    title: "Changed kiln check",
  });
  const world = eventWorld(master);
  world.put("calendar_event", override.id, override);
  const press = vi.fn(async () => ({ key: "delete" }));
  world.port.press = press;
  mountFrame(`#/cal/week/2026-11-17/e/firing@${at}`, world, NONE, { words: calmail });
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  const menu = within(screen.getByRole("dialog", { name: "Delete Changed kiln check" }));
  expect(menu.queryByRole("menuitem", { name: /This event/ })).toBeNull();
  fireEvent.keyDown(menu.getByRole("menuitem", { name: /All events/ }), { key: "1" });
  expect(press).not.toHaveBeenCalled();
  expect(menu.getByRole("menuitem", { name: /This and following/ })).toBeTruthy();
  expect(menu.getByRole("menuitem", { name: /All events/ })).toBeTruthy();
});

it("previews and saves the same start when dragging an overnight continuation", async () => {
  const record = meeting({
    start: { kind: "zoned", zone: ZURICH, value: "20261116T220000" },
    end: { kind: "zoned", zone: ZURICH, value: "20261117T020000" },
  });
  const world = eventWorld(record);
  const press = vi.fn(async () => ({ key: "overnight" }));
  world.port.press = press;
  mountFrame("#/cal/week/2026-11-16", world, NONE);
  const tuesday = screen.getByRole("group", { name: /Tue/ });
  const wednesday = screen.getByRole("group", { name: /Wed/ });
  const chip = await within(tuesday).findByRole("button", { name: /Kiln check/ });
  const bounds = () => ({ top: 0, height: 1440 }) as DOMRect;
  for (const day of [tuesday, wednesday]) {
    vi.spyOn(day, "getBoundingClientRect").mockImplementation(bounds);
    vi.spyOn(day, "clientHeight", "get").mockReturnValue(1440);
  }
  vi.spyOn(chip, "offsetHeight", "get").mockReturnValue(118);
  const priorHit = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => wednesday });
  const pointer = (type: string, x: number, y: number) =>
    fireEvent(
      chip,
      Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }), {
        pointerId: 1,
        pointerType: "mouse",
      }),
    );
  try {
    pointer("pointerdown", 100, 30);
    pointer("pointermove", 220, 90);
    expect(within(tuesday).getByText("23:00")).toBeTruthy();
    expect(within(wednesday).queryByText("23:00")).toBeNull();
    expect(press).not.toHaveBeenCalled();
    pointer("pointerup", 220, 90);
    await act(async () => {});
    expect(press).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "calendar_event_update",
        eventId: record.id,
        change: {
          start: { ...record.start, value: "20261117T230000" },
          end: { ...record.end, value: "20261118T030000" },
        },
      }),
    );
  } finally {
    if (priorHit) Object.defineProperty(document, "elementFromPoint", priorHit);
    else Reflect.deleteProperty(document, "elementFromPoint");
  }
});

it.each([
  ["en", 16, "FREQ=MONTHLY;BYMONTHDAY=16", "Every month on the 16th"],
  ["en", 16, "FREQ=MONTHLY", "Every month on the 16th"],
  ["en", 16, "FREQ=MONTHLY;BYDAY=3MO", "Every month on the third Monday"],
  ["de", 16, "FREQ=MONTHLY;BYMONTHDAY=16", "Jeden Monat am 16."],
  ["de", 27, "FREQ=MONTHLY;BYDAY=-1FR", "Jeden Monat am letzten Freitag"],
  ["en", 27, "FREQ=YEARLY;BYMONTH=11;BYDAY=-1FR", "Every year on the last Friday of November"],
  ["en", 10, "FREQ=MONTHLY;INTERVAL=3;BYDAY=TU;BYSETPOS=2", "Every 3 months on the second Tuesday"],
  ["de", 10, "FREQ=MONTHLY;INTERVAL=3;BYDAY=TU;BYSETPOS=2", "Alle 3 Monate am zweiten Dienstag"],
  ["en", 16, "FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=16", "Every 2 months on the 16th"],
] as const)("describes a supported %s repeat in the deletion prompt", async (locale, day, rule, words) => {
  const at = Date.UTC(2026, 10, day);
  const start = `202611${day}`;
  const record = meeting({
    start: { kind: "date", value: start },
    end: { kind: "date", value: `202611${day + 1}` },
    startsAt: new Date(at).toISOString(),
    repeat: { rules: [rule], added: [], excluded: [] },
  });
  mountFrame(`#/cal/week/2026-11-${day}/e/firing@${at}`, eventWorld(record), NONE, {
    locale,
    words: { ...calmail, ...(locale === "de" && calendarDe) },
  });
  fireEvent.click(await screen.findByRole("button", { name: locale === "de" ? "Löschen" : "Delete" }));
  const menu = within(
    screen.getByRole("dialog", {
      name: locale === "de" ? "Kiln check löschen" : "Delete Kiln check",
    }),
  );
  expect(menu.getByText(words)).toBeTruthy();
  expect(menu.getAllByRole("menuitem")).toHaveLength(3);
});

it("reports a late Calendar refusal in the frame while mail is open", async () => {
  const world = eventWorld(meeting());
  let refuse: Parameters<NonNullable<CalendarPort["subscribeLateRefusals"]>>[0] = () => {};
  world.port.subscribeLateRefusals = (report) => {
    refuse = report;
    return () => {
      refuse = () => {};
    };
  };
  mountFrame("#/ohbox", world, NONE, { words: calmail });
  await act(async () => refuse("calendar_read_only"));
  const reports = screen
    .getAllByRole("status")
    .filter((status) => status.textContent?.includes("This calendar can be looked at, not changed"));
  expect(reports).toHaveLength(1);
  expect(reports[0]?.querySelector(".oh-nowrap > .oh-dot")).not.toBeNull();
});

const lateRefusalText = [
  "This calendar can be looked at, not changed",
  "Too many changes are waiting. Try again in a moment",
] as const;

function hearPeerRefusals(world: ReturnType<typeof eventWorld>) {
  let report: Parameters<NonNullable<CalendarPort["subscribeLateRefusals"]>>[0] = () => {};
  let retire: () => void = () => {};
  world.port.subscribeLateRefusals = (listen, clear) => {
    report = listen;
    retire = clear ?? (() => {});
    return () => {
      report = () => {};
    };
  };
  return {
    receive() {
      report("calendar_read_only");
      report("calendar_writes_full");
    },
    retire: () => retire(),
  };
}

function fakeCalendarTimers() {
  vi.useRealTimers();
  vi.useFakeTimers({ now: new Date("2026-11-16T08:00:00Z") });
}

const standingReports = () => screen.queryAllByRole("status").map((node) => node.textContent ?? "");

it("reports both Calendar refusals delivered together while mail is open", async () => {
  fakeCalendarTimers();
  const world = eventWorld(meeting());
  const { receive } = hearPeerRefusals(world);
  mountFrame("#/ohbox", world, NONE, { words: calmail });
  await act(async () => receive());
  expect(standingReports().some((line) => line.includes(lateRefusalText[0]))).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(2600));
  expect(standingReports().some((line) => line.includes(lateRefusalText[1]))).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(2600));
  expect(standingReports().some((line) => lateRefusalText.some((text) => line.includes(text)))).toBe(false);
});

it("keeps both late Calendar refusals behind an active Undo", async () => {
  fakeCalendarTimers();
  const world = eventWorld(meeting());
  const { receive } = hearPeerRefusals(world);
  const undo = vi.fn(async () => true);
  world.port.holdDelete = async () => ({
    key: "held",
    deadline: Date.now() + 8000,
    remainingMs: () => 8000,
    undo,
  });
  mountFrame("#/cal/week/2026-11-16/e/firing", world, NONE, { words: calmail });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete" })));
  await act(async () => receive());
  expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  expect(standingReports().some((line) => lateRefusalText.some((text) => line.includes(text)))).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(8000));
  expect(standingReports().some((line) => line.includes(lateRefusalText[0]))).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(2600));
  expect(standingReports().some((line) => line.includes(lateRefusalText[1]))).toBe(true);
});

it("drops the standing and waiting Calendar refusals when their session retires", async () => {
  fakeCalendarTimers();
  const world = eventWorld(meeting());
  const { receive, retire } = hearPeerRefusals(world);
  mountFrame("#/ohbox", world, NONE, { words: calmail });
  await act(async () => receive());
  expect(standingReports().some((line) => line.includes(lateRefusalText[0]))).toBe(true);
  await act(async () => retire());
  await act(async () => vi.advanceTimersByTimeAsync(5200));
  expect(standingReports().some((line) => lateRefusalText.some((text) => line.includes(text)))).toBe(false);
});

it("stops offering Calendar Undo at the deadline after a delayed commit", async () => {
  fakeCalendarTimers();
  const world = eventWorld(meeting());
  const deadline = Date.now() + 8000;
  const undo = vi.fn(async () => true);
  world.port.holdDelete = async () => {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    return { key: "held", deadline, remainingMs: () => Math.max(0, deadline - Date.now()), undo };
  };
  mountFrame("#/cal/week/2026-11-16/e/firing", world, NONE, { words: calmail });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete" })));
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  await act(async () => vi.advanceTimersByTimeAsync(3999));
  expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  expect(undo).not.toHaveBeenCalled();
});

it("says too late if Calendar Undo is pressed after the deadline before the timer runs", async () => {
  fakeCalendarTimers();
  const world = eventWorld(meeting());
  const deadline = Date.now() + 4000;
  const undo = vi.fn(async () => true);
  world.port.holdDelete = async () => ({
    key: "held",
    deadline,
    remainingMs: () => Math.max(0, deadline - Date.now()),
    undo,
  });
  mountFrame("#/cal/week/2026-11-16/e/firing", world, NONE, { words: calmail });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete" })));
  const control = screen.getByRole("button", { name: "Undo" });

  vi.setSystemTime(deadline);
  await act(async () => fireEvent.click(control));
  expect(undo).not.toHaveBeenCalled();
  expect(standingReports()).toContain("Too late to undo");
});

it("offers Save only after a change and recovers a cancelled edit without writing", async () => {
  const { world } = open(meeting());
  const press = vi.fn(async () => ({ key: "edit" }));
  world.port.press = press;
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const edit = within(screen.getByRole("dialog", { name: "Edit event" }));
  const save = edit.getByRole<HTMLButtonElement>("button", { name: "Save" });
  expect(save.disabled).toBe(true);
  const title = edit.getByRole("textbox", { name: "Event title" });
  fireEvent.change(title, { target: { value: "Glaze check" } });
  expect(save.disabled).toBe(false);
  fireEvent.keyDown(title, { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "Kiln check" })).toBeTruthy();
  expect(screen.getByText("Discarded")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(screen.getByDisplayValue("Glaze check")).toBeTruthy();
  expect(press).not.toHaveBeenCalled();
});

it("changes the first and last day independently from the keyboard", async () => {
  const record = meeting({
    start: { kind: "date", value: "20261116" },
    end: { kind: "date", value: "20261119" },
  });
  for (const [edge, key, start, end] of [
    ["start", "ArrowRight", "20261117", "20261119"],
    ["end", "ArrowRight", "20261116", "20261120"],
  ] as const) {
    const { world } = open(record);
    const press = vi.fn(async () => ({ key: "resize" }));
    world.port.press = press;
    const card = within(await screen.findByRole("dialog", { name: record.title }));
    fireEvent.keyDown(card.getByRole("button", { name: "Close" }), {
      key,
      shiftKey: true,
      altKey: true,
      ctrlKey: edge === "start",
    });
    expect(press).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "calendar_event_update",
        change: { start: { kind: "date", value: start }, end: { kind: "date", value: end } },
      }),
    );
    cleanup();
  }
});

it("discards a dirty edit when leaving its card and lets Undo reopen it", async () => {
  const { world } = open(meeting());
  const press = vi.fn(async () => ({ key: "edit" }));
  world.port.press = press;
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const edit = within(screen.getByRole("dialog", { name: "Edit event" }));
  fireEvent.change(edit.getByRole("textbox", { name: "Event title" }), { target: { value: "Glaze check" } });
  fireEvent.click(edit.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog", { name: "Edit event" })).toBeNull();
  expect(screen.getByText("Discarded")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(await screen.findByDisplayValue("Glaze check")).toBeTruthy();
  expect(press).not.toHaveBeenCalled();
});

async function editTitle(value: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const editor = within(screen.getByRole("dialog", { name: "Edit event" }));
  fireEvent.change(editor.getByRole("textbox", { name: "Event title" }), { target: { value } });
  return editor;
}

it("restores an earlier edit after reopening and keeps the newer words recoverable", async () => {
  const { world } = open(meeting());
  const press = vi.fn(async () => ({ key: "edit" }));
  world.port.press = press;
  fireEvent.click((await editTitle("First version")).getByRole("button", { name: "Cancel" }));
  await editTitle("Second version");
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(screen.getByDisplayValue("First version")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(screen.getByDisplayValue("Second version")).toBeTruthy();
  expect(press).not.toHaveBeenCalled();
});

it("keeps each discarded edit recoverable in newest-first order", async () => {
  const { world } = open(meeting());
  const press = vi.fn(async () => ({ key: "edit" }));
  world.port.press = press;
  for (const title of ["First version", "Second version"]) {
    fireEvent.click((await editTitle(title)).getByRole("button", { name: "Cancel" }));
  }
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(screen.getByDisplayValue("Second version")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(screen.getByDisplayValue("First version")).toBeTruthy();
  expect(press).not.toHaveBeenCalled();
});

it("brings back a discarded edit after Undo for another calendar action", async () => {
  const record = meeting();
  const { world } = open(record);
  const undoDelete = vi.fn(async () => true);
  world.port.holdDelete = async () => ({
    key: "held",
    deadline: Date.now() + 8000,
    remainingMs: () => 8000,
    undo: undoDelete,
  });
  fireEvent.click((await editTitle("Before removing")).getByRole("button", { name: "Cancel" }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete" })));
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(undoDelete).toHaveBeenCalledTimes(1);
  await screen.findByText("Discarded");
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(await screen.findByDisplayValue("Before removing")).toBeTruthy();
});

it("leaves a padded stored title untouched on Enter and when saving another field", async () => {
  const { world } = open(meeting({ title: "Kiln check  " }));
  const press = vi.fn(async () => ({ key: "edit" }));
  world.port.press = press;
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const editor = within(screen.getByRole("dialog", { name: "Edit event" }));
  const save = editor.getByRole<HTMLButtonElement>("button", { name: "Save" });
  expect(save.disabled).toBe(true);
  fireEvent.keyDown(editor.getByRole("textbox", { name: "Event title" }), { key: "Enter" });
  expect(press).not.toHaveBeenCalled();

  fireEvent.change(editor.getByRole("combobox", { name: "Place" }), { target: { value: "Studio" } });
  fireEvent.click(save);
  expect(press.mock.calls).toEqual([[expect.objectContaining({ change: { place: "Studio" } })]]);
  await act(async () => {});
});

it.each(["week", "day"])("resizes a timed event's end by dragging in %s", async (view) => {
  const world = eventWorld(
    meeting({
      start: { kind: "zoned", value: "20261116T110000", zone: ZURICH },
      end: { kind: "zoned", value: "20261116T130000", zone: ZURICH },
    }),
  );
  const press = vi.fn(async () => ({ key: "resize" }));
  world.port.press = press;
  mountFrame(`#/cal/${view}/2026-11-16`, world, NONE, { words: calmail });
  const chip = screen.getByRole("button", { name: /Kiln check/ });
  const handle = within(chip).getByTitle("Resize end");
  const column = chip.parentElement!;
  vi.spyOn(column, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ width: 120, height: 1440 }));
  const prior = Object.getOwnPropertyDescriptor(document, "elementsFromPoint");
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [column] });
  const pointer = (target: EventTarget, type: string, y: number) =>
    fireEvent(target, Object.assign(new MouseEvent(type, { bubbles: true, clientY: y }), { pointerId: 1 }));
  try {
    pointer(handle, "pointerdown", 780);
    pointer(document, "pointermove", 840);
    pointer(document, "pointerup", 840);
    await vi.waitFor(() =>
      expect(press).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "calendar_event_update",
          change: {
            start: { kind: "zoned", value: "20261116T110000", zone: ZURICH },
            end: { kind: "zoned", value: "20261116T140000", zone: ZURICH },
          },
        }),
      ),
    );
  } finally {
    if (prior) Object.defineProperty(document, "elementsFromPoint", prior);
    else Reflect.deleteProperty(document, "elementsFromPoint");
  }
});

it("resizes the focused event with the keyboard and gives read-only events no handles", async () => {
  const world = eventWorld(meeting());
  const press = vi.fn(async () => ({ key: "resize" }));
  world.port.press = press;
  mountFrame("#/cal/week/2026-11-16", world, NONE, { words: calmail });
  const chip = screen.getByRole("button", { name: /Kiln check/ });
  chip.focus();
  fireEvent.keyDown(chip, { key: "ArrowDown", altKey: true, shiftKey: true });
  await vi.waitFor(() =>
    expect(press).toHaveBeenCalledWith(
      expect.objectContaining({
        change: { start: { kind: "zoned", value: "20261116T091500", zone: ZURICH }, end: meeting().end },
      }),
    ),
  );
  act(() => world.put("calendar", "cal-1", calendarRecord({ access: "reader" })));
  expect(within(chip).queryByTitle("Resize end")).toBeNull();
  fireEvent.keyDown(chip, { key: "ArrowDown", altKey: true });
  expect(press).toHaveBeenCalledTimes(1);
});

it("saves the time zone and Show as choices through the event editor", async () => {
  const { world } = open(meeting());
  const press = vi.fn(async () => ({ key: "change" }));
  world.port.press = press;
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const edit = within(screen.getByRole("dialog", { name: "Edit event" }));
  fireEvent.click(edit.getByRole("button", { name: "Show as" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Free" }));
  fireEvent.click(edit.getByRole("button", { name: "Time zone" }));
  const zones = within(screen.getByRole("dialog", { name: "Time zone" }));
  fireEvent.change(zones.getByRole("textbox", { name: "Find a time zone" }), { target: { value: "London" } });
  fireEvent.click(zones.getByRole("menuitemradio", { name: "Europe/London" }));
  fireEvent.click(edit.getByRole("button", { name: "Save" }));
  await vi.waitFor(() =>
    expect(press).toHaveBeenCalledWith(
      expect.objectContaining({
        change: {
          start: { kind: "zoned", value: "20261116T090000", zone: "Europe/London" },
          end: { kind: "zoned", value: "20261116T100000", zone: "Europe/London" },
          busy: false,
        },
      }),
    ),
  );
});

it("never reduces a timed event to zero and can undo an accepted resize", async () => {
  const record = meeting({ end: { kind: "zoned", value: "20261116T091500", zone: ZURICH } });
  const world = eventWorld(record);
  world.port.verdict = () => ({ kind: "taken" });
  const updatedAt = "2026-11-17T08:00:00.000Z";
  const press = vi.fn<CalendarPort["press"]>(async (act) => {
    if (act.kind === "calendar_event_update") {
      world.put("calendar_event", record.id, { ...record, ...act.change, updatedAt });
    }
    return { key: "resize" };
  });
  world.port.press = press;
  mountFrame("#/cal/week/2026-11-16", world, NONE, { words: calmail });
  const chip = screen.getByRole("button", { name: /Kiln check/ });
  chip.focus();
  fireEvent.keyDown(chip, { key: "ArrowUp", altKey: true });
  expect(press).not.toHaveBeenCalled();
  fireEvent.keyDown(chip, { key: "ArrowDown", altKey: true });
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await vi.waitFor(() =>
    expect(press).toHaveBeenLastCalledWith(
      expect.objectContaining({
        base: updatedAt,
        change: { start: record.start, end: record.end },
      }),
    ),
  );
});

it("stays unchanged after returning the editor to the original time zone", async () => {
  open(meeting());
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const edit = within(screen.getByRole("dialog", { name: "Edit event" }));
  for (const [typed, zone] of [
    ["London", "Europe/London"],
    ["Zurich", ZURICH],
  ]) {
    fireEvent.click(edit.getByRole("button", { name: "Time zone" }));
    const picker = within(screen.getByRole("dialog", { name: "Time zone" }));
    fireEvent.change(picker.getByRole("textbox", { name: "Find a time zone" }), { target: { value: typed } });
    fireEvent.click(picker.getByRole("menuitemradio", { name: zone }));
  }
  expect(edit.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);
});

it("Alt+Down extends an end in the second repeated hour by fifteen minutes", async () => {
  vi.setSystemTime(new Date("2026-10-25T09:00:00Z"));
  const start = { kind: "instant", value: "20261024T233000Z" } as const;
  const end = { kind: "instant", value: "20261025T011500Z" } as const;
  const world = eventWorld(meeting({ start, end }));
  const press = vi.fn(async () => ({ key: "resize" }));
  world.port.press = press;
  mountFrame("#/cal/week/2026-10-25", world, NONE, { words: calmail });
  const chip = screen.getByRole("button", { name: /Kiln check/ });
  chip.focus();
  fireEvent.keyDown(chip, { key: "ArrowDown", altKey: true });
  await vi.waitFor(() =>
    expect(press).toHaveBeenCalledWith(
      expect.objectContaining({
        change: { start, end: { ...end, value: "20261025T013000Z" } },
      }),
    ),
  );
});

it("explains a skipped time when editing a spring clock-change event", async () => {
  vi.setSystemTime(new Date("2026-03-29T09:00:00Z"));
  const world = eventWorld(
    meeting({
      start: { kind: "zoned", value: "20260329T013000", zone: ZURICH },
      end: { kind: "zoned", value: "20260329T033000", zone: ZURICH },
    }),
  );
  const press = vi.fn(async () => ({ key: "change" }));
  world.port.press = press;
  mountFrame("#/cal/week/2026-03-29/e/firing", world, NONE, { words: calmail });
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const form = within(screen.getByRole("dialog", { name: "Edit event" }));
  fireEvent.change(form.getByRole("textbox", { name: "End time" }), { target: { value: "02:30" } });
  expect(form.getByText(/clock change skips/i)).toBeTruthy();
  expect(form.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);
  expect(press).not.toHaveBeenCalled();
});

it("opens an invitee picker, shows reminders and offers the editor's lower actions", async () => {
  open(meeting({ alarms: [{ minutesBefore: 15, method: "notice" }] }));
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const form = within(screen.getByRole("dialog", { name: "Edit event" }));
  expect(form.getByRole("button", { name: "Alert" })).toBeTruthy();
  fireEvent.click(form.getByRole("button", { name: "Invitees" }));
  expect(screen.getByRole("dialog", { name: "Add invitees" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Duplicate" })).toBeTruthy();
});

it("only invites a new guest after explicit confirmation and sends the chosen alerts", async () => {
  const { world } = open(meeting({ alarms: [{ minutesBefore: 15, method: "notice" }] }));
  const press = vi.fn(async () => ({ key: "change" }));
  world.port.press = press;
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const form = within(screen.getByRole("dialog", { name: "Edit event" }));
  fireEvent.click(form.getByRole("button", { name: "and another" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "30 minutes before" }));
  fireEvent.click(form.getByRole("button", { name: "Invitees" }));
  const picker = within(screen.getByRole("dialog", { name: "Add invitees" }));
  fireEvent.change(picker.getByRole("textbox", { name: "Name or address" }), {
    target: { value: "Sam <sam@example.test>" },
  });
  fireEvent.click(picker.getByRole("menuitem", { name: /^Sam/ }));
  expect(press).not.toHaveBeenCalled();
  fireEvent.click(form.getByRole("button", { name: "Save" }));
  expect(press).not.toHaveBeenCalled();
  const consent = within(screen.getByRole("dialog", { name: "Invite Sam" }));
  fireEvent.click(consent.getByRole("button", { name: "Send invitation" }));
  await vi.waitFor(() => expect(press).toHaveBeenCalledTimes(1));
  expect(press).toHaveBeenCalledWith(
    expect.objectContaining({
      change: { alarms: [15, 30], invitees: [expect.objectContaining({ name: "Sam", role: "required" })] },
      audience: { organizer: null, guests: [] },
    }),
  );
});

const occurrenceCopies = [
  ["menu", "whole-day"],
  ["editor", "whole-day"],
  ["menu", "timed"],
  ["editor", "timed"],
] as const;

it.each(occurrenceCopies)(
  "duplicates a later occurrence from the %s into an unsent %s draft",
  async (source, kind) => {
    const timed = kind === "timed";
    const zoned = (value: string) => ({ kind: "zoned" as const, value, zone: ZURICH });
    const record = meeting({
      start: timed ? zoned("20261020T093000") : { kind: "date", value: "20261116" },
      end: timed ? zoned("20261020T103000") : { kind: "date", value: "20261117" },
      startsAt: timed ? "2026-10-20T07:30:00Z" : "2026-11-16T00:00:00Z",
      personalSeries: true,
      repeat: { rules: ["FREQ=WEEKLY;COUNT=4"], added: [], excluded: [] },
      alarms: [{ method: "notice", minutesBefore: 15 }],
    });
    const w = eventWorld(record);
    w.put("calendar_connection", "conn-1", connectionRecord({ provider: "caldav" }));
    Object.assign(w.engine.store, {
      get: (kind: string, id: string) =>
        w.engine.store.entries<{ id: string }>(kind).find(({ entity }) => entity.id === id)?.entity,
    });
    const press = vi.fn(async () => ({ key: "create" }));
    w.port.press = press;
    mountFrame(timed ? "#/cal/week/2026-11-10" : "#/cal/week/2026-11-30", w, NONE);
    const chip = screen.getByRole("button", {
      name: timed ? /Kiln check, 09:30 to 10:30/ : /Kiln check, all day/,
    });
    if (source === "menu") {
      fireEvent.contextMenu(chip);
      fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    } else {
      fireEvent.click(chip);
      fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
      fireEvent.click(
        within(screen.getByRole("toolbar", { name: "Event actions" })).getByRole("button", {
          name: "Duplicate",
        }),
      );
    }
    const draft = within(await screen.findByRole("dialog", { name: "New event" }));
    expect(draft.getByRole("button", { name: "Event date" }).textContent).toContain(
      timed ? "10 Nov" : "30 Nov",
    );
    if (timed) {
      expect(draft.getByLabelText("Start time")).toHaveProperty("value", "09:30");
      expect(draft.getByLabelText("End time")).toHaveProperty("value", "10:30");
    }
    expect(draft.getByDisplayValue("Kiln check")).toBeTruthy();
    expect(draft.getByDisplayValue("Workshop")).toBeTruthy();
    expect(draft.getByText("15 minutes before")).toBeTruthy();
    expect(press).not.toHaveBeenCalled();
    fireEvent.click(draft.getByRole("button", { name: "Add" }));
    expect(press).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          start: timed ? zoned("20261110T093000") : { kind: "date", value: "20261130" },
          end: timed ? zoned("20261110T103000") : { kind: "date", value: "20261201" },
          invitees: [],
          repeat: null,
        }),
      }),
    );
    await act(async () => {});
  },
);

it("duplicates into an unsent draft from the editor actions", async () => {
  open(meeting());
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.click(
    within(screen.getByRole("toolbar", { name: "Event actions" })).getByRole("button", { name: "Duplicate" }),
  );
  const draft = within(await screen.findByRole("dialog", { name: "New event" }));
  expect(draft.getByDisplayValue("Kiln check")).toBeTruthy();
  expect(draft.getByDisplayValue("09:00")).toBeTruthy();
});

it("asks the invitee to propose a new time and holds only a mail proposal for Undo", async () => {
  const record = meeting({ organizer, invitees: [guest], myAnswer: "accepted" });
  const world = openWithMailboxes(record, async () => [mailbox(guest.address)]);
  const hold = vi.fn(async () => ({
    key: "proposal",
    deadline: 1000,
    remainingMs: () => 1000,
    undo: async () => true,
  }));
  world.port.holdProposal = hold;
  const write = vi.fn(async () => ({ key: "event-write" }));
  world.port.press = write;

  fireEvent.click(await screen.findByRole("button", { name: "Propose a new time" }));
  expect(await screen.findByRole("toolbar", { name: "Propose this time?" })).toBeTruthy();
  expect(hold).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Propose", exact: true }));
  await act(async () => {});
  expect(hold).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "calendar_event_propose",
      recordId: record.id,
      base: record.updatedAt,
      occurrence: "",
      start: { ...record.start, value: "20261116T100000" },
      end: { ...record.end, value: "20261116T110000" },
    }),
    expect.any(Number),
  );
  expect(write).not.toHaveBeenCalled();
  expect(world.port.events().map(({ record }) => record.start)).toEqual([record.start]);
});

const proposedTimes = {
  start: { kind: "instant", value: "20261116T130000Z" },
  end: { kind: "instant", value: "20261116T140000Z" },
} as const;

function proposalLetter() {
  const fields: Partial<EngineMessage> & Pick<MessageDTO, "invitation"> = {
    from: { address: guest.address, name: guest.name },
    invitation: {
      method: "COUNTER",
      uid: "firing",
      recurrenceId: "",
      sequence: 0,
      start: proposedTimes.start.value,
      startsAt: "2026-11-16T13:00:00Z",
      organizer: organizer.address,
      invitedAddress: null,
      answer: null,
      answeredAt: null,
      proposal: { ...proposedTimes, attendee: guest.address },
    },
  };
  return letter("proposal-letter", fields);
}

it("lets the organizer accept a proposal through the guest-update question", async () => {
  const world = openWithMailboxes(
    meeting({ organizer, invitees: [guest] }),
    async () => [mailbox(organizer.address)],
    undefined,
    [proposalLetter()],
  );
  const write = vi.fn(async () => ({ key: "calendar-update" }));
  world.port.press = write;
  world.port.verdict = () => ({ kind: "taken", write: null });
  expect(await screen.findByText(/Morgan proposes/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Accept / }));
  expect(write).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Send update", exact: true }));
  await act(async () => {});
  expect(write).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "calendar_event_update",
      eventId: "firing",
      scope: { kind: "record" },
      change: proposedTimes,
      audience: { organizer: organizer.address, guests: [guest.address] },
    }),
  );
});

it("lets the organizer keep the current time through a mail reply alone", async () => {
  const world = openWithMailboxes(
    meeting({ organizer, invitees: [guest] }),
    async () => [mailbox(organizer.address)],
    undefined,
    [proposalLetter()],
  );
  const write = vi.fn(async () => ({ key: "calendar-write" }));
  const hold = vi.fn(async () => ({
    key: "keep",
    deadline: 1000,
    remainingMs: () => 1000,
    undo: async () => true,
  }));
  world.port.press = write;
  world.port.holdProposal = hold;
  fireEvent.click(await screen.findByRole("button", { name: /^Keep / }));
  expect(hold).not.toHaveBeenCalled();
  const question = screen.getByRole("toolbar", { name: /Tell Morgan Glass the time stays/ });
  fireEvent.click(within(question).getByRole("button", { name: "Confirm" }));
  await act(async () => {});
  expect(hold).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "calendar_proposal_keep",
      recordId: "firing",
      occurrence: "",
      messageId: "proposal-letter",
    }),
    expect.any(Number),
  );
  expect(write).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /^Keep / })).toBeNull();
});

it.each(["move", "resize"] as const)(
  "opens a time proposal when an invitee uses %s on the grid",
  async (gesture) => {
    const record = meeting({ organizer, invitees: [guest], myAnswer: "accepted" });
    const world = openWithMailboxes(record, async () => [mailbox(guest.address)], "#/cal/week/2026-11-16");
    const mail = vi.fn(async () => ({
      key: "proposal",
      deadline: 1000,
      remainingMs: () => 1000,
      undo: async () => true,
    }));
    const write = vi.fn(async () => ({ key: "event-write" }));
    world.port.holdProposal = mail;
    world.port.press = write;
    await act(async () => {});
    const chip = screen.getByRole("button", { name: /Kiln check/ });
    const column = chip.parentElement!;
    vi.spyOn(column, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ width: 120, height: 1440 }));
    const prior = Object.getOwnPropertyDescriptor(document, "elementsFromPoint");
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [column] });
    const pointer = (target: EventTarget, type: string, y: number) =>
      fireEvent(target, Object.assign(new MouseEvent(type, { bubbles: true, clientY: y }), { pointerId: 1 }));
    try {
      const target = gesture === "resize" ? within(chip).getByTitle("Resize end") : chip;
      pointer(target, "pointerdown", 540);
      pointer(document, "pointermove", 600);
      pointer(document, "pointerup", 600);
      expect(await screen.findByRole("toolbar", { name: "Propose this time?" })).toBeTruthy();
      expect(mail).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Propose", exact: true }));
      await act(async () => {});
      expect(mail).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "calendar_event_propose",
          start: { ...record.start, value: gesture === "resize" ? "20261116T090000" : "20261116T100000" },
          end: { ...record.end, value: "20261116T110000" },
        }),
        expect.any(Number),
      );
      expect(write).not.toHaveBeenCalled();
    } finally {
      if (prior) Object.defineProperty(document, "elementsFromPoint", prior);
      else Reflect.deleteProperty(document, "elementsFromPoint");
    }
  },
);

it("calls an organizer's deletion with guests Cancel event and asks before sending it", async () => {
  const world = openWithMailboxes(meeting({ organizer, invitees: [guest] }), async () => [
    mailbox(organizer.address),
  ]);
  const write = vi.fn(async () => ({ key: "cancel-event" }));
  world.port.press = write;
  world.port.verdict = () => ({ kind: "taken", write: null });
  fireEvent.click(await screen.findByRole("button", { name: "Cancel event", exact: true }));
  expect(write).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Send cancellation" }));
  expect(write).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "calendar_event_delete",
      audience: { organizer: organizer.address, guests: [guest.address] },
    }),
  );
});

it("calls a whole series with guests on a changed occurrence Cancel event", async () => {
  const at = Date.UTC(2026, 10, 17);
  const record = meeting({
    organizer,
    start: { kind: "date", value: "20261116" },
    end: { kind: "date", value: "20261117" },
    startsAt: "2026-11-16T00:00:00Z",
    repeat: { rules: ["FREQ=DAILY;COUNT=120"], added: [], excluded: [] },
    deleteScopes: ["record"],
    deleteMembers: [
      { at: null, range: false, organizer: organizer.address, guests: [] },
      { at: Date.UTC(2026, 11, 21), range: false, organizer: organizer.address, guests: [guest] },
    ],
  });
  const world = openWithMailboxes(
    record,
    async () => [mailbox(organizer.address)],
    `#/cal/week/2026-11-17/e/firing@${at}`,
  );
  const press = vi.fn(async () => ({ key: "series-cancellation" }));
  world.port.press = press;
  fireEvent.click(await screen.findByRole("button", { name: "Cancel event", exact: true }));
  const scope = within(screen.getByRole("dialog", { name: /^Delete / }));
  fireEvent.click(scope.getByRole("menuitem", { name: /All events/ }));
  expect(press).not.toHaveBeenCalled();
  const question = within(screen.getByRole("dialog", { name: /Morgan Glass/ }));
  fireEvent.click(question.getByRole("button", { name: "Send cancellation" }));
  expect(press).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "calendar_event_delete",
      scope: { kind: "record" },
      audience: { organizer: organizer.address, guests: [guest.address] },
    }),
  );
});

it("opens the composer for the guests of an event", async () => {
  openWithMailboxes(meeting({ organizer, invitees: [guest] }), async () => [mailbox(organizer.address)]);
  fireEvent.click(await screen.findByRole("button", { name: "Write to invitees" }));
  expect(await screen.findByText("the place that writes")).toBeTruthy();
});

it("offers the organizer's mail action in More for a read-only event", async () => {
  const world = openWithMailboxes(meeting({ organizer, invitees: [guest] }), async () => [
    mailbox(guest.address),
  ]);
  act(() => world.put("calendar", "cal-1", calendarRecord({ access: "reader" })));
  const toolbar = within(await screen.findByRole("toolbar", { name: "Event actions" }));
  fireEvent.click(await toolbar.findByRole("button", { name: "More" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Email organizer" }));
  expect(await screen.findByText("the place that writes")).toBeTruthy();
});

it("removes a declined invitation without sending another reply", async () => {
  const record = meeting({ organizer, invitees: [guest], myAnswer: "declined" });
  const world = openWithMailboxes(record, async () => [mailbox(guest.address)]);
  const press = vi.fn(async () => ({ key: "removed" }));
  world.port.press = press;
  const toolbar = within(await screen.findByRole("toolbar", { name: "Event actions" }));
  fireEvent.click(await toolbar.findByRole("button", { name: "More" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from my calendar" }));
  await waitFor(() =>
    expect(press).toHaveBeenCalledWith({
      kind: "calendar_event_delete",
      eventId: record.id,
      base: record.updatedAt,
      scope: { kind: "record" },
      localOnly: true,
    }),
  );
});

it("chooses a recurring invitation’s scope before changing an earlier answer", async () => {
  const at = Date.UTC(2026, 10, 17, 9);
  const record = meeting({
    organizer,
    invitees: [guest],
    myAnswer: "accepted",
    start: { kind: "instant", value: "20261117T090000Z" },
    end: { kind: "instant", value: "20261117T100000Z" },
    startsAt: "2026-11-17T09:00:00Z",
    repeat: { rules: ["FREQ=DAILY;COUNT=4"], added: [], excluded: [] },
  });
  const world = openWithMailboxes(
    record,
    async () => [mailbox(guest.address)],
    `#/cal/week/2026-11-17/e/firing@${at}`,
  );
  const press = vi.fn(async () => ({ key: "answer" }));
  world.port.press = press;
  fireEvent.click(await screen.findByRole("button", { name: "Maybe" }));
  expect(press).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("menuitem", { name: "This event" }));
  await waitFor(() =>
    expect(press).toHaveBeenCalledWith({
      kind: "calendar_event_answer",
      eventId: record.id,
      base: record.updatedAt,
      scope: { kind: "occurrence", at: String(at) },
      answer: "tentative",
    }),
  );
});

describe("an invitation already answered", () => {
  const at = Date.UTC(2026, 10, 17, 9);
  const daily = (over: Partial<CalendarEventRecord> = {}) =>
    meeting({
      organizer,
      invitees: [guest],
      myAnswer: "accepted",
      start: { kind: "instant", value: "20261117T090000Z" },
      end: { kind: "instant", value: "20261117T100000Z" },
      startsAt: "2026-11-17T09:00:00Z",
      repeat: { rules: ["FREQ=DAILY;COUNT=4"], added: [], excluded: [] },
      ...over,
    });
  /** An answer to the first day alone, as the device's selector hands it: on that day, not on the series. */
  const dayAnswer = (state: "pending" | "refused") =>
    state === "pending"
      ? {
          at: String(at),
          answer: "accepted" as const,
          waiting: "provider" as const,
          refusal: null,
          refusedWriteId: null,
        }
      : {
          at: String(at),
          answer: null,
          waiting: null,
          refusal: "version_stale" as const,
          refusedWriteId: "w-day",
        };
  const openDay = (record: CalendarEventRecord, answer?: ReturnType<typeof dayAnswer>, day = at) => {
    const world = openWithMailboxes(
      record,
      async () => [mailbox(guest.address)],
      `#/cal/week/2026-11-17/e/firing@${day}`,
    );
    const events = world.port.events;
    world.port.events = () => events().map((event) => ({ ...event, ...(answer && { answers: [answer] }) }));
    act(() => world.put("calendar_event", record.id, record));
    return world;
  };

  it("shows the answer given, in the switch and in words, and asks a change as a change", async () => {
    const world = openDay(daily());
    const card = within(await screen.findByRole("dialog", { name: "Kiln check" }));
    expect(card.getByText("you said yes")).toBeTruthy();
    expect(card.queryByText("to answer")).toBeNull();
    expect((await screen.findByRole("button", { name: "Yes" })).getAttribute("aria-pressed")).toBe("true");
    world.port.press = vi.fn(async () => ({ key: "answer" }));
    fireEvent.click(screen.getByRole("button", { name: "Maybe" }));
    const scope = (await screen.findByRole("menuitem", { name: "This event" })).closest(
      "[role=menu],[role=dialog]",
    );
    expect(scope?.textContent).toContain("Change your answer to Maybe");
  });

  it("shows an answer to one day on that day while it waits, and the other days as the series stands", async () => {
    openDay(daily({ myAnswer: "none" }), dayAnswer("pending"));
    const card = within(await screen.findByRole("dialog", { name: "Kiln check" }));
    expect(card.getByText("you said yes to this one")).toBeTruthy();
    expect((await screen.findByRole("button", { name: "Yes" })).getAttribute("aria-pressed")).toBe("true");
    expect(card.getByText("Waiting")).toBeTruthy();
    cleanup();
    openDay(daily({ myAnswer: "none" }), dayAnswer("pending"), at + 86_400_000);
    const other = within(await screen.findByRole("dialog", { name: "Kiln check" }));
    expect(other.getByText("to answer")).toBeTruthy();
    expect(other.queryByText("Waiting")).toBeNull();
  });

  it("takes a refused answer to one day back on that day alone", async () => {
    openDay(daily({ myAnswer: "none" }), dayAnswer("refused"));
    const card = within(await screen.findByRole("dialog", { name: "Kiln check" }));
    expect(card.getByText("to answer")).toBeTruthy();
    expect((await screen.findByRole("button", { name: "Yes" })).getAttribute("aria-pressed")).toBe("false");
    expect(card.getByText("changed elsewhere")).toBeTruthy();
    cleanup();
    openDay(daily({ myAnswer: "none" }), dayAnswer("refused"), at + 86_400_000);
    const other = within(await screen.findByRole("dialog", { name: "Kiln check" }));
    expect(other.queryByText("changed elsewhere")).toBeNull();
  });
});

it("offers earlier real places by frequency then recency, with no web or call links", async () => {
  const record = meeting({ place: "Studio Hall" });
  const world = eventWorld(record);
  for (const [id, place, startsAt, callLink] of [
    ["old-hall", "Hill Hall", "2026-11-17T09:00:00Z", null],
    ["another-hall", "hill hall", "2026-11-19T09:00:00Z", null],
    ["new-hall", "Town Hall", "2026-11-20T09:00:00Z", null],
    ["third-hall", "Harbor Hall", "2026-11-18T09:00:00Z", null],
    ["less-recent", "Lake Hall", "2026-11-16T09:00:00Z", null],
    ["web", "https://meet.example.test/hall", "2026-11-20T09:00:00Z", null],
    ["same-call", "Hall call", "2026-11-20T09:00:00Z", "Hall call"],
  ] as const)
    world.put("calendar_event", id, meeting({ id, uid: id, place, startsAt, callLink }));
  mountFrame("#/cal/week/2026-11-16/e/firing", world, NONE);
  const card = within(await screen.findByRole("dialog", { name: record.title }));
  fireEvent.click(card.getByRole("button", { name: "Edit" }));
  const editor = within(await screen.findByRole("dialog", { name: "Edit event" }));
  const input = editor.getByLabelText("Place");
  fireEvent.change(input, { target: { value: "hall" } });
  const list = screen.getByRole("listbox", { name: "Place suggestions" });
  expect(
    within(list)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["hill hall", "Town Hall", "Harbor Hall"]);
});

it("keeps the upper panel of an invitation on neutral paper", async () => {
  const record = meeting({ organizer, invitees: [guest], myAnswer: "accepted" });
  openWithMailboxes(record, async () => [mailbox(guest.address)]);
  expect((await screen.findByRole("dialog", { name: record.title })).hasAttribute("data-neutral-head")).toBe(
    true,
  );
});

it("shows a pending portable move and withholds actions that would change the source", async () => {
  const row = meeting({
    writes: [
      {
        id: "pending-move",
        key: "move",
        part: null,
        state: "pending",
        reason: null,
        at: UPDATED,
        act: {
          kind: "calendar_event_move",
          eventId: "firing",
          toCalendarId: "elsewhere",
          base: UPDATED,
          copyThenRemove: true,
        },
      },
    ],
  });
  openWithMailboxes(row, async () => []);
  const read = within(await screen.findByRole("dialog", { name: row.title }));
  expect(read.getByText("Moving event")).toBeTruthy();
  expect(read.queryByRole("button", { name: "Edit" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete", exact: true })).toBeNull();
  expect(screen.queryByRole("button", { name: "Move to", exact: true })).toBeNull();
});
