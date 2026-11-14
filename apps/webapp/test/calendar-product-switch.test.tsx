/** @vitest-environment jsdom */
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CalendarSettingsWire } from "@ohmail/wire";
import { closeMailPage, mountMailPage, prepareMailPage, scopedSyncResponse, tick } from "./fixtures/mounted-mail-page";
import { json } from "./account/account-harness";

const calendarSettings: CalendarSettingsWire = {
  unconfigured: true,
  enabledAt: null,
  secondZone: null,
  weekNumbers: false,
  dayFromMinute: null,
  dayToMinute: null,
  newEventsCalendarId: null,
};

afterEach(closeMailPage);

it("offers Mail and Calendar before a signed-in account sets up Calendar", async () => {
  vi.stubGlobal("innerWidth", 1440);
  const server = await prepareMailPage({
    "GET /api/hello": () => json({
      product: "ohmail", flavor: "managed", needsSetup: false,
      features: { staging: false, ai: false, pairing: false, calendar: true },
    }),
    "GET /api/calendar/settings": () => scopedSyncResponse(calendarSettings),
    "PATCH /api/calendar/settings": () => scopedSyncResponse({
      ...calendarSettings, enabledAt: new Date().toISOString(),
    }),
  });
  await mountMailPage();

  expect(server.on("GET /api/calendar/settings").length).toBeGreaterThan(0);
  const products = within(screen.getByRole("group", { name: "Mail or Calendar" }));
  expect(products.getByRole("button", { name: "Mail" }).getAttribute("aria-current")).toBe("true");
  fireEvent.click(products.getByRole("button", { name: "Calendar" }));
  await tick(0);
  const useCalendar = screen.getByRole("switch", { name: "Use ohcal" });
  expect(useCalendar.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(useCalendar);
  await tick(0);
  expect(server.on("PATCH /api/calendar/settings").map(({ body }) => body)).toEqual([{ enabled: true }]);
  expect(useCalendar.getAttribute("aria-checked")).toBe("true");
});
