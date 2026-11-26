/** @vitest-environment jsdom */
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CalendarConnectionRecord, CalendarRecord, CalendarSettingsWire } from "@ohmail/wire";
import { ACCOUNT, ISO, MAILBOX, calendarSnapshot, closeMailPage, inboxPage, mountMailPage, prepareMailPage, scopedSyncResponse, tick } from "./fixtures/mounted-mail-page";
import { json } from "./account/account-harness";

const calendarSettings: CalendarSettingsWire = {
  enabledAt: null,
  secondZone: null,
  weekNumbers: false,
  dayFromMinute: null,
  dayToMinute: null,
  newEventsCalendarId: null,
};

const build = vi.hoisted(() => ({ selfHost: false }));
vi.mock("../app/hello", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/hello")>();
  return { ...actual, get SELF_HOST_BUILD() { return build.selfHost; } };
});

afterEach(() => {
  closeMailPage();
  build.selfHost = false;
});

const hello = () => json({
  product: "ohmail", flavor: "managed", needsSetup: false,
  features: { staging: false, ai: false, pairing: false, calendar: true },
});

const calendarSettingsRecord = { id: ACCOUNT, accountId: ACCOUNT, calendarEnabledAt: ISO, updatedAt: ISO };

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

  await vi.waitFor(() => expect(server.on("GET /api/calendar/settings").length).toBeGreaterThan(0));
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

it("opens browser calendar setup with the chosen provider and waits for a press", async () => {
  vi.stubGlobal("innerWidth", 1440);
  const server = await prepareMailPage({
    "GET /api/hello": hello,
    "GET /api/calendar/settings": () => scopedSyncResponse({ ...calendarSettings, enabledAt: ISO }),
    "GET /api/calendar/connect": () => scopedSyncResponse({ ways: ["icloud", "google", "microsoft"], connections: [] }),
    "POST /api/calendar/oauth/microsoft/start": () => json({ error: { code: "oauth_unconfigured" } }, 503),
  });
  history.replaceState(null, "", "#/cal/cal-setup?via=microsoft");
  await mountMailPage();

  const ways = within(screen.getByRole("group", { name: "Ways to connect a calendar" }));
  expect(ways.getAllByRole("button")).toHaveLength(1);
  expect(server.on("POST /api/calendar/oauth/microsoft/start")).toHaveLength(0);
  fireEvent.click(ways.getByRole("button", { name: "Microsoft Outlook" }));
  await tick(0);
  expect(server.on("POST /api/calendar/oauth/microsoft/start")).toHaveLength(1);
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
    "GET /api/sync/snapshot": () => calendarSnapshot([
      ["settings", calendarSettingsRecord], ["calendar_connection", connection], ["calendar", calendar],
    ]),
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

it("creates on the signed-in calendar when the preferences request fails", async () => {
  vi.stubGlobal("innerWidth", 1440);
  const connection: CalendarConnectionRecord = {
    id: "conn", provider: "caldav", label: "Studio", status: "active", errorCode: null,
    grantMailboxId: null, serverHost: null, consentedAt: ISO, lastSyncedAt: ISO, createdAt: ISO, updatedAt: ISO,
  };
  const first: CalendarRecord = {
    id: "work", connectionId: connection.id, name: "Work", color: null, access: "writer", shown: true,
    timeZone: "UTC", window: null, defaultAlarms: [], lastSyncedAt: ISO, errorCode: null, updatedAt: ISO,
  };
  const calendars = [first, { ...first, id: "home", name: "Home" }];
  const server = await prepareMailPage({
    "GET /api/hello": hello,
    "GET /api/calendar/settings": () => new Response(null, { status: 503 }),
    "GET /api/sync/snapshot": () => calendarSnapshot([
      ["settings", calendarSettingsRecord], ["calendar_connection", connection],
      ...calendars.map((calendar) => ["calendar", calendar] as const),
    ]),
    "GET /api/sync": () => scopedSyncResponse({
      changes: {
        creates: [
          { type: "calendar_connection", op: "create", id: connection.id, seq: 1, updatedAt: ISO, entity: connection },
          { type: "settings", op: "create", id: ACCOUNT, seq: 2, updatedAt: ISO,
            entity: { accountId: ACCOUNT, calendarEnabledAt: ISO, updatedAt: ISO } },
          ...calendars.map((entity, index) =>
            ({ type: "calendar", op: "create", id: entity.id, seq: index + 3, updatedAt: ISO, entity })),
        ],
        updates: [], moves: [], deletes: [],
      },
      cursor: "c4", hasMore: false, serverTime: ISO,
    }),
    "POST /api/calendar/writes": () => scopedSyncResponse({ write: null, events: [] }),
  });
  await mountMailPage();
  fireEvent.click(products().getByRole("button", { name: "Calendar" }));
  await tick(0);
  const create = screen.getByRole("button", { name: "New event" });
  fireEvent.click(create);
  const form = within(screen.getByRole("dialog", { name: "New event" }));
  fireEvent.change(form.getByRole("textbox", { name: "New event" }), { target: { value: "Workshop" } });
  const add = form.getByRole<HTMLButtonElement>("button", { name: "Add" });
  expect(add.disabled).toBe(false);
  fireEvent.click(add);
  await tick(250);
  expect(server.on("POST /api/calendar/writes").map(({ body }) => body)).toEqual([
    expect.objectContaining({ kind: "calendar_event_create", calendarId: first.id, event: expect.objectContaining({ title: "Workshop" }) }),
  ]);
  expect(screen.queryByRole("dialog", { name: "New event" })).toBeNull();
});

it("keeps the results at the same scroll offset when returning from Calendar", async () => {
  vi.stubGlobal("innerWidth", 1440);
  const mirror = await inboxPage(18).json();
  const mail = mirror.changes.creates.slice(1).map(({ entity }: { entity: { subject: string } }) => entity);
  const subject = mail[mail.length - 1].subject;
  await prepareMailPage({
    "GET /api/hello": hello,
    "GET /api/search": () => scopedSyncResponse({ items: mail, total: mail.length, totalExact: true, ms: 4 }),
    "GET /api/sync": () => scopedSyncResponse(mirror),
  });
  await mountMailPage();
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  const field = screen.getByRole<HTMLInputElement>("textbox", { name: "Search" });
  fireEvent.change(field, { target: { value: "Subject" } });
  await tick(1000);
  fireEvent.click(screen.getByRole("button", { name: (name) => name.includes(subject) }));
  await tick(0);
  const searchAddress = location.hash;
  const resultsScroller = () => screen.getByRole("list", { name: "Search" }).parentElement!;
  const reading = () => within(screen.getByRole("region", { name: "Reading" }));
  expect(reading().getByRole("heading", { name: subject })).toBeTruthy();
  fireEvent.scroll(resultsScroller(), { target: { scrollTop: 280 } });

  fireEvent.click(products().getByRole("button", { name: "Calendar" }));
  await tick(0);
  expect(screen.queryByRole("list", { name: "Search" })).toBeNull();
  fireEvent.click(products().getByRole("button", { name: "Mail" }));
  await tick(1000);

  expect(location.hash).toBe(searchAddress);
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Search" }).value).toBe("Subject");
  expect(reading().getByRole("heading", { name: subject })).toBeTruthy();
  expect(resultsScroller().scrollTop).toBe(280);

  fireEvent.click(products().getByRole("button", { name: "Calendar" }));
  await tick(0);
  fireEvent.click(products().getByRole("button", { name: "Mail" }));
  await tick(0);
  expect(location.hash).toBe(searchAddress);
  expect(screen.getByText("Searching your whole mailbox…")).toBeTruthy();
  fireEvent.click(products().getByRole("button", { name: "Calendar" }));
  await tick(0);
  fireEvent.click(products().getByRole("button", { name: "Mail" }));
  await tick(1000);

  expect(location.hash).toBe(searchAddress);
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Search" }).value).toBe("Subject");
  expect(reading().getByRole("heading", { name: subject })).toBeTruthy();
  expect(resultsScroller().scrollTop).toBe(280);
});

it("explains unavailable From mail detection on a self-hosted server with dated workshop mail", async () => {
  build.selfHost = true;
  vi.stubGlobal("innerWidth", 1440);
  const connection: CalendarConnectionRecord = {
    id: "work", provider: "caldav", label: "Work", status: "active", errorCode: null,
    grantMailboxId: null, serverHost: null, consentedAt: ISO, lastSyncedAt: ISO, createdAt: ISO, updatedAt: ISO,
  };
  const calendar: CalendarRecord = {
    id: "calendar", connectionId: connection.id, name: "Work", color: null, access: "owner", shown: true,
    timeZone: "UTC", window: null, defaultAlarms: [], lastSyncedAt: ISO, errorCode: null, updatedAt: ISO,
  };
  const dated = "Join us for the glass workshop on Saturday, September 12, 2026 at 3:00 pm.";
  const structured = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Event",
    name: "Glass workshop",
    startDate: new Date(Date.UTC(2026, 8, 12, 15)).toISOString(),
    endDate: new Date(Date.UTC(2026, 8, 12, 17)).toISOString(),
  });
  const body = (html: string | null) => ({
    text: dated, html, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
  });
  const mail = ["plain", "structured"].map((id) => ({
    id, accountId: ACCOUNT, mailboxId: MAILBOX.id, threadId: id, folder: "INBOX",
    subject: id === "plain" ? "Glass workshop" : "Glass workshop confirmation",
    from: { address: "workshops@example.invalid", name: "Workshops" }, to: [], cc: [],
    date: ISO, unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {},
    labels: [], snippet: dated, triage: null, remoteContent: "none", updatedAt: ISO,
  }));
  const records = [
    ["settings", { id: ACCOUNT, accountId: ACCOUNT, calendarEnabledAt: ISO, updatedAt: ISO }],
    ["calendar_connection", connection], ["calendar", calendar], ...mail.map((message) => ["message", message] as const),
  ] as const;
  await prepareMailPage({
    "GET /api/hello": () => json({
      product: "ohmail", flavor: "selfhost", needsSetup: false,
      features: { staging: false, ai: false, pairing: false, calendar: true },
    }),
    "GET /api/calendar/settings": () => scopedSyncResponse({ ...calendarSettings, enabledAt: ISO }),
    "GET /api/search": () => scopedSyncResponse({ items: mail, total: mail.length, totalExact: true, ms: 4 }),
    "GET /api/messages/plain/body": () => scopedSyncResponse(body(null)),
    "GET /api/messages/structured/body": () =>
      scopedSyncResponse(body(`<p>${dated}</p><script type="application/ld+json">${structured}</script>`)),
    "GET /api/sync/snapshot": () => calendarSnapshot(records),
    "GET /api/sync": () => scopedSyncResponse({
      changes: {
        creates: records.map(([type, entity], index) =>
          ({ type, entity, id: entity.id, seq: index + 1, op: "create", updatedAt: ISO })),
        updates: [], moves: [], deletes: [],
      },
      cursor: `c${records.length}`, hasMore: false, serverTime: ISO,
    }),
  });
  await mountMailPage();
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search" }), { target: { value: "workshop" } });
  await tick(1000);
  const hits = within(screen.getByRole("list", { name: "Search" }));
  expect(hits.getAllByRole("button", { name: /Glass workshop/ })).toHaveLength(2);

  fireEvent.click(products().getByRole("button", { name: "Calendar" }));
  await tick(0);
  fireEvent.click(screen.getByRole("button", { name: "From mail" }));
  await tick(0);
  expect(screen.queryByText(/^Nothing found in\b/)).toBeNull();
  expect(screen.getByText(/^Automatic event detection from mail\b/).textContent)
    .toBe("Automatic event detection from mail is unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Add event manually" }));
  await tick(0);
  const form = within(screen.getByRole("dialog", { name: "New event" }));
  expect(form.getByRole("textbox", { name: "New event" })).toBeTruthy();
});

async function openEmptyCalendarOnPhone() {
  vi.stubGlobal("innerWidth", 390);
  await prepareMailPage({
    "GET /api/hello": hello,
    "GET /api/calendar/settings": () => scopedSyncResponse({ ...calendarSettings, unconfigured: true }),
    "GET /api/calendar/connect": () => scopedSyncResponse({ ways: [], connections: [] }),
  });
  history.replaceState(null, "", "#/cal/week");
  await mountMailPage();
}

it("returns to Mail directly from the calendar's first step on a phone", async () => {
  await openEmptyCalendarOnPhone();
  const calendar = within(screen.getByRole("region", { name: "Calendar" }));
  expect(calendar.getByRole("button", { name: "Connect a calendar" })).toBeTruthy();
  fireEvent.click(calendar.getByRole("button", { name: "Mail" }));
  await tick(0);
  expect(location.hash).toBe("#/ohbox");
});

it("returns to Mail from the calendar's More drawer on a phone", async () => {
  await openEmptyCalendarOnPhone();
  fireEvent.click(screen.getByRole("button", { name: /^More$/ }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "More" })).getByRole("button", { name: "Mail" }));
  await tick(0);
  expect(location.hash).toBe("#/ohbox");
});
