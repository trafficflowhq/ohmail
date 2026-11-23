/** @vitest-environment jsdom */
import { fireEvent, waitFor, within } from "@testing-library/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AheadSet } from "@ohmail/client-engine";
import type { CalendarWay } from "@ohmail/app-logic/calendar/setup";
import { pressAndHear, type CalendarAct, type CalendarPort } from "@ohmail/app-logic/calendar";
import { CALENDAR_NOTICES_KEY } from "@ohmail/app-logic/notices/browser-channels";
import { NONE } from "@ohmail/app/host";
import { letter } from "../../../packages/app/test/reader/support/fake-mail.js";
import { calendarOf, connection, event } from "../../../packages/app-logic/test/calendar/invitations/fixtures.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import { DesktopGate, LIFECYCLE_POLL_MS } from "../src/DesktopGate.js";
import { DesktopLocale } from "../src/DesktopLocale.js";
import { DOOR_COPY } from "../src/door-copy.js";
import { profileImportPath } from "../src/local-profile-import.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Match the desktop bundle's intl alias so the shared hooks see DesktopLocale's provider.
vi.mock("next-intl", async () => vi.importActual("use-intl"));

let drawnCalendar: CalendarPort | typeof NONE = NONE;
vi.mock("@ohmail/app/frame", async () => {
  const actual = await vi.importActual<typeof import("@ohmail/app/frame")>("@ohmail/app/frame");
  return {
    ...actual,
    Frame: (props: Parameters<typeof actual.Frame>[0]) => {
      drawnCalendar = props.host.wires.calendar;
      return <actual.Frame {...props} />;
    },
  };
});

const MB = { id: "6e0a4c1e-0000-4000-8000-000000000001", address: "mailbox@example.invalid" };
const FINGERPRINT = "b".repeat(64);
const STANDALONE: EngineStatus = {
  state: "serving", mode: "local", address: MB.address, mailboxId: MB.id, credentialState: "ready",
};
const words = {
  title: "We found your ohmail settings on this mailbox",
  signatureReplacingPart: "your signature, replacing the one on this mailbox now",
  import: "Import settings",
  doneTitle: "Your settings are back.",
  doneAction: "Done",
  later: "Not now",
};
const FOUND = {
  state: "found", fingerprint: FINGERPRINT, updatedAt: "2026-08-10T09:00:00.000Z",
  producer: { kind: "cloud", version: "1" },
  counts: { screener: 1, rules: 2, notifyRules: 0, tags: 1, awayResponder: false },
};
const RECEIPT = { imported: FOUND.counts, skippedRules: 0, seq: 7 };
const CONNECTED = "2026-08-10T09:00:00.000Z";
const EMPTY_CHANGES = { creates: [], updates: [], moves: [], deletes: [] };

interface RegisteredDoor {
  status?: EngineStatus;
  candidate?: () => Promise<Record<string, unknown>>;
  defaultMail?: "not-default";
  calendarSnapshot?: unknown;
  calendarSetup?: { enabled: boolean; ways: CalendarWay[] };
  browserPlaces?: RequestBody[];
  alerts?: AheadSet[];
  openings?: Array<(value: unknown) => void>;
  calendarRequests?: Array<number | undefined>;
  calendarWrites?: Array<{ url: string; body: unknown; key: string | undefined; session: number | undefined }>;
}
interface RequestBody {
  key?: string;
  set?: AheadSet;
  event?: string;
  handler?: number;
  expectedCalendarSession?: number;
  method?: string;
  url?: string;
  body?: number[];
  headers?: Array<[string, string]>;
}
const host = globalThis as unknown as {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, request?: RequestBody) => Promise<unknown>;
    transformCallback: (callback: (value: unknown) => void) => number;
  };
};
let root: Root | null;
let hostEl: HTMLDivElement;
let candidate: Record<string, unknown>;
let asked: Array<{ method: string; url: string; body: unknown }>;

/** One encoded reply from the synthetic native engine, in the desktop bridge's actual format. */
function encode(status: number, data: unknown): Uint8Array {
  const encoder = new TextEncoder();
  const meta = encoder.encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = encoder.encode(JSON.stringify(data));
  const result = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(result.buffer).setUint32(0, meta.byteLength, false);
  result.set(meta, 4);
  result.set(payload, 4 + meta.byteLength);
  return result;
}

async function answer(door: RegisteredDoor, method: string, url: string): Promise<Uint8Array> {
  const profile = profileImportPath(MB.id);
  if (method === "GET" && url === profile) return encode(200, await (door.candidate?.() ?? candidate));
  if (method === "POST" && url === profile) return encode(200, RECEIPT);
  if (method === "POST" && url === `${profile}/decline`) return encode(200, { dismissed: true });
  if (url === "/health") return encode(200, { signedIn: true });
  if (url === "/auth/session" && door.status?.accountId) {
    return encode(200, { user: { accountId: door.status.accountId }, scope: "full" });
  }
  if (/^\/mailboxes(?:\?|$)/.test(url)) {
    return encode(200, { items: [{
      ...MB, status: "connected", lastSyncAt: CONNECTED, initialImportCompletedAt: CONNECTED,
      organizeConsentedAt: CONNECTED,
    }] });
  }
  if (url.startsWith("/sync/snapshot")) {
    return encode(200, door.calendarSnapshot ?? { asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } });
  }
  if (url.startsWith("/sync")) {
    return encode(200, { changes: EMPTY_CHANGES, cursor: "MA", hasMore: false, serverTime: CONNECTED });
  }
  if (url === "/calendar/settings" && (door.calendarSnapshot || door.calendarSetup)) return encode(200, {
    ...(door.calendarSetup?.enabled === false ? { enabledAt: null, unconfigured: true } : { enabledAt: CONNECTED }),
    secondZone: null, weekNumbers: false, dayFromMinute: null, dayToMinute: null, newEventsCalendarId: null,
  });
  if (url === "/calendar/connect" && door.calendarSetup) return encode(200, {
    ways: door.calendarSetup.enabled ? door.calendarSetup.ways : [], connections: [],
  });
  if (url === "/calendar/connections" && method === "POST" && door.calendarSetup) {
    return encode(202, connection());
  }
  if (door.calendarWrites && method === "POST") {
    if (url === "/calendar/writes") return encode(200, { write: null, events: [] });
    if (url === "/calendar/proposals") return encode(200, { status: "sent" });
    if (url.startsWith("/local/window/outbox?")) return encode(200, {});
  }
  if (url.startsWith("/consent")) return encode(200, { seedConfirmedAt: CONNECTED });
  return encode(404, { error: { code: "not_found" } });
}

async function mountRegisteredWindow(door: RegisteredDoor = {}): Promise<void> {
  const callbacks: Array<(value: unknown) => void> = [];
  host.__TAURI_INTERNALS__ = {
    transformCallback: (callback) => callbacks.push(callback),
    invoke: async (command, request) => {
      if (command === "engine_status") return door.status ?? STANDALONE;
      if (command === "default_mail_status") return { state: door.defaultMail ?? "unknown" };
      if (command === "plugin:event|listen" && request?.event === "notice:open" && request.handler) {
        door.openings?.push(callbacks[request.handler - 1]!);
        return request.handler;
      }
      if (command === "alerts_set" && request?.set) {
        door.alerts?.push(request.set);
        return request.set.alerts.map(({ id }) => id);
      }
      if (command === "open_link" && request?.key) door.browserPlaces?.push(request);
      if (command !== "engine_request") return null;
      const method = (request?.method ?? "GET").toUpperCase();
      const url = request?.url ?? "";
      if (url.startsWith("/calendar/")) door.calendarRequests?.push(request?.expectedCalendarSession);
      const raw = request?.body?.length ? new TextDecoder().decode(Uint8Array.from(request.body)) : "";
      const body = raw ? JSON.parse(raw) : null;
      asked.push({ method, url, body });
      if (url === "/calendar/settings" && method === "PATCH" && door.calendarSetup) {
        door.calendarSetup.enabled = body.enabled;
      }
      if (method === "POST" && url.startsWith("/calendar/")) {
        door.calendarWrites?.push({
          url, body, key: Object.fromEntries(request?.headers ?? [])["idempotency-key"], session: request?.expectedCalendarSession,
        });
      }
      return answer(door, method, url);
    },
  };
  window.location.hash = "#/ohbox";
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => root!.render(<DesktopLocale><DesktopGate /></DesktopLocale>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
}

const profileTraffic = (verb: "GET" | "POST") =>
  asked.filter(({ method, url }) => method === verb && url.startsWith(profileImportPath(MB.id)));
const card = () => hostEl.querySelector<HTMLElement>(".ob-list .pfi-card");
const button = (label: string): HTMLButtonElement => {
  const found = [...(card()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === label);
  if (!found) throw new Error(`The offer has no ${label} control`);
  return found;
};
const click = (element: HTMLElement) => act(async () => element.click());

beforeEach(() => {
  root = null;
  drawnCalendar = NONE;
  asked = [];
  candidate = FOUND;
  localStorage.clear();
  vi.stubGlobal("fetch", async () => { throw new Error("The desktop profile opened a network socket"); });
  window.matchMedia ??= ((media: string) => ({
    matches: false, media, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => false,
  }));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  hostEl?.remove();
  delete host.__TAURI_INTERNALS__;
  window.location.hash = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("offers the connected mailbox's verified settings in the actual desktop mail frame", async () => {
  await mountRegisteredWindow();
  expect(hostEl.querySelector(".fr-frame"), "the native gate should open the actual registered app").not.toBeNull();
  expect(asked.some(({ method, url }) => method === "GET" && /^\/mailboxes(?:\?|$)/.test(url)), "the frame should read its mailbox roster").toBe(true);
  expect(profileTraffic("GET")).toEqual([{ method: "GET", url: profileImportPath(MB.id), body: null }]);
  expect(hostEl.querySelector(".ob-list .pfi-card")?.textContent).toContain(words.title);
  expect(profileTraffic("POST")).toEqual([]);
});

it("the desktop applies the reviewed copy only after the press and shows its receipt", async () => {
  const signatureReplaces = "7".repeat(32);
  candidate = { ...candidate, counts: { ...(candidate.counts as object), signature: true, signatureReplaces } };
  await mountRegisteredWindow();
  expect(card()?.textContent).toContain(words.signatureReplacingPart);
  expect(profileTraffic("POST")).toEqual([]);
  const apply = button(words.import);
  await act(async () => { apply.click(); apply.click(); });
  expect(profileTraffic("POST")).toEqual([
    { method: "POST", url: profileImportPath(MB.id), body: { fingerprint: FINGERPRINT, signatureReplaces } },
  ]);
  expect(card()?.textContent).toContain(words.doneTitle);
  await click(button(words.doneAction));
  expect(card()).toBeNull();
});

it("a prior native account's delayed answer cannot replace the verified current offer", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const previous = Promise.withResolvers<Record<string, unknown>>();
  const oldCandidate = candidate;
  const owner = { ...STANDALONE, localDoorVersion: 1 };
  const replacement = { ...STANDALONE, localDoorVersion: 2 };
  const next = { ...candidate, fingerprint: "d".repeat(64) };
  const door: RegisteredDoor = { status: owner, candidate: () => previous.promise };
  await mountRegisteredWindow(door);
  expect(profileTraffic("GET")).toHaveLength(1);
  expect(card()).toBeNull();
  door.status = replacement;
  door.candidate = async () => next;
  await act(async () => { await vi.advanceTimersByTimeAsync(LIFECYCLE_POLL_MS + 250); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
  expect(profileTraffic("GET")).toHaveLength(2);
  expect(card()?.textContent).toContain(words.title);
  await act(async () => previous.resolve(oldCandidate));
  await click(button(words.later));
  expect(profileTraffic("POST")).toEqual([
    { method: "POST", url: `${profileImportPath(MB.id)}/decline`, body: { fingerprint: next.fingerprint } },
  ]);
  expect(card()).toBeNull();
});

it("the native profile offer takes the stage before the default-mail ask", async () => {
  const pending = Promise.withResolvers<Record<string, unknown>>();
  await mountRegisteredWindow({ defaultMail: "not-default", candidate: () => pending.promise });
  expect(hostEl.textContent).toContain(DOOR_COPY.mailtoAskTitle);
  await act(async () => pending.resolve(candidate));
  expect(hostEl.querySelector(".ob-list .pfi-card")?.textContent).toContain(words.title);
  expect(hostEl.textContent).not.toContain(DOOR_COPY.mailtoAskTitle);
  const later = [...card()!.querySelectorAll("button")].find((b) => b.textContent === words.later);
  expect(later).toBeDefined();
  await click(later!);
  expect(card()).toBeNull();
  expect(hostEl.textContent).toContain(DOOR_COPY.mailtoAskTitle);
});


it("schedules a mirrored calendar reminder from the native mail frame and withdraws it when notices are turned off", async () => {
  const now = new Date("2026-11-16T06:00:00Z");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  localStorage.setItem(`${CALENDAR_NOTICES_KEY}.${MB.id}`, JSON.stringify({ cal_alert: true, showTitles: false }));
  const calendar = calendarOf();
  const reminder = event("appointment", "20261116", {
    alarms: [{ method: "notice", minutesBefore: 10 }],
    startsAt: "2026-11-16T08:00:00Z",
    endsAt: "2026-11-16T08:30:00Z",
  });
  const change = (type: string, id: string, entity: unknown) => ({
    type, id, entity, op: "create", seq: 1, updatedAt: CONNECTED,
  });
  const alerts: AheadSet[] = [];
  const calendarRequests: Array<number | undefined> = [];
  const openings: Array<(value: unknown) => void> = [];
  await mountRegisteredWindow({
    status: { ...STANDALONE, mode: "cloud", flavor: "selfhost", accountId: MB.id, noticeDocument: 1, noticeSession: 2 },
    calendarSnapshot: {
      asOfSeq: 1,
      changes: [
        change("settings", MB.id, { accountId: MB.id, calendarEnabledAt: CONNECTED, updatedAt: CONNECTED }),
        change("calendar_connection", connection().id, connection()),
        change("calendar", calendar.id, calendar),
        change("calendar_event", reminder.id, reminder),
      ],
      nextCursor: null,
      window: { days: 90, minRows: 500 },
      calendarWindow: { daysBack: 366, daysAhead: 731, maxRows: 10_000 },
    },
    alerts,
    openings,
    calendarRequests,
  });
  expect(drawnCalendar).toMatchObject({ setup: { connect: expect.any(Function), ways: expect.any(Function) } });
  expect(drawnCalendar === NONE ? undefined : drawnCalendar.setup?.startOAuth).toBeUndefined();
  expect(alerts.filter(({ alerts: entries }) => entries.length > 0)).toEqual([
    {
      scope: MB.id,
      alerts: [expect.objectContaining({
        eventId: reminder.id, atMs: Date.parse("2026-11-16T07:50:00Z"), label: { as: "event" },
      })],
    },
  ]);
  expect(within(hostEl).queryByRole("button", { name: /^(calendar|ohcal)$/i })).toBeNull();
  await act(async () => { window.location.hash = "#/cal/week/2026-11-16/e/appointment"; });
  await waitFor(() => expect(window.location.hash).toBe("#/ohbox"));
  expect(within(hostEl).queryByRole("heading", { name: "appointment" })).toBeNull();
  await act(async () => { window.location.hash = "#/settings/notifications"; });
  const master = await within(hostEl).findByRole("switch", { name: "Notify me on this device" });
  const reminderSwitch = within(hostEl).getByRole("switch", { name: "An alert" });
  const titles = within(hostEl).getByRole("switch", { name: "Show titles in notifications" });
  expect(reminderSwitch.getAttribute("aria-checked")).toBe("true");
  expect(titles.getAttribute("aria-checked")).toBe("false");
  await click(reminderSwitch);
  expect(alerts.at(-1)).toEqual({ scope: MB.id, alerts: [] });
  expect(JSON.parse(localStorage.getItem(`${CALENDAR_NOTICES_KEY}.${MB.id}`)!)).toEqual({ cal_alert: false, showTitles: false });
  await click(reminderSwitch);
  expect(alerts.at(-1)?.alerts).toHaveLength(1);
  expect(master.getAttribute("aria-checked")).toBe("true");
  await click(master);
  expect(alerts.at(-1)).toEqual({ scope: MB.id, alerts: [] });
  const opening = { scope: MB.id, document: 1, session: 2, event: reminder.id, startMs: Date.parse("2026-11-16T08:00:00Z") };
  await act(async () => openings[0]!({ payload: { ...opening, session: 1 } }));
  expect(window.location.hash).toBe("#/settings/notifications");
  await act(async () => openings[0]!({ payload: opening }));
  expect(window.location.hash).toBe("#/cal/week/2026-11-16/e/appointment");
  expect(await within(hostEl).findByRole("heading", { name: "appointment" })).toBeTruthy();
  expect(within(hostEl).queryByRole("button", { name: /^(new event|edit event|edit)$/i })).toBeNull();
  expect(within(hostEl).queryByRole("button", { name: /^(calendar|ohcal)$/i })).toBeNull();
  expect(calendarRequests).not.toHaveLength(0);
  expect(calendarRequests.every((session) => session === 2)).toBe(true);
  await click(within(hostEl).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(window.location.hash).toBe("#/ohbox"));
  await act(async () => { window.location.hash = "#/cal/week/2026-11-16/e/appointment"; });
  await waitFor(() => expect(window.location.hash).toBe("#/ohbox"));
});

const managedCalendar: EngineStatus = {
  ...STANDALONE, mode: "cloud", flavor: "managed", cloudUrl: "https://api.example.invalid",
  accountId: MB.id, noticeDocument: 1, noticeSession: 2,
};

it("connects an iCloud calendar from empty desktop settings before Calendar is configured", async () => {
  vi.stubGlobal("innerWidth", 1440);
  const calendarRequests: Array<number | undefined> = [];
  const calendarWrites: NonNullable<RegisteredDoor["calendarWrites"]> = [];
  await mountRegisteredWindow({
    status: managedCalendar,
    calendarSetup: { enabled: false, ways: ["icloud", "caldav", "ics"] },
    calendarRequests,
    calendarWrites,
  });
  const desktop = within(hostEl);
  await click(await desktop.findByRole("button", { name: "Calendar" }));
  const firstStep = within(await desktop.findByRole("region", { name: "Calendar" }));
  await click(firstStep.getByRole("button", { name: "Connect a calendar" }));
  expect(window.location.hash).toBe("#/cal/calendars/calaccounts");
  await click(desktop.getByRole("button", { name: "Add a calendar account" }));
  const ways = within(await desktop.findByRole("group", { name: "Ways to connect a calendar" }));
  expect(ways.getAllByRole("button")).toHaveLength(3);
  expect(ways.getByRole("button", { name: "Another CalDAV server" })).toBeTruthy();
  expect(ways.getByRole("button", { name: "A subscription" })).toBeTruthy();
  expect(asked.filter(({ method, url }) => method === "PATCH" && url === "/calendar/settings"))
    .toEqual([{ method: "PATCH", url: "/calendar/settings", body: { enabled: true } }]);
  await click(ways.getByRole("button", { name: "iCloud" }));
  fireEvent.change(desktop.getByLabelText("Apple Account email address"), { target: { value: MB.address } });
  fireEvent.change(desktop.getByLabelText("App-specific password"), { target: { value: ["fixture", "apple"].join("-") } });
  await click(desktop.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(calendarWrites).toHaveLength(1));
  expect(calendarWrites[0]).toMatchObject({
    url: "/calendar/connections", session: 2, key: expect.any(String), body: { way: "icloud" },
  });
  expect(calendarRequests.every((session) => session === 2)).toBe(true);
});

it("offers configured calendar OAuth providers from the enabled account's first step", async () => {
  vi.stubGlobal("innerWidth", 1440);
  const browserPlaces: RequestBody[] = [];
  await mountRegisteredWindow({
    status: managedCalendar,
    calendarSetup: { enabled: true, ways: ["icloud", "caldav", "ics", "google", "microsoft"] },
    browserPlaces,
  });
  const desktop = within(hostEl);
  await click(await desktop.findByRole("button", { name: "Calendar" }));
  const firstStep = within(await desktop.findByRole("region", { name: "Calendar" }));
  await click(await firstStep.findByRole("button", { name: "Connect a calendar" }));
  await click(await desktop.findByRole("button", { name: "Add a calendar account" }));
  const ways = within(await desktop.findByRole("group", { name: "Ways to connect a calendar" }));
  await click(ways.getByRole("button", { name: "Google Calendar (opens in browser)" }));
  await click(ways.getByRole("button", { name: "Microsoft Outlook (opens in browser)" }));
  expect(browserPlaces).toEqual(["server-calendar-google", "server-calendar-microsoft"].map((key) => ({
    key, expectedServer: managedCalendar.cloudUrl, expectedAccount: MB.id,
  })));
  expect(asked.some(({ method, url }) => method === "PATCH" && url === "/calendar/settings")).toBe(false);
});

it("creates, edits, moves, deletes, answers and proposes times on the hosted ohmail account", async () => {
  const calendar = calendarOf();
  const calendarWrites: NonNullable<RegisteredDoor["calendarWrites"]> = [];
  await mountRegisteredWindow({
    status: { ...STANDALONE, mode: "cloud", flavor: "managed", accountId: MB.id, noticeDocument: 1, noticeSession: 2 },
    calendarSnapshot: {
      asOfSeq: 1,
      changes: [
        { type: "settings", id: MB.id, entity: { calendarEnabledAt: CONNECTED }, op: "create", seq: 1, updatedAt: CONNECTED },
        { type: "calendar_connection", id: connection().id, entity: connection(), op: "create", seq: 1, updatedAt: CONNECTED },
        { type: "calendar", id: calendar.id, entity: calendar, op: "create", seq: 1, updatedAt: CONNECTED },
      ],
      nextCursor: null,
      window: { days: 90, minRows: 500 },
      calendarWindow: { daysBack: 366, daysAhead: 731, maxRows: 10_000 },
    },
    calendarWrites,
  });
  const desktop = within(hostEl);
  await click(await desktop.findByRole("button", { name: /^(calendar|ohcal)$/i }));
  await click(await desktop.findByRole("button", { name: "New event" }));
  const form = within(await desktop.findByRole("dialog", { name: "New event" }));
  const port = drawnCalendar;
  if (port === NONE) throw new Error("The signed-in account has no calendar");
  await act(async () => {
    fireEvent.change(form.getByRole("textbox", { name: "New event" }), { target: { value: "Lunch" } });
  });
  await click(form.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(calendarWrites).toHaveLength(1));
  const create = calendarWrites[0]!;
  expect(create).toMatchObject({
    url: "/calendar/writes", session: 2, key: expect.any(String),
    body: { kind: "calendar_event_create", eventId: expect.any(String), event: { title: "Lunch" } },
  });
  const eventId = (create.body as { eventId: string }).eventId;
  const base = CONNECTED;
  const scope = { kind: "record" } as const;
  const edit: CalendarAct = { kind: "calendar_event_update", eventId, base, scope, change: { title: "Team lunch" } };
  const acts: CalendarAct[] = [
    edit,
    { kind: "calendar_event_move", eventId, base, toCalendarId: "work" },
    { kind: "calendar_event_delete", eventId, base, scope },
    { kind: "calendar_event_answer", eventId: "invitation", base, scope, answer: "accepted" },
  ];
  for (const action of acts) {
    await act(async () => {
      const { key, verdict } = await pressAndHear(port, action);
      expect(verdict).toMatchObject({ kind: "taken" });
      expect(calendarWrites.at(-1)).toMatchObject({ url: "/calendar/writes", session: 2, key, body: action });
    });
  }

  const holdProposal = port.holdProposal;
  if (!holdProposal) throw new Error("The signed-in calendar cannot propose a time");
  const proposal = {
    kind: "calendar_event_propose", recordId: "invitation", base, occurrence: "",
    start: { kind: "date", value: "20261123" }, end: { kind: "date", value: "20261124" },
  } as const;
  await act(async () => {
    const { key } = await holdProposal(proposal, 0);
    await port.flush();
    expect(port.verdict(key)).toMatchObject({ kind: "taken" });
    expect(calendarWrites.at(-1)).toEqual({ url: "/calendar/proposals", session: 2, key, body: proposal });
  });
  expect(calendarWrites).toHaveLength(acts.length + 2);
  await act(async () => root!.unmount());
  root = null;
  await expect(port.press(edit)).rejects.toThrow();
});

it("opens the second occurrence of a weekly reminder", async () => {
  const calendar = calendarOf();
  const reminder = event("weekly", "20261116", {
    start: { kind: "instant", value: "20261116T080000Z" },
    end: { kind: "instant", value: "20261116T083000Z" },
    repeat: { rules: ["FREQ=WEEKLY;COUNT=4"], excluded: [], added: [] },
  });
  const change = (type: string, id: string, entity: unknown) => ({
    type, id, entity, op: "create", seq: 1, updatedAt: CONNECTED,
  });
  const openings: Array<(value: unknown) => void> = [];
  await mountRegisteredWindow({
    status: { ...STANDALONE, mode: "cloud", flavor: "selfhost", accountId: MB.id, noticeDocument: 1, noticeSession: 2 },
    calendarSnapshot: {
      asOfSeq: 1,
      changes: [
        change("settings", MB.id, { accountId: MB.id, calendarEnabledAt: CONNECTED, updatedAt: CONNECTED }),
        change("calendar_connection", connection().id, connection()),
        change("calendar", calendar.id, calendar),
        change("calendar_event", reminder.id, reminder),
      ],
      nextCursor: null,
      window: { days: 90, minRows: 500 },
      calendarWindow: { daysBack: 366, daysAhead: 731, maxRows: 10_000 },
    },
    openings,
  });
  const second = Date.parse("2026-11-23T08:00:00Z");
  await act(async () => openings[0]!({ payload: { scope: MB.id, document: 1, session: 2, event: reminder.id, startMs: second } }));
  await waitFor(() => expect(window.location.hash).toBe(`#/cal/week/2026-11-23/e/weekly%40${second}`));
  expect(await within(hostEl).findByRole("heading", { name: "weekly" })).toBeTruthy();
});

it("opens a native mail notification only in the matching mounted session", async () => {
  const message = letter("arrived", { mailboxId: MB.id });
  const openings: Array<(value: unknown) => void> = [];
  await mountRegisteredWindow({
    status: { ...STANDALONE, noticeDocument: 1, noticeSession: 2 },
    calendarSnapshot: {
      asOfSeq: 1,
      changes: [{ type: "message", id: message.id, entity: message, op: "create", seq: 1, updatedAt: CONNECTED }],
      nextCursor: null,
      window: { days: 90, minRows: 500 },
    },
    openings,
  });
  expect(openings).toHaveLength(1);
  const target = { scope: MB.id, document: 1, session: 2, letter: message.id };
  await act(async () => { window.location.hash = "#/settings/notifications"; });
  await act(async () => openings[0]!({ payload: { ...target, session: 1 } }));
  expect(window.location.hash).toBe("#/settings/notifications");
  await act(async () => openings[0]!({ payload: target }));
  expect(window.location.hash).toBe("#/ohbox/m/arrived");
});
