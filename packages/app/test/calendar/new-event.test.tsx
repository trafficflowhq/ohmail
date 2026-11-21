/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CalendarAct, CalendarSettingsWire } from "@ohmail/app-logic/calendar";
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
