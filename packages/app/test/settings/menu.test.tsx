/** @vitest-environment jsdom */
/**
 * THE HEADS OF THE SETTINGS MENU: the "Settings" head and the "Mail" head end in the same dot as the menu's
 * own rows: it is hot when Notifications is blocked — the flag the notifications row already wears — and
 * stays ink when nothing stands open.
 */
import { ThemeProvider } from "@ohmail/ui/theme";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, renderHook, screen, within } from "@testing-library/react";
import { PANE_IDS, type SettingsPane } from "../../src/settings/contract.js";
import { paneOf } from "../../src/settings/facts.js";
import { NotificationsContext, useNotificationSummary } from "../../src/settings/notifications/summary.js";
import type { NotificationsModel } from "../../src/settings/notifications/model.js";
import { SettingsMenu } from "../../src/settings/SettingsMenu.js";
import { mailboxesPane } from "../../src/mailboxes/pane/pane.js";
import { NONE } from "../../src/host/index.js";
import { ScreenerAboveContext, type ScreenerAboveValue } from "../../src/screener/contract.js";
import { ConsentContext, type ConsentRow } from "@ohmail/app-logic/consent";
import { MailStateContext, type MailStateBinding } from "@ohmail/app-logic/mail-state";
import { mailPanes, NO_PANE_PARTS } from "../../src/mail/panes.js";
import { EngineContext, type EngineBinding } from "@ohmail/app-logic/engine/context";
import { storagePane } from "../../src/account/storage/pane.js";
import { fakeStorageDoor, someFigures } from "../account/storage/fake-door.js";
import { FrameContext, type FrameInner } from "../../src/frame/commands.js";
import { accountPane } from "../../src/account/account/pane.js";
import type { AccountDoor } from "../../src/account/account/model.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import settingsEn from "../../messages/settings.en.json" with { type: "json" };
import notifyEn from "../../messages/settings-notifications.en.json" with { type: "json" };
import menuEn from "../../messages/settings-menu.en.json" with { type: "json" };
import settingsDe from "../../messages/settings.de.json" with { type: "json" };
import notifyDe from "../../messages/settings-notifications.de.json" with { type: "json" };
import menuDe from "../../messages/settings-menu.de.json" with { type: "json" };

const WORDS: Messages = {
  settings: settingsEn.settings,
  settingsNotifications: notifyEn.settingsNotifications,
  settingsMenu: menuEn.settingsMenu,
};

it("draws no summary when a section has no data", () => {
  render(
    <TextProvider locale="en" messages={WORDS}>
      <SettingsMenu menu={[paneOf("ai", { Body: () => null })]} current={null} go={() => {}} />
    </TextProvider>,
  );
  const row = screen.getByRole("button", { name: "AI" });
  expect(row.textContent).toBe("AI");
  expect(row.getAttribute("aria-describedby")).toBeNull();
});

/** Every section of the contract stands in the menu; the device's answer comes from the mounted model alone. */
const MENU: readonly SettingsPane[] = PANE_IDS.map((id) => paneOf(id, { Body: () => null }));

const modelOf = (permission: "denied" | "granted"): NotificationsModel => ({
  channels: { master: true, ohbox: true, screener: true, scheduled: true, pairing: true },
  permission,
  live: true,
  carries: ["ohbox", "screener", "scheduled", "pairing"],
  osHolds: false,
  delivery: null,
  pressMaster: () => {},
  set: () => {},
});

function mount(permission: "denied" | "granted") {
  render(
    <TextProvider locale="en" messages={WORDS}>
      <NotificationsContext.Provider value={modelOf(permission)}>
        <SettingsMenu menu={MENU} current={null} go={() => {}} />
      </NotificationsContext.Provider>
    </TextProvider>,
  );
}

/** The full stop a head ends in: found through the head's role and name, never through a class of its own. */
const dotKind = (head: string) =>
  screen.getByRole("heading", { name: head }).querySelector("[data-kind]")?.getAttribute("data-kind");

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the dots in the Settings menu heads", () => {
  it("the Settings head and the Mail head wear the hot dot when Notifications is blocked", () => {
    mount("denied");
    expect(dotKind("Settings")).toBe("hot");
    expect(dotKind("Mail")).toBe("hot");
  });

  it("the heads keep the ink dot when nothing needs attention", () => {
    mount("granted");
    expect(dotKind("Settings")).toBe("ink");
    expect(dotKind("Mail")).toBe("ink");
  });
});

it("summarizes this device's enabled notification channels", () => {
  const model = {
    ...modelOf("granted"),
    carries: ["ohbox", "screener", "scheduled", "pairing"] as NotificationsModel["carries"],
  };
  const { result } = renderHook(() => useNotificationSummary(), {
    wrapper: ({ children }) => (
      <TextProvider locale="en" messages={WORDS}>
        <NotificationsContext.Provider value={model}>{children}</NotificationsContext.Provider>
      </TextProvider>
    ),
  });
  expect(result.current).toEqual({ value: "On", detail: "Ohbox · Screener · Scheduled · Devices" });
});

it("summarizes the notifications enabled on this device", () => {
  mount("granted");
  const row = screen.getByRole("button", { name: "Notifications" });
  expect(within(row).getByText("On")).toBeTruthy();
  expect(within(row).getByText("Ohbox · Screener · Scheduled · Devices")).toBeTruthy();
});

it("summarizes only enabled notifications in German", () => {
  const model = modelOf("granted");
  render(
    <TextProvider
      locale="de"
      messages={{
        settings: settingsDe.settings,
        settingsNotifications: notifyDe.settingsNotifications,
        settingsMenu: menuDe.settingsMenu,
      }}
    >
      <NotificationsContext.Provider
        value={{ ...model, channels: { ...model.channels, screener: false, pairing: false } }}
      >
        <SettingsMenu menu={MENU} current={null} phone go={() => {}} />
      </NotificationsContext.Provider>
    </TextProvider>,
  );
  const row = screen.getByRole("button", { name: "Benachrichtigungen" });
  expect(within(row).getByText("An")).toBeTruthy();
  expect(within(row).getByText("Ohbox · Geplant")).toBeTruthy();
});

it("includes enabled calendar notifications from this device", () => {
  const model = modelOf("granted");
  const calendarChoices = {
    cal_alert: true,
    cal_invitation: true,
    cal_change: false,
    cal_answer: false,
    cal_found: false,
  };
  render(
    <TextProvider locale="en" messages={WORDS}>
      <NotificationsContext.Provider
        value={{
          ...model,
          carries: [...model.carries, "cal_alert", "cal_invitation", "cal_change"],
          calendarChoices,
        }}
      >
        <SettingsMenu menu={[paneOf("notifications", { Body: () => null })]} current={null} go={() => {}} />
      </NotificationsContext.Provider>
    </TextProvider>,
  );
  const row = screen.getByRole("button", { name: "Notifications" });
  expect(row.textContent).toContain("Alerts · Invitations");
  expect(row.textContent).not.toContain("Changes");
});

it("shows connected mailbox names and calls attention to a full mailbox", () => {
  const pane = paneOf(
    "mailboxes",
    mailboxesPane({
      factor: NONE,
      calendar: NONE,
      mailState: () => ({
        state: { key: "blocked" },
        refresh: () => {},
        mailboxes: [
          { status: "connected", displayName: "Work", syncBlockedReason: null },
          { status: "connected", displayName: "Personal", syncBlockedReason: "mailbox_full" },
        ],
      }),
    }),
  );
  render(
    <TextProvider locale="en" messages={WORDS}>
      <SettingsMenu menu={[pane]} current={null} go={() => {}} />
    </TextProvider>,
  );
  const row = screen.getByRole("button", { name: "Mailboxes" });
  expect(within(row).getByText("2")).toBeTruthy();
  expect(within(row).getByText("Full")).toBeTruthy();
  expect(within(row).getByText("Work · Personal")).toBeTruthy();
});

it("names a full mailbox in German", () => {
  const pane = paneOf(
    "mailboxes",
    mailboxesPane({
      factor: NONE,
      calendar: NONE,
      mailState: () => ({
        state: { key: "blocked" },
        refresh: () => {},
        mailboxes: [{ status: "connected", displayName: "Arbeit", syncBlockedReason: "mailbox_full" }],
      }),
    }),
  );
  render(
    <TextProvider
      locale="de"
      messages={{
        settings: settingsDe.settings,
        settingsNotifications: notifyDe.settingsNotifications,
        settingsMenu: menuDe.settingsMenu,
      }}
    >
      <SettingsMenu menu={[pane]} current={null} phone go={() => {}} />
    </TextProvider>,
  );
  const row = screen.getByRole("button", { name: "Postfächer" });
  expect(within(row).getByText("Voll")).toBeTruthy();
  expect(within(row).getByText("Arbeit")).toBeTruthy();
});

it("shows the settled Screener counts in the menu", () => {
  const value = {
    model: { queueSettled: true, waitingCount: 2, screenedOut: [{}, {}, {}], spam: [{}] },
    beside: { facts: { owed: false }, junk: NONE },
  } as unknown as ScreenerAboveValue;
  render(
    <TextProvider locale="en" messages={WORDS}>
      <ScreenerAboveContext.Provider value={value}>
        <SettingsMenu menu={[paneOf("screener", { Body: () => null })]} current={null} go={() => {}} />
      </ScreenerAboveContext.Provider>
    </TextProvider>,
  );
  const row = screen.getByRole("button", { name: "Screener" });
  expect(within(row).getByText("2 waiting")).toBeTruthy();
  expect(within(row).getByText("3 screened out · 1 in Spam")).toBeTruthy();
});

it("does not call a partial Junk page or an unsettled queue a total", () => {
  const value = {
    model: { queueSettled: false, waitingCount: 3, screenedOut: [{}], spam: [{}] },
    beside: { facts: { owed: true }, junk: {} },
  } as unknown as ScreenerAboveValue;
  render(
    <TextProvider locale="en" messages={WORDS}>
      <ScreenerAboveContext.Provider value={value}>
        <SettingsMenu menu={[paneOf("screener", { Body: () => null })]} current={null} go={() => {}} />
      </ScreenerAboveContext.Provider>
    </TextProvider>,
  );
  const row = screen.getByRole("button", { name: "Screener" });
  expect(within(row).queryByText(/waiting|screened out|in Spam/)).toBeNull();
});

it("shows settled Screener counts in German on the phone", () => {
  const value = {
    model: { queueSettled: true, waitingCount: 2, screenedOut: [{}, {}, {}], spam: [{}] },
    beside: { facts: { owed: false }, junk: NONE },
  } as unknown as ScreenerAboveValue;
  render(
    <TextProvider
      locale="de"
      messages={{
        settings: settingsDe.settings,
        settingsNotifications: notifyDe.settingsNotifications,
        settingsMenu: menuDe.settingsMenu,
      }}
    >
      <ScreenerAboveContext.Provider value={value}>
        <SettingsMenu menu={[paneOf("screener", { Body: () => null })]} current={null} phone go={() => {}} />
      </ScreenerAboveContext.Provider>
    </TextProvider>,
  );
  const row = screen.getByRole("button", { name: "Screener" });
  expect(within(row).getByText("2 warten")).toBeTruthy();
  expect(within(row).getByText("3 aussortiert · 1 im Spam")).toBeTruthy();
});

it("names the default appearance as oh", () => {
  render(
    <TextProvider locale="en" messages={WORDS}>
      <ThemeProvider defaultPreference="light" storageKey={null}>
        <SettingsMenu menu={[paneOf("general", { Body: () => null })]} current={null} go={() => {}} />
      </ThemeProvider>
    </TextProvider>,
  );
  const row = screen.getByRole("button", { name: "General" });
  expect(within(row).getByText("oh · Light")).toBeTruthy();
});

it("summarizes the saved folders and signatures for live mailboxes", () => {
  const panes = mailPanes({ ...NO_PANE_PARTS, folders: () => null, signatures: () => null });
  const consent = {
    known: true,
    foldersEnabled: true,
    folderMailboxesKnown: true,
    folderMailboxesOff: {},
    signaturesKnown: true,
    signatures: { first: "Best wishes\nTeam", second: "" },
    signaturesHtml: {},
  } as unknown as ConsentRow;
  const mail = {
    mailboxes: [
      { id: "first", status: "connected" },
      { id: "second", status: "connected" },
    ],
  } as unknown as MailStateBinding;
  if (panes.folders === NONE || panes.signatures === NONE) throw new Error("missing panes");
  render(
    <TextProvider locale="en" messages={WORDS}>
      <EngineContext.Provider value={{ demo: false, serverDemo: false } as EngineBinding}>
        <ConsentContext.Provider value={consent}>
          <MailStateContext.Provider value={mail}>
            <SettingsMenu menu={[panes.folders, panes.signatures]} current={null} go={() => {}} />
          </MailStateContext.Provider>
        </ConsentContext.Provider>
      </EngineContext.Provider>
    </TextProvider>,
  );
  expect(within(screen.getByRole("button", { name: "Folders" })).getByText("On")).toBeTruthy();
  const signatures = screen.getByRole("button", { name: "Signatures" });
  expect(within(signatures).getByText("1")).toBeTruthy();
  expect(within(signatures).getByText("Best wishes")).toBeTruthy();
  expect(within(signatures).getByText("Team")).toBeTruthy();
});

it.each([
  { tag: { kind: "full" } as const, percent: 100, word: "Full" },
  { tag: null, percent: 5, word: "5%" },
])("shows the storage already read for the account as $word", ({ tag, percent, word }) => {
  const door = fakeStorageDoor({ figures: someFigures({ tag, percent }) });
  const pane = storagePane({ useDoor: () => door, factor: () => null });
  render(
    <TextProvider locale="en" messages={WORDS}>
      <SettingsMenu menu={[pane]} current={null} go={() => {}} />
    </TextProvider>,
  );
  const row = screen.getByRole("button", { name: "Storage" });
  expect(within(row).getByText(word)).toBeTruthy();
  expect(within(row).getByText("235 MB of 5 GB")).toBeTruthy();
});

it("shows the running build in About", () => {
  const panes = mailPanes({ ...NO_PANE_PARTS, about: () => null });
  if (panes.about === NONE) throw new Error("missing pane");
  const frame = { api: { host: { device: { build: { version: "2.1" } } } } } as unknown as FrameInner;
  render(
    <TextProvider locale="en" messages={WORDS}>
      <FrameContext.Provider value={frame}>
        <SettingsMenu menu={[panes.about]} current={null} go={() => {}} />
      </FrameContext.Provider>
    </TextProvider>,
  );
  expect(within(screen.getByRole("button", { name: "About ohmail" })).getByText("2.1")).toBeTruthy();
});

it("shows the confirmed account in its Settings row", () => {
  const pane = accountPane({ useDoor: () => ({}) as AccountDoor, password: NONE });
  const frame = {
    api: {
      host: { engine: {}, session: { account: "owner", scope: "owner", accountAddress: "Account holder" } },
    },
  } as unknown as FrameInner;
  render(
    <TextProvider locale="en" messages={WORDS}>
      <FrameContext.Provider value={frame}>
        <SettingsMenu menu={[pane]} current={null} go={() => {}} />
      </FrameContext.Provider>
    </TextProvider>,
  );
  expect(within(screen.getByRole("button", { name: "Account" })).getByText("Account holder")).toBeTruthy();
});

it("withholds the account identity when it does not match this frame", () => {
  const pane = accountPane({ useDoor: () => ({}) as AccountDoor, password: NONE });
  const frame = {
    api: {
      host: { engine: {}, session: { account: "other", scope: "owner", accountAddress: "Account holder" } },
    },
  } as unknown as FrameInner;
  render(
    <TextProvider locale="en" messages={WORDS}>
      <FrameContext.Provider value={frame}>
        <SettingsMenu menu={[pane]} current={null} go={() => {}} />
      </FrameContext.Provider>
    </TextProvider>,
  );
  expect(within(screen.getByRole("button", { name: "Account" })).queryByText("Account holder")).toBeNull();
});

it("shows the saved Away responder without another read", () => {
  const panes = mailPanes({ ...NO_PANE_PARTS, away: () => null });
  if (panes.away === NONE) throw new Error("missing pane");
  const saved = { enabled: true, audience: "everyone" };
  const wire = { snapshot: { read: () => saved, subscribe: () => () => {} } };
  const frame = { api: { host: { wires: { away: wire } } } } as unknown as FrameInner;
  render(
    <TextProvider locale="en" messages={WORDS}>
      <FrameContext.Provider value={frame}>
        <SettingsMenu menu={[panes.away]} current={null} go={() => {}} />
      </FrameContext.Provider>
    </TextProvider>,
  );
  const row = screen.getByRole("button", { name: "Away responder" });
  expect(within(row).getByText("On")).toBeTruthy();
  expect(within(row).getByText("Everyone")).toBeTruthy();
});

it.each([
  { match: "second.example", count: "2", detail: "Ohbox 1 · News 1" },
  { match: "first.example", count: "1", detail: "Ohbox 1" },
])("summarizes the rules the organizer runs for $match", ({ match, count, detail }) => {
  const panes = mailPanes({ ...NO_PANE_PARTS, rules: () => null });
  if (panes.rules === NONE) throw new Error("missing pane");
  const rules = [
    {
      id: "one",
      kind: "domain",
      match: "first.example",
      enabled: true,
      destination: "INBOX",
      createdAt: "2026-01-01",
    },
    { id: "two", kind: "domain", match, enabled: false, destination: "ohmail/News", createdAt: "2026-01-02" },
  ];
  const reader = { list: (kind: string) => (kind === "rule" ? rules : []), stampExcept: () => 1 };
  const engine = {
    read: () => reader,
    subscribe: () => () => {},
    placementStamp: () => 1,
    queuedRuleWrites: () => [],
    appliedRuleRequests: () => [],
    waitingOnOrganizer: () => [],
  };
  const mail = { state: { settled: true, owed: false }, mailboxes: [] } as unknown as MailStateBinding;
  render(
    <TextProvider locale="en" messages={WORDS}>
      <EngineContext.Provider value={{ engine, demo: false, serverDemo: false } as unknown as EngineBinding}>
        <MailStateContext.Provider value={mail}>
          <SettingsMenu menu={[panes.rules]} current={null} go={() => {}} />
        </MailStateContext.Provider>
      </EngineContext.Provider>
    </TextProvider>,
  );
  const row = screen.getByRole("button", { name: "Rules" });
  expect(within(row).getByText(count)).toBeTruthy();
  expect(within(row).getByText(detail)).toBeTruthy();
});
