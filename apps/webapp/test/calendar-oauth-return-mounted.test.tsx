// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CalendarConnectionRecord, CalendarRecord } from "@ohmail/wire";
import { ACCOUNT, ISO, closeMailPage, mountMailPage, prepareMailPage, scopedSyncResponse } from "./fixtures/mounted-mail-page";
import { json, refusal } from "./account/account-harness";

const setup = "#/cal/cal-setup";
const state = "fixture-state";
const code = "fixture-code";
type Provider = "google" | "microsoft";

beforeEach(() => vi.resetModules());

afterEach(() => {
  closeMailPage();
  history.replaceState(null, "", "/");
});

async function arrive(provider: Provider, locale: "en" | "de" = "en") {
  const hash = `${setup}?${new URLSearchParams({ oauth: "pending", provider, state, code })}`;
  history.replaceState(null, "", `/${hash}`);
  await import("../app/(product)/mailbox/CloudShell");
  // Next captures the landing URL before the shell module runs and commits it during hydration.
  const nextState = { __NA: true };
  const replace = history.replaceState.bind(history);
  replace(nextState, "", `/${hash}`);
  let canonical = location.href;
  const integration = vi.spyOn(history, "replaceState").mockImplementation((data, unused, url) => {
    if (!data?.__NA && url != null) canonical = new URL(url, location.href).href;
    replace({ ...data, ...nextState }, unused, url);
  });
  try {
    await mountMailPage(false, locale);
    expect(canonical).toBe(location.href);
  } finally {
    integration.mockRestore();
  }
}

function connectRoutes() {
  return {
    "GET /api/hello": () => json({ product: "ohmail", flavor: "managed", needsSetup: false, features: { calendar: true } }),
    "GET /api/calendar/settings": () => scopedSyncResponse({ enabledAt: ISO }),
    "GET /api/calendar/connect": () => scopedSyncResponse({ ways: ["google", "microsoft"], connections: [] }),
  };
}

it.each(["google", "microsoft"] as const)("finishes the %s return on the hosted setup screen", async (provider) => {
  const complete = `POST /api/calendar/oauth/${provider}/complete`;
  const connection: CalendarConnectionRecord = {
    id: "connected-fixture", provider, label: "Work", status: "active", errorCode: null,
    grantMailboxId: null, serverHost: null, consentedAt: ISO, lastSyncedAt: ISO, createdAt: ISO, updatedAt: ISO,
  };
  const calendar: CalendarRecord = {
    id: "work", connectionId: connection.id, name: "Work", color: null, access: "writer", shown: true,
    timeZone: "UTC", window: null, defaultAlarms: [], lastSyncedAt: ISO, errorCode: null, updatedAt: ISO,
  };
  const atPost: string[] = [];
  const server = await prepareMailPage({
    ...connectRoutes(),
    [complete]: () => {
      atPost.push(location.hash);
      return scopedSyncResponse({ connectionId: connection.id });
    },
    "GET /api/sync": () => scopedSyncResponse({
      changes: {
        creates: [
          { type: "settings", op: "create", id: ACCOUNT, seq: 1, updatedAt: ISO,
            entity: { accountId: ACCOUNT, calendarEnabledAt: ISO, updatedAt: ISO } },
          { type: "calendar_connection", op: "create", id: connection.id, seq: 2, updatedAt: ISO, entity: connection },
          { type: "calendar", op: "create", id: calendar.id, seq: 3, updatedAt: ISO, entity: calendar },
        ],
        updates: [], moves: [], deletes: [],
      },
      cursor: "c3", hasMore: false, serverTime: ISO,
    }),
  });

  const entries = history.length;
  await arrive(provider);
  expect(server.on(complete)).toHaveLength(1);
  expect(server.on(complete)[0]?.body).toEqual({ state, code });
  expect(atPost).toEqual([`${setup}?oauth=connecting`]);
  expect(history.length).toBe(entries);
  expect(location.hash).toBe(`${setup}?step=calendars&connection=${connection.id}&oauth=connected`);
  const choice = within(screen.getByRole("dialog")).getByRole("group", { name: "Calendars" });
  expect(within(choice).getByRole("switch", { name: "Work", checked: true })).toBeTruthy();

  cleanup();
  await mountMailPage();
  expect(server.on(complete)).toHaveLength(1);
});

it("says why the calendar could not be connected when completion refuses", async () => {
  const complete = "POST /api/calendar/oauth/google/complete";
  const server = await prepareMailPage({
    ...connectRoutes(),
    [complete]: () => refusal(403, "forbidden", { reason: "account_mismatch" }),
  });

  await arrive("google");
  expect(server.on(complete)).toHaveLength(1);
  expect(location.hash).toBe(`${setup}?oauth=account_mismatch`);
  expect(screen.getByText("This calendar sign-in was started by a different ohmail account.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Google Calendar" })).toBeTruthy();
});

it("does not resend the code after a session refusal and explains how to reconnect in German", async () => {
  const complete = "POST /api/calendar/oauth/microsoft/complete";
  const server = await prepareMailPage({
    ...connectRoutes(),
    [complete]: () => refusal(403, "csrf_failed"),
  });

  await arrive("microsoft", "de");
  expect(server.on(complete)).toHaveLength(1);
  expect(location.hash).toBe(`${setup}?oauth=session_expired`);
  expect(screen.getByText("Deine ohmail-Sitzung ist abgelaufen. Melde dich erneut an und verbinde dann deinen Kalender."))
    .toBeTruthy();
});
