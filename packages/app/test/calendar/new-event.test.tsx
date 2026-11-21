/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CalendarAct, CalendarSettingsWire } from "@ohmail/app-logic/calendar";
import { letter } from "../reader/support/mail.js";
import { fieldsOfDraft, startDraft } from "../../src/calendar/event-draft.js";
import {
  calendarRecord,
  connectionRecord,
  mirror,
  mountFrame,
  NONE,
  UPDATED,
  ZURICH,
} from "../calsetup/world.js";

const prefs: CalendarSettingsWire = {
  enabledAt: UPDATED,
  secondZone: null,
  weekNumbers: false,
  dayFromMinute: null,
  dayToMinute: null,
  newEventsCalendarId: "personal",
};

function world() {
  const w = mirror(prefs);
  w.put("calendar_connection", "conn-1", connectionRecord());
  w.put("calendar", "cal-1", calendarRecord());
  w.put("calendar", "personal", calendarRecord({ id: "personal", name: "Personal" }));
  w.put("calendar", "limited", calendarRecord({ id: "limited", name: "Availability", access: "busy" }));
  w.put("calendar", "hidden", calendarRecord({ id: "hidden", name: "Hidden", shown: false }));
  Object.assign(w.engine.store, {
    get: (kind: string, id: string) =>
      w.engine.store.entries<{ id: string }>(kind).find(({ entity }) => entity.id === id)?.entity,
  });
  return w;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-16T08:00:00Z"));
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("creates in the explicitly chosen writable calendar and keeps the words when it refuses", async () => {
  const w = world();
  const pressed: CalendarAct[] = [];
  w.port.press = async (act) => {
    pressed.push(act);
    return { key: "one-press" };
  };
  w.port.verdict = () => ({ kind: "refused", word: "calendar_read_only", details: null });
  mountFrame("#/cal/week/2026-11-16", w, NONE);
  fireEvent.click(screen.getByRole("button", { name: "New event" }));
  const form = within(screen.getByRole("dialog", { name: "New event" }));
  expect(await form.findByText("Personal")).toBeTruthy();
  const choice = form.getByRole("button", { name: "Calendar" });
  choice.focus();
  fireEvent.click(choice);
  const menu = within(screen.getByRole("menu", { name: "Calendar" }));
  expect(menu.queryByText("Hidden")).toBeNull();
  expect(menu.queryByText("Availability")).toBeNull();
  fireEvent.click(menu.getByText("Studio"));
  const title = form.getByRole("textbox", { name: "Event title" });
  fireEvent.change(title, { target: { value: "Studio visit" } });
  fireEvent.click(form.getByRole("button", { name: "Add" }));
  expect(await form.findByText("This calendar can be looked at, not changed.")).toBeTruthy();
  expect((title as HTMLInputElement).value).toBe("Studio visit");
  expect(pressed).toMatchObject([
    { kind: "calendar_event_create", calendarId: "cal-1", event: { title: "Studio visit" } },
  ]);
  act(() => w.put("calendar", "cal-1", calendarRecord({ access: "reader" })));
  expect((form.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
});

it("adds and edits invitees in a new draft and asks before sending invitations", async () => {
  const w = world();
  const press = vi.fn(async () => ({ key: "create" }));
  w.port.press = press;
  mountFrame("#/cal/week/2026-11-16?panel=new", w, NONE);
  const form = within(screen.getByRole("dialog", { name: "New event" }));
  await form.findByText("Personal");
  fireEvent.change(form.getByRole("textbox", { name: "Event title" }), { target: { value: "Planning" } });
  fireEvent.click(form.getByRole("button", { name: "Invitees" }));
  const picker = within(screen.getByRole("dialog", { name: "Add invitees" }));
  const address = ["Mara <mara", "example.test>"].join("@");
  fireEvent.change(picker.getByRole("textbox", { name: "Name or email address" }), {
    target: { value: address },
  });
  fireEvent.click(picker.getByRole("button", { name: "Add person" }));
  fireEvent.click(form.getByRole("button", { name: /^Mara/ }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Optional" }));
  fireEvent.click(form.getByRole("button", { name: "Add" }));
  expect(press).not.toHaveBeenCalled();
  const question = within(screen.getByRole("dialog", { name: "Invite Mara?" }));
  fireEvent.click(question.getByRole("button", { name: "Invite" }));
  expect(press).toHaveBeenCalledWith(
    expect.objectContaining({
      event: expect.objectContaining({
        invitees: [{ name: "Mara", address: ["mara", "example.test"].join("@"), role: "optional" }],
      }),
    }),
  );
  await act(async () => {});
});

it("saves a new event with the selected alert in place of the calendar default", async () => {
  const w = world();
  w.put(
    "calendar",
    "personal",
    calendarRecord({
      id: "personal",
      name: "Personal",
      defaultAlarms: [{ method: "notice", minutesBefore: 15 }],
    }),
  );
  const press = vi.fn(async () => ({ key: "create" }));
  w.port.press = press;
  mountFrame("#/cal/week/2026-11-16?panel=new", w, NONE);
  const form = within(screen.getByRole("dialog", { name: "New event" }));
  await form.findByText("Personal");
  fireEvent.change(form.getByRole("textbox", { name: "Event title" }), { target: { value: "Planning" } });
  fireEvent.click(form.getByRole("button", { name: "Alert" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "30 minutes before" }));
  fireEvent.click(form.getByRole("button", { name: "Add" }));
  expect(press).toHaveBeenCalledWith(
    expect.objectContaining({
      event: expect.objectContaining({ alarms: [30] }),
    }),
  );
  await act(async () => {});
});

it("can remove an extra alert after switching the draft to a calendar that accepts one", async () => {
  const w = world();
  w.put("calendar_connection", "conn-work", connectionRecord({ id: "conn-work", provider: "microsoft" }));
  w.put("calendar", "work", calendarRecord({ id: "work", name: "Work", connectionId: "conn-work" }));
  const press = vi.fn(async () => ({ key: "create" }));
  w.port.press = press;
  mountFrame("#/cal/week/2026-11-16?panel=new", w, NONE);
  const form = within(screen.getByRole("dialog", { name: "New event" }));
  await form.findByText("Personal");
  fireEvent.change(form.getByRole("textbox", { name: "Event title" }), { target: { value: "Planning" } });
  fireEvent.click(form.getByRole("button", { name: "Alert" }));
  fireEvent.click(form.getByRole("button", { name: "Alert" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "15 minutes before" }));
  fireEvent.click(form.getByRole("button", { name: "and another" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "30 minutes before" }));
  fireEvent.click(form.getByRole("button", { name: "Calendar" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Work" }));
  expect(form.getByRole("button", { name: "Add" })).toHaveProperty("disabled", true);
  fireEvent.click(form.getByRole("button", { name: "and another" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "None" }));
  fireEvent.click(form.getByRole("button", { name: "Add" }));
  expect(press).toHaveBeenCalledWith(
    expect.objectContaining({
      calendarId: "work",
      event: expect.objectContaining({ alarms: [15] }),
    }),
  );
  await act(async () => {});
});

it.each(["Pizza tomorrow", "Pizza morgen"])("saves %s as a whole day", async (title) => {
  const w = world();
  const press = vi.fn(async () => ({ key: "create" }));
  w.port.press = press;
  mountFrame("#/cal/week/2026-11-16?panel=new&slot=540-600", w, NONE);
  const form = within(screen.getByRole("dialog", { name: "New event" }));
  await form.findByText("Personal");
  fireEvent.change(form.getByRole("textbox", { name: "Event title" }), { target: { value: title } });
  fireEvent.click(form.getByRole("button", { name: "Add" }));
  expect(press).toHaveBeenCalledWith(
    expect.objectContaining({
      event: expect.objectContaining({
        title: "Pizza",
        start: { kind: "date", value: "20261117" },
        end: { kind: "date", value: "20261118" },
      }),
    }),
  );
  await act(async () => {});
});

it.each([
  ["Dentist tomorrow 3pm", "Dentist", "15:00", "20261117T150000", null],
  ["Abholung morgen um 15 Uhr", "Abholung", "15:00", "20261117T150000", null],
])("fills a new event from the typed line %s", async (typed, title, clock, start, repeat) => {
  const w = world();
  const press = vi.fn(async () => ({ key: "create" }));
  w.port.press = press;
  mountFrame("#/cal/week/2026-11-16?panel=new", w, NONE);
  const form = within(screen.getByRole("dialog", { name: "New event" }));
  await form.findByText("Personal");
  fireEvent.change(form.getByRole("textbox", { name: "Event title" }), { target: { value: typed } });
  expect(form.getByLabelText("Start time")).toHaveProperty("value", clock);
  fireEvent.click(form.getByRole("button", { name: "Add" }));
  expect(press).toHaveBeenCalledWith(
    expect.objectContaining({
      event: expect.objectContaining({ title, start: expect.objectContaining({ value: start }), repeat }),
    }),
  );
  await act(async () => {});
});

it("keeps an explicit time after changing the parsed draft in the form", async () => {
  const w = world();
  const press = vi.fn(async () => ({ key: "create" }));
  w.port.press = press;
  mountFrame("#/cal/week/2026-11-16?panel=new", w, NONE);
  const form = within(screen.getByRole("dialog", { name: "New event" }));
  await form.findByText("Personal");
  fireEvent.change(form.getByRole("textbox", { name: "Event title" }), {
    target: { value: "Dentist tomorrow 3pm" },
  });
  fireEvent.change(form.getByLabelText("Start time"), { target: { value: "14:30" } });
  expect(form.getByLabelText("End time")).toHaveProperty("value", "16:00");
  fireEvent.click(form.getByRole("button", { name: "Add" }));
  expect(press).toHaveBeenCalledWith(
    expect.objectContaining({
      event: expect.objectContaining({
        title: "Dentist",
        start: expect.objectContaining({ value: "20261117T143000" }),
      }),
    }),
  );
  await act(async () => {});
});

it("keeps words about recurrence in the entered title", async () => {
  const w = world();
  const press = vi.fn(async () => ({ key: "create" }));
  w.port.press = press;
  mountFrame("#/cal/week/2026-11-16?panel=new", w, NONE);
  const form = within(screen.getByRole("dialog", { name: "New event" }));
  await form.findByText("Personal");
  const title = form.getByRole("textbox", { name: "Event title" });
  fireEvent.change(title, { target: { value: "Dentist tomorrow 3pm weekly" } });
  fireEvent.change(form.getByLabelText("Start time"), { target: { value: "14:30" } });
  expect(title).toHaveProperty("value", "Dentist weekly");
  fireEvent.click(form.getByRole("button", { name: "Add" }));
  expect(press).toHaveBeenCalledWith(
    expect.objectContaining({
      event: expect.objectContaining({
        title: "Dentist weekly",
        repeat: null,
        start: expect.objectContaining({ value: "20261117T143000" }),
      }),
    }),
  );
  await act(async () => {});
});

it("takes a place suggested by the account service and keeps its attribution with the rows", async () => {
  const w = world();
  const ask = vi.fn(async () => ({
    state: "ok",
    credit: "osm",
    places: [{ kind: "venue", first: "Library", second: "Central district", country: null, lat: 0, lon: 0 }],
  }));
  Object.assign(w.engine, { suggestPlaces: ask });
  const press = vi.fn(async () => ({ key: "create" }));
  w.port.press = press;
  mountFrame("#/cal/week/2026-11-16?panel=new", w, NONE);
  const form = within(screen.getByRole("dialog", { name: "New event" }));
  await form.findByText("Personal");
  fireEvent.click(form.getByRole("button", { name: "Place" }));
  const place = form.getByLabelText("Place");
  fireEvent.change(place, { target: { value: "Li" } });
  expect(ask).not.toHaveBeenCalled();
  fireEvent.change(place, { target: { value: "Lib" } });
  const list = await screen.findByRole("listbox", { name: "Place suggestions" });
  expect(ask).toHaveBeenCalledWith(
    { text: "Lib", lang: "en" },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(screen.getByText("© OpenStreetMap contributors")).toBeTruthy();
  fireEvent.click(within(list).getByRole("option", { name: /Lib\s*rary/ }));
  expect(place).toHaveProperty("value", "Library, Central district");
  expect(screen.queryByText("© OpenStreetMap contributors")).toBeNull();
  fireEvent.change(form.getByRole("textbox", { name: "Event title" }), { target: { value: "Planning" } });
  fireEvent.click(form.getByRole("button", { name: "Add" }));
  expect(press).toHaveBeenCalledWith(
    expect.objectContaining({ event: expect.objectContaining({ place: "Library, Central district" }) }),
  );
  await act(async () => {});
});

it("keeps a typed place when the account's suggestion service is off", async () => {
  const w = world();
  const ask = vi.fn(async () => ({ state: "off", places: [], credit: null }));
  Object.assign(w.engine, { suggestPlaces: ask });
  mountFrame("#/cal/week/2026-11-16?panel=new", w, NONE);
  const form = within(screen.getByRole("dialog", { name: "New event" }));
  await form.findByText("Personal");
  fireEvent.click(form.getByRole("button", { name: "Place" }));
  const place = form.getByLabelText("Place");
  fireEvent.change(place, { target: { value: "The rooftop" } });
  await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("listbox", { name: "Place suggestions" })).toBeNull();
  expect(place).toHaveProperty("value", "The rooftop");
});

it("fills a run of whole days and its place from a typed line", async () => {
  const w = world();
  const press = vi.fn(async () => ({ key: "create" }));
  w.port.press = press;
  mountFrame("#/cal/week/2026-11-16?panel=new", w, NONE);
  const form = within(screen.getByRole("dialog", { name: "New event" }));
  await form.findByText("Personal");
  fireEvent.change(form.getByRole("textbox", { name: "Event title" }), {
    target: { value: "Makersfest 20.–22. Nov in Zürich" },
  });
  expect(form.getByRole("switch", { name: "All day" }).getAttribute("aria-checked")).toBe("true");
  expect(form.getByLabelText("Place")).toHaveProperty("value", "Zürich");
  fireEvent.click(form.getByRole("button", { name: "Add" }));
  expect(press).toHaveBeenCalledWith(
    expect.objectContaining({
      event: expect.objectContaining({
        title: "Makersfest",
        start: { kind: "date", value: "20261120" },
        end: { kind: "date", value: "20261123" },
        place: "Zürich",
      }),
    }),
  );
  await act(async () => {});
});

it.each([false, true])("only includes a proposed guest if accepted (%s)", async (accept) => {
  const w = world();
  const contact = ["ben", "example.test"].join("@");
  w.put("message", "from-ben", letter("from-ben", { from: { name: "Ben Arnold", address: contact } }));
  const press = vi.fn(async () => ({ key: "create" }));
  w.port.press = press;
  mountFrame("#/cal/week/2026-11-16?panel=new", w, NONE);
  const form = within(screen.getByRole("dialog", { name: "New event" }));
  await form.findByText("Personal");
  fireEvent.change(form.getByRole("textbox", { name: "Event title" }), {
    target: { value: "Lunch with Ben tomorrow 1pm" },
  });
  const proposal = form.getByRole("button", { name: "Ben Arnold", exact: true });
  expect(press).not.toHaveBeenCalled();
  if (accept) fireEvent.click(proposal);
  fireEvent.click(form.getByRole("button", { name: "Add" }));
  if (accept) {
    expect(press).not.toHaveBeenCalled();
    const question = within(screen.getByRole("dialog", { name: "Invite Ben Arnold?" }));
    fireEvent.click(question.getByRole("button", { name: "Invite" }));
  }
  expect(press).toHaveBeenCalledWith(
    expect.objectContaining({
      event: expect.objectContaining({
        title: "Lunch with Ben",
        invitees: accept ? [{ address: contact, name: "Ben Arnold", role: "required" }] : [],
      }),
    }),
  );
  await act(async () => {});
});

it("reads a bare hour as a morning hour in a typed line", async () => {
  const w = world();
  mountFrame("#/cal/week/2026-11-16?panel=new", w, NONE);
  const form = within(screen.getByRole("dialog", { name: "New event" }));
  await form.findByText("Personal");
  fireEvent.change(form.getByRole("textbox", { name: "Event title" }), { target: { value: "Flight at 6" } });
  expect(form.getByLabelText("Start time")).toHaveProperty("value", "06:00");
});

it("passes through the calendar's own Microsoft alerts when they were never edited", async () => {
  const w = world();
  w.put("calendar_connection", "conn-1", connectionRecord({ provider: "microsoft" }));
  w.put(
    "calendar",
    "personal",
    calendarRecord({
      id: "personal",
      name: "Personal",
      defaultAlarms: [
        { method: "notice", minutesBefore: 15 },
        { method: "notice", minutesBefore: 30 },
      ],
    }),
  );
  const press = vi.fn(async () => ({ key: "create" }));
  w.port.press = press;
  mountFrame("#/cal/week/2026-11-16?panel=new", w, NONE);
  const form = within(screen.getByRole("dialog", { name: "New event" }));
  await form.findByText("Personal");
  fireEvent.change(form.getByRole("textbox", { name: "Event title" }), { target: { value: "Planning" } });
  fireEvent.click(form.getByRole("button", { name: "Add" }));
  expect(press).toHaveBeenCalledWith(
    expect.objectContaining({ event: expect.objectContaining({ alarms: [15, 30] }) }),
  );
  await act(async () => {});
});

it("puts an untitled draft with an explicit alert on Undo", async () => {
  const w = world();
  mountFrame("#/cal/week/2026-11-16?panel=new", w, NONE);
  const form = within(screen.getByRole("dialog", { name: "New event" }));
  await form.findByText("Personal");
  fireEvent.click(form.getByRole("button", { name: "Alert" }));
  fireEvent.click(form.getByRole("button", { name: "Alert" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "15 minutes before" }));
  fireEvent.click(form.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(
    within(screen.getByRole("dialog", { name: "New event" })).getByText("15 minutes before"),
  ).toBeTruthy();
});

it("restores a guest on Undo before asking to send the invitation", async () => {
  const w = world();
  const press = vi.fn(async () => ({ key: "create" }));
  w.port.press = press;
  const address = ["mara", "example.test"].join("@");
  mountFrame("#/cal/week/2026-11-16?panel=new", w, NONE);
  const draft = () => within(screen.getByRole("dialog", { name: "New event" }));
  await draft().findByText("Personal");
  fireEvent.click(draft().getByRole("button", { name: "Invitees" }));
  const picker = within(screen.getByRole("dialog", { name: "Add invitees" }));
  fireEvent.change(picker.getByRole("textbox", { name: "Name or email address" }), {
    target: { value: `Mara <${address}>` },
  });
  fireEvent.click(picker.getByRole("button", { name: "Add person" }));
  fireEvent.click(draft().getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(draft().getByRole("button", { name: /^Mara/ })).toBeTruthy();
  expect(press).not.toHaveBeenCalled();
  fireEvent.change(draft().getByRole("textbox", { name: "Event title" }), { target: { value: "Planning" } });
  fireEvent.click(draft().getByRole("button", { name: "Add" }));
  const question = within(screen.getByRole("dialog", { name: "Invite Mara?" }));
  expect(press).not.toHaveBeenCalled();
  fireEvent.click(question.getByRole("button", { name: "Invite" }));
  expect(press).toHaveBeenCalledTimes(1);
  expect(press).toHaveBeenCalledWith(
    expect.objectContaining({
      event: expect.objectContaining({ invitees: [{ name: "Mara", address, role: "required" }] }),
    }),
  );
  await act(async () => {});
});

it("keeps the same submission while its receipt is pending", async () => {
  const w = world();
  let finish!: () => void;
  const started = vi.fn(async () => ({ key: "one" }));
  w.port.press = started;
  w.port.flush = () =>
    new Promise<void>((r) => {
      finish = r;
    });
  mountFrame("#/cal/week/2026-11-16?panel=new", w, NONE);
  const form = within(await screen.findByRole("dialog", { name: "New event" }));
  const title = form.getByRole("textbox", { name: "Event title" });
  fireEvent.change(title, { target: { value: "Planning" } });
  const add = form.getByRole("button", { name: "Add" });
  fireEvent.click(add);
  fireEvent.keyDown(title, { key: "Enter" });
  expect(started).toHaveBeenCalledTimes(1);
  await act(async () => {
    await Promise.resolve();
    finish();
  });
  expect(screen.queryByRole("dialog", { name: "New event" })).toBeNull();
});

it("keeps an overnight event in the reader's time zone and applies the target calendar's reminders", () => {
  const draft = { ...startDraft("2026-11-16", 17 * 60), title: "Late firing", from: "22:00", to: "01:30" };
  const cal = calendarRecord({ defaultAlarms: [{ method: "notice", minutesBefore: 15 }] });
  expect(fieldsOfDraft(draft, cal, ZURICH)).toMatchObject({
    start: { kind: "zoned", value: "20261116T220000", zone: ZURICH },
    end: { kind: "zoned", value: "20261117T013000", zone: ZURICH },
    alarms: [15],
  });
  expect(fieldsOfDraft({ ...draft, allDay: true }, cal, ZURICH)).toMatchObject({
    start: { kind: "date", value: "20261116" },
    end: { kind: "date", value: "20261117" },
  });
  expect(fieldsOfDraft({ ...draft, from: "28:00" }, cal, ZURICH)).toBeNull();
});

it("recovers the words and the chosen calendar after closing a new draft", async () => {
  const w = world();
  const press = vi.fn(async () => ({ key: "create" }));
  w.port.press = press;
  mountFrame("#/cal/week/2026-11-16", w, NONE);
  fireEvent.click(screen.getByRole("button", { name: "New event" }));
  const form = within(screen.getByRole("dialog", { name: "New event" }));
  await form.findByText("Personal");
  fireEvent.click(form.getByRole("button", { name: "Calendar" }));
  fireEvent.click(within(screen.getByRole("menu", { name: "Calendar" })).getByText("Studio"));
  fireEvent.change(form.getByRole("textbox", { name: "Event title" }), { target: { value: "Studio visit" } });
  fireEvent.click(form.getByRole("button", { name: "Close" }));
  expect(screen.getByText("Discarded")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  const restored = within(await screen.findByRole("dialog", { name: "New event" }));
  expect(restored.getByDisplayValue("Studio visit")).toBeTruthy();
  expect(restored.getByRole("button", { name: "Calendar" }).textContent).toBe("Studio");
  expect(press).not.toHaveBeenCalled();
});

it("opens the end-day picker from the overnight cue and refuses equal times", async () => {
  const w = world();
  const press = vi.fn(async () => ({ key: "create" }));
  w.port.press = press;
  mountFrame("#/cal/week/2026-11-16?panel=new", w, NONE);
  const form = within(await screen.findByRole("dialog", { name: "New event" }));
  fireEvent.change(form.getByRole("textbox", { name: "Event title" }), { target: { value: "Late firing" } });
  fireEvent.change(form.getByRole("textbox", { name: "Start time" }), { target: { value: "22:00" } });
  const end = form.getByRole("textbox", { name: "End time" });
  fireEvent.change(end, { target: { value: "22:00" } });
  const add = form.getByRole<HTMLButtonElement>("button", { name: "Add" });
  expect(add.disabled).toBe(true);
  fireEvent.change(end, { target: { value: "01:00" } });
  fireEvent.click(form.getByRole("button", { name: "next day" }));
  const picker = within(screen.getByRole("dialog", { name: "End date" }));
  const grid = picker.getByRole("grid");
  fireEvent.click(grid.querySelector<HTMLButtonElement>('[data-day="2026-11-19"]')!);
  await act(async () => fireEvent.click(add));
  expect(press).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "calendar_event_create",
      event: expect.objectContaining({ end: expect.objectContaining({ value: "20261119T010000" }) }),
    }),
  );
});

it.each([
  ["Back", "#/cal/week/2026-11-16"],
  ["another place", "#/cal/month/2026-11-16"],
])("recovers a new draft after leaving by %s", async (_name, destination) => {
  const w = world();
  const press = vi.fn(async () => ({ key: "create" }));
  w.port.press = press;
  const { address } = mountFrame("#/cal/week/2026-11-16", w, NONE);
  fireEvent.click(screen.getByRole("button", { name: "New event" }));
  const editor = within(screen.getByRole("dialog", { name: "New event" }));
  await editor.findByText("Personal");
  fireEvent.click(editor.getByRole("button", { name: "Calendar" }));
  fireEvent.click(within(screen.getByRole("menu", { name: "Calendar" })).getByText("Studio"));
  fireEvent.change(editor.getByRole("textbox", { name: "Event title" }), {
    target: { value: "Glaze order" },
  });

  act(() => address.visit(destination));
  expect(screen.queryByRole("dialog", { name: "New event" })).toBeNull();
  expect(screen.getByText("Discarded")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  const restored = within(await screen.findByRole("dialog", { name: "New event" }));
  expect(restored.getByDisplayValue("Glaze order")).toBeTruthy();
  expect(restored.getByRole("button", { name: "Calendar" }).textContent).toBe("Studio");
  expect(press).not.toHaveBeenCalled();
});

it.each([
  ["click", 600, 600, "10:00", "11:00"],
  ["drag", 610, 682, "10:15", "11:15"],
])("opens a draft for an empty Day slot by %s", async (_gesture, down, up, from, to) => {
  mountFrame("#/cal/day/2026-11-16", world(), NONE);
  const column = screen.getByRole("group", { name: /November 16/ });
  vi.spyOn(column, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ width: 120, height: 1440 }));
  const hours = column.closest("[data-today-scroll]")!;
  vi.spyOn(hours, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ width: 120, height: 900 }));
  const pointer = (target: EventTarget, type: string, y: number) =>
    fireEvent(
      target,
      Object.assign(new MouseEvent(type, { bubbles: true, clientX: 30, clientY: y }), { pointerId: 1 }),
    );
  pointer(column, "pointerdown", down);
  pointer(document, "pointerup", up);
  const form = within(await screen.findByRole("dialog", { name: "New event" }));
  expect(form.getByDisplayValue(from)).toBeTruthy();
  expect(form.getByDisplayValue(to)).toBeTruthy();
});

it("opens a new draft by keyboard and uses the selected empty hour", async () => {
  mountFrame("#/cal/week/2026-11-16", world(), NONE);
  fireEvent.keyDown(document.body, { key: "c" });
  const form = within(await screen.findByRole("dialog", { name: "New event" }));
  fireEvent.click(form.getByRole("button", { name: "Cancel" }));
  fireEvent.keyDown(document.body, { key: "ArrowDown" });
  fireEvent.keyDown(document.body, { key: "ArrowDown" });
  fireEvent.keyDown(document.body, { key: "Enter" });
  const slot = within(await screen.findByRole("dialog", { name: "New event" }));
  expect(slot.getByDisplayValue("10:00")).toBeTruthy();
  expect(slot.getByDisplayValue("11:00")).toBeTruthy();
});

it("offers a writable calendar when the preferred one is view-only", async () => {
  const w = world();
  w.put("calendar", "personal", calendarRecord({ id: "personal", name: "Personal", access: "reader" }));
  mountFrame("#/cal/week/2026-11-16", w, NONE);
  fireEvent.click(screen.getByRole("button", { name: "New event" }));
  const form = within(await screen.findByRole("dialog", { name: "New event" }));
  expect(await form.findByText("This calendar can be looked at, not changed.")).toBeTruthy();
  expect(form.getByRole("button", { name: "Calendar" }).textContent).toBe("Studio");
});

it("keeps the next date when a selected slot ends at midnight", () => {
  const draft = { ...startDraft("2026-11-16", 9 * 60, "0-1440"), title: "Open studio" };
  expect(fieldsOfDraft(draft, calendarRecord(), ZURICH)).toMatchObject({
    start: { value: "20261116T000000" },
    end: { value: "20261117T000000" },
  });
});

const openDraft = (entry: "button" | "keyboard") => {
  if (entry === "button") fireEvent.click(screen.getByRole("button", { name: "New event" }));
  else fireEvent.keyDown(document.body, { key: "c" });
  return within(screen.getByRole("dialog", { name: "New event" }));
};

it.each([
  {
    entry: "button",
    timeZone: ZURICH,
    before: "2026-11-20T22:59:50Z",
    now: "2026-11-20T23:00:10Z",
    date: "Sat 21 Nov",
    from: "01:00",
  },
  {
    entry: "keyboard",
    timeZone: "America/Los_Angeles",
    before: "2026-11-21T07:59:50Z",
    now: "2026-11-21T08:00:10Z",
    date: "Sat 21 Nov",
    from: "01:00",
  },
  {
    entry: "keyboard",
    timeZone: ZURICH,
    before: "2026-11-21T22:48:00Z",
    now: "2026-11-21T22:48:00Z",
    date: "Sat 21 Nov",
    from: "23:00",
  },
  {
    entry: "button",
    timeZone: "America/Los_Angeles",
    before: "2026-11-22T07:48:00Z",
    now: "2026-11-22T07:48:00Z",
    date: "Sat 21 Nov",
    from: "23:00",
  },
] as const)(
  "opens by $entry on the local date in $timeZone at $now",
  ({ entry, timeZone, before, now, date, from }) => {
    vi.setSystemTime(new Date(before));
    mountFrame("#/cal/week", world(), NONE, { timeZone });
    // The new-event action can run before the calendar's next minute tick.
    vi.setSystemTime(new Date(now));
    const form = openDraft(entry);
    expect(form.getByRole("button", { name: "Event date" }).textContent).toBe(date);
    expect(form.getByRole<HTMLInputElement>("textbox", { name: "Start time" }).value).toBe(from);
  },
);

it.each(["button", "keyboard"] as const)("opens by %s at the next hour on a selected day", (entry) => {
  vi.setSystemTime(new Date("2026-11-21T13:42:00Z"));
  mountFrame("#/cal/week/2026-11-20", world(), NONE);
  const form = openDraft(entry);
  expect(form.getByRole("button", { name: "Event date" }).textContent).toBe("Fri 20 Nov");
  expect(form.getByDisplayValue("15:00")).toBeTruthy();
});

it("opens today's draft after saving on the previous day from an undated calendar", async () => {
  vi.setSystemTime(new Date("2026-11-20T13:42:00Z"));
  const w = world();
  w.port.press = async () => ({ key: "create" });
  mountFrame("#/cal/week", w, NONE);
  const yesterday = openDraft("button");
  fireEvent.change(yesterday.getByRole("textbox", { name: "Event title" }), {
    target: { value: "Workshop" },
  });
  await act(async () => fireEvent.click(yesterday.getByRole("button", { name: "Add" })));
  expect(screen.queryByRole("dialog", { name: "New event" })).toBeNull();

  vi.setSystemTime(new Date("2026-11-21T13:42:00Z"));
  const today = openDraft("keyboard");
  expect(today.getByRole("button", { name: "Event date" }).textContent).toBe("Sat 21 Nov");
  expect(today.getByDisplayValue("15:00")).toBeTruthy();
});

it.each([
  ["2026-03-29", "02:30", /clock change skips/i, true],
  ["2026-10-25", "02:30", /first occurrence/i, false],
] as const)("explains the clock change when creating on %s", async (day, end, message, disabled) => {
  const morning = new Date(day);
  morning.setUTCHours(9);
  vi.setSystemTime(morning);
  mountFrame(`#/cal/week/${day}?panel=new`, world(), NONE);
  const form = within(await screen.findByRole("dialog", { name: "New event" }));
  for (const [name, value] of [
    ["Event title", "Workshop"],
    ["Start time", "01:30"],
    ["End time", end],
  ]) {
    fireEvent.change(form.getByRole("textbox", { name }), { target: { value } });
  }
  expect(form.getByText(message)).toBeTruthy();
  expect(form.getByRole<HTMLButtonElement>("button", { name: "Add" }).disabled).toBe(disabled);
});
