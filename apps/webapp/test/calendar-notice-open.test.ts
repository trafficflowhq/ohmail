import { expect, it, vi } from "vitest";
import type { FrameSupplies } from "@ohmail/app/host";
import { calendarOf, event } from "../../../packages/app-logic/test/calendar/invitations/fixtures.js";
import { mirror } from "../../../packages/app/test/calsetup/world.js";
import { openCalendarNotice, openMailNotice } from "../app/(product)/mailbox/web-notice-open";

it("opens the matching calendar event on its day in the reader's zone", () => {
  const world = mirror();
  const appointment = event("appointment", "20261116", {
    start: { kind: "instant", value: "20261116T233000Z" },
  });
  const write = vi.fn();
  const address = { write } as unknown as FrameSupplies["address"];
  world.put("calendar", calendarOf().id, calendarOf());
  world.put("calendar_event", appointment.id, appointment);
  expect(openCalendarNotice(address, world.port, appointment.id, "Europe/Zurich")).toBe(true);
  expect(write).toHaveBeenCalledWith("#/cal/week/2026-11-17/e/appointment", "push");
  expect(openCalendarNotice(address, world.port, appointment.id, "Europe/Zurich", Date.parse("2026-11-16T23:30:00Z"))).toBe(true);
  expect(write).toHaveBeenCalledTimes(2);
  world.put("calendar_event", appointment.id, null);
  expect(openCalendarNotice(address, world.port, appointment.id, "Europe/Zurich")).toBe(false);
  expect(write).toHaveBeenCalledTimes(2);
});


it("opens the occurrence named by a weekly reminder", () => {
  const world = mirror();
  const appointment = event("weekly", "20261116", {
    start: { kind: "instant", value: "20261116T090000Z" },
    end: { kind: "instant", value: "20261116T100000Z" },
    repeat: { rules: ["FREQ=WEEKLY;COUNT=4"], excluded: [], added: [] },
  });
  const write = vi.fn();
  const address = { write } as unknown as FrameSupplies["address"];
  world.put("calendar", calendarOf().id, calendarOf());
  world.put("calendar_event", appointment.id, appointment);
  const second = Date.parse("2026-11-23T09:00:00Z");
  expect(openCalendarNotice(address, world.port, appointment.id, "UTC", second)).toBe(true);
  expect(write).toHaveBeenCalledWith(`#/cal/week/2026-11-23/e/weekly%40${second}`, "push");
  expect(openCalendarNotice(address, world.port, appointment.id, "UTC", second + 60_000)).toBe(false);
  expect(write).toHaveBeenCalledOnce();
});


it("opens an identified letter and falls back to the Ohbox if the letter is gone", () => {
  const write = vi.fn();
  const address = { write } as unknown as FrameSupplies["address"];
  const present = (id: string) => id === "arrived";
  openMailNotice(address, "arrived", present);
  openMailNotice(address, "removed", present);
  openMailNotice(address, "../outside", () => true);
  expect(write.mock.calls).toEqual([
    ["#/ohbox/m/arrived", "push"],
    ["#/ohbox", "push"],
    ["#/ohbox", "push"],
  ]);
});
