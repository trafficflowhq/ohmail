/** @vitest-environment jsdom */
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CalendarSettingsWire } from "@ohmail/wire";
import { calendarOf, connection, event } from "../../../packages/app-logic/test/calendar/invitations/fixtures";
import { ACCOUNT, ISO, calendarSnapshot, closeMailPage, mountMailPage, prepareMailPage, scopedSyncResponse, tick } from "./fixtures/mounted-mail-page";
import { searchField, typeSearch } from "./search-registered-fixture";
import { json } from "./account/account-harness";

afterEach(closeMailPage);

it.each([true, false])("uses only matching visible events from the mirror when Calendar is enabled (%s)", async (enabled) => {
  vi.stubGlobal("innerWidth", 1440);
  const settings: CalendarSettingsWire = {
    enabledAt: enabled ? ISO : null,
    secondZone: null,
    weekNumbers: false,
    dayFromMinute: null,
    dayToMinute: null,
    newEventsCalendarId: null,
  };
  const shown = calendarOf();
  const hidden = calendarOf({ id: "hidden", shown: false });
  const records = [
    ["settings", { id: ACCOUNT, accountId: ACCOUNT, calendarEnabledAt: settings.enabledAt, updatedAt: ISO }],
    ["calendar_connection", connection()],
    ["calendar", shown],
    ["calendar", hidden],
    ["calendar_event", event("first", "20260904", { title: "Woodwork" })],
    ["calendar_event", event("second", "20260905", { title: "Workshop", notes: "Woodwork" })],
    ["calendar_event", event("third", "20260904", { title: "Lunch" })],
    ["calendar_event", event("fourth", "20260904", { title: "Woodwork", calendarId: hidden.id })],
  ] as const;
  const server = await prepareMailPage({
    "GET /api/hello": () => json({ product: "ohmail", flavor: "managed", needsSetup: false, features: { calendar: true } }),
    "GET /api/calendar/settings": () => scopedSyncResponse(settings),
    "GET /api/search": () => scopedSyncResponse({ items: [], total: 0, totalExact: true, ms: 4 }),
    ...(enabled ? { "GET /api/sync/snapshot": () => calendarSnapshot(records) } : {}),
    "GET /api/sync": () => scopedSyncResponse({
      changes: {
        creates: records.map(([type, entity], index) => ({
          type, entity, id: entity.id, seq: index + 1, op: "create", updatedAt: ISO,
        })),
        updates: [], moves: [], deletes: [],
      },
      cursor: "c8", hasMore: false, serverTime: ISO,
    }),
  });
  const { container } = await mountMailPage();
  fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));
  await tick(0);
  expect(searchField(container)).toBeTruthy();
  const calendarReads = () => server.sent.filter(({ line, url }) =>
    line.startsWith("GET /api/calendar/") || new URL(url, location.origin).searchParams.get("phase") === "calendar",
  ).length;
  const readsBeforeSearch = calendarReads();

  typeSearch(container, "zzzzzzzz");
  await tick(500);
  expect(screen.queryByRole("button", { name: /\d+ events?$/ })).toBeNull();

  typeSearch(container, "Woodwork");
  await tick(500);
  expect(calendarReads()).toBe(readsBeforeSearch);
  if (!enabled) {
    expect(screen.queryByRole("button", { name: /\d+ events?$/ })).toBeNull();
    return;
  }
  fireEvent.click(screen.getByRole("button", { name: "2 events" }));
  await tick(0);
  expect(location.hash).toBe("#/cal/find?q=Woodwork");
  expect(screen.getByRole("button", { name: /Woodwork/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Workshop/ })).toBeTruthy();
});
