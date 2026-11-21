/** @vitest-environment jsdom */
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CalendarConnectionRecord, CalendarRecord, CalendarSettingsWire } from "@ohmail/wire";
import { ISO, closeMailPage, mountMailPage, prepareMailPage, scopedSyncResponse, tick } from "./fixtures/mounted-mail-page";
import { json } from "./account/account-harness";

const calendarSettings: CalendarSettingsWire = {
  enabledAt: null,
  secondZone: null,
  weekNumbers: false,
  dayFromMinute: null,
  dayToMinute: null,
  newEventsCalendarId: null,
};

afterEach(closeMailPage);

const hello = () => json({
  product: "ohmail", flavor: "managed", needsSetup: false,
  features: { staging: false, ai: false, pairing: false, calendar: true },
});

const products = () => within(screen.getByRole("group", { name: "Mail or Calendar" }));

it("opens the calendar's first step before a signed-in account sets up Calendar", async () => {
  vi.stubGlobal("innerWidth", 1440);
  let enabled = false;
  const server = await prepareMailPage({
    "GET /api/hello": hello,
    "GET /api/calendar/settings": () => scopedSyncResponse(enabled ? { ...calendarSettings, enabledAt: ISO } : {
      ...calendarSettings, unconfigured: true,
    }),
    "PATCH /api/calendar/settings": () => {
      enabled = true;
      return scopedSyncResponse({ ...calendarSettings, enabledAt: ISO });
    },
    "GET /api/calendar/connect": () => scopedSyncResponse({ ways: enabled ? ["caldav"] : [], connections: [] }),
  });
  await mountMailPage();

  expect(server.on("GET /api/calendar/settings").length).toBeGreaterThan(0);
  expect(products().getByRole("button", { name: "Mail" }).getAttribute("aria-current")).toBe("true");
  fireEvent.click(products().getByRole("button", { name: "Calendar" }));
  await tick(0);
  expect(location.hash).toBe("#/cal/week");
  expect(document.documentElement.dataset.product).toBe("cal");
  const calendar = within(screen.getByRole("region", { name: "Calendar" }));
  expect(screen.getByRole("region", { name: "Calendar" }).textContent).toContain("No calendar account");
  expect(calendar.getByRole("button", { name: "Connect a calendar" })).toBeTruthy();
  expect(server.on("PATCH /api/calendar/settings")).toHaveLength(0);

  fireEvent.click(products().getByRole("button", { name: "Mail" }));
  await tick(0);
  expect(location.hash).toBe("#/ohbox");
  fireEvent.click(products().getByRole("button", { name: "Calendar" }));
  await tick(0);
  expect(location.hash).toBe("#/cal/week");

  fireEvent.click(within(screen.getByRole("region", { name: "Calendar" }))
    .getByRole("button", { name: "Connect a calendar" }));
  await tick(0);
  expect(location.hash).toBe("#/cal/calendars/calaccounts");
  const useCalendar = screen.getByRole("switch", { name: "Use ohcal" });
  expect(useCalendar.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(useCalendar);
  await tick(0);
  expect(server.on("PATCH /api/calendar/settings").map(({ body }) => body)).toEqual([{ enabled: true }]);
  expect(useCalendar.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("button", { name: "Add a calendar account" })).toBeTruthy();

  fireEvent.click(products().getByRole("button", { name: "Mail" }));
  await tick(0);
  fireEvent.click(products().getByRole("button", { name: "Calendar" }));
  await tick(0);
  expect(location.hash).toBe("#/cal/week");
  const firstStep = within(screen.getByRole("region", { name: "Calendar" }));
  fireEvent.click(firstStep.getByRole("button", { name: "Connect a calendar" }));
  await tick(0);
  expect(location.hash).toBe("#/cal/calendars/calaccounts");
  fireEvent.click(screen.getByRole("button", { name: "Add a calendar account" }));
  await tick(0);
  expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Another CalDAV server" })).toBeTruthy();
});

it("opens the week and returns to the same dated Month for an account with a calendar", async () => {
  vi.stubGlobal("innerWidth", 1440);
  const connection: CalendarConnectionRecord = {
    id: "c1", provider: "caldav", label: "Work", status: "active", errorCode: null,
    grantMailboxId: null, serverHost: null, consentedAt: ISO, lastSyncedAt: ISO, createdAt: ISO, updatedAt: ISO,
  };
  const calendar: CalendarRecord = {
    id: "w1", connectionId: connection.id, name: "Work", color: null, access: "owner", shown: true,
    timeZone: "UTC", window: null, defaultAlarms: [], lastSyncedAt: ISO, errorCode: null, updatedAt: ISO,
  };
  await prepareMailPage({
    "GET /api/hello": hello,
    "GET /api/calendar/settings": () => scopedSyncResponse({ ...calendarSettings, enabledAt: ISO }),
    "GET /api/calendar/connect": () => scopedSyncResponse({ ways: ["caldav"], connections: [connection] }),
    "GET /api/sync": () => scopedSyncResponse({
      changes: {
        creates: [
          { type: "calendar_connection", op: "create", id: connection.id, seq: 1, updatedAt: ISO, entity: connection },
          { type: "calendar", op: "create", id: calendar.id, seq: 2, updatedAt: ISO, entity: calendar },
        ],
        updates: [], moves: [], deletes: [],
      },
      cursor: "c2", hasMore: false, serverTime: ISO,
    }),
  });
  await mountMailPage();

  fireEvent.click(products().getByRole("button", { name: "Calendar" }));
  await tick(0);
  expect(location.hash).toBe("#/cal/week");
  expect(screen.getByRole("region", { name: "The week's hours" })).toBeTruthy();
  expect(products().getByRole("button", { name: "Calendar" }).getAttribute("aria-current")).toBe("true");
  fireEvent.keyDown(document.body, { key: "3" });
  await tick(0);
  fireEvent.keyDown(document.body, { key: "]" });
  await tick(0);
  const month = location.hash;
  expect(month).toMatch(/^#\/cal\/month\/2026-\d{2}-\d{2}$/);
  expect(screen.getByRole("region", { name: "Month" })).toBeTruthy();

  fireEvent.click(products().getByRole("button", { name: "Mail" }));
  await tick(0);
  expect(products().getByRole("button", { name: "Mail" }).getAttribute("aria-current")).toBe("true");
  fireEvent.click(products().getByRole("button", { name: "Calendar" }));
  await tick(0);
  expect(location.hash).toBe(month);
  expect(screen.getByRole("region", { name: "Month" })).toBeTruthy();
});
