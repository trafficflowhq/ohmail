/** @vitest-environment jsdom */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConsentContext, type ConsentRow } from "@ohmail/app-logic/consent";
import { EngineContext } from "@ohmail/app-logic/engine";
import {
  MailStateContext,
  useMailState,
  type MailStateBinding,
  type MailboxProbe,
} from "@ohmail/app-logic/mail-state";
import { onNoticeReturn, readChannels, writeChannels } from "@ohmail/app-logic/notices/browser-channels";
import { SYNC_SETTLED } from "@ohmail/app-logic/session/sync-scheduler";
import { FrameContext, type FrameInner } from "../../src/frame/commands.js";
import { NONE, type DeviceNotifications } from "../../src/host/index.js";
import { mailboxesPane } from "../../src/mailboxes/pane/pane.js";
import { MailStateProvider } from "../../src/mail-state/index.js";
import { SettingsMenu } from "../../src/settings/SettingsMenu.js";
import { paneOf } from "../../src/settings/facts.js";
import { BrowserSettingsAbove } from "../../src/settings/browser/MailSettings.js";
import { useAwaySummary } from "../../src/settings/away/summary.js";
import { useFoldersSummary } from "../../src/settings/consent-summary.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeMail } from "../reader/support/fake-mail.js";
import settings from "../../messages/settings.en.json" with { type: "json" };
import menu from "../../messages/settings-menu.en.json" with { type: "json" };
import notifications from "../../messages/settings-notifications.en.json" with { type: "json" };
import frame from "../../messages/frame.en.json" with { type: "json" };

const words = { ...settings, ...menu, ...notifications, ...frame };
const go = () => {};
const row = (name: string) => screen.getByRole("button", { name });

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("refreshes Notifications while General is open", () => {
  const scope = "owner";
  let permission: ReturnType<DeviceNotifications["permission"]> = "granted";
  const frame = {
    api: {
      host: {
        device: { notifications: { permission: () => permission, emitter: NONE } },
        session: { scope },
        wires: { calendar: NONE },
      },
      route: { sub: "general" },
    },
  } as unknown as FrameInner;
  const panes = [paneOf("general", { Body: () => null }), paneOf("notifications", { Body: () => null })];
  render(
    <TextProvider locale="en" messages={words}>
      <FrameContext.Provider value={frame}>
        <BrowserSettingsAbove
          preferences={{
            readChannels,
            writeChannels,
            subscriptionWanted: () => false,
            onReturn: (refresh) => onNoticeReturn(window, refresh),
          }}
        >
          <SettingsMenu menu={panes} current="general" go={go} />
        </BrowserSettingsAbove>
      </FrameContext.Provider>
    </TextProvider>,
  );
  expect(within(row("Notifications")).getByText("On")).toBeTruthy();
  act(() => {
    writeChannels({ ...readChannels(scope), master: false }, scope);
  });
  expect(within(row("Notifications")).getByText("Off")).toBeTruthy();
  permission = "denied";
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(within(row("Notifications")).getByText("Blocked")).toBeTruthy();
});

it("only calls a mailbox connected after its first successful sync", () => {
  let lastSyncAt: string | null | undefined;
  const pane = paneOf(
    "mailboxes",
    mailboxesPane({
      factor: NONE,
      calendar: NONE,
      mailState: () => ({
        state: { key: "ready" },
        refresh: go,
        mailboxes: [{ status: "connected", displayName: "Work", lastSyncAt }],
      }),
    }),
  );
  const tree = () => (
    <TextProvider locale="en" messages={words}>
      <SettingsMenu menu={[pane]} current={null} go={go} />
    </TextProvider>
  );
  const { rerender } = render(tree());
  expect(row("Mailboxes").textContent).not.toMatch(/Connecting|Connected/);
  lastSyncAt = null;
  rerender(tree());
  expect(within(row("Mailboxes")).getByText("Connecting")).toBeTruthy();
  lastSyncAt = "2026-11-21T12:00:00Z";
  rerender(tree());
  expect(within(row("Mailboxes")).getByText("Connected")).toBeTruthy();
});

it("shows a failed Mailboxes read and keeps the last good summary through a later failure", async () => {
  const { engine } = fakeMail([]);
  const binding = { engine, demo: false, serverDemo: false, sync: SYNC_SETTLED };
  const probe = vi
    .fn<MailboxProbe>()
    .mockRejectedValueOnce(new Error("Unavailable"))
    .mockResolvedValueOnce([
      {
        id: "work",
        address: "",
        displayName: "Work",
        status: "connected",
        errorCode: null,
        disabledReason: null,
        syncBlockedReason: null,
        syncBlockedSince: null,
        createdAt: "2026-11-21T11:00:00Z",
        lastSyncAt: "2026-11-21T12:00:00Z",
      },
    ])
    .mockRejectedValueOnce(new Error("Unavailable"));
  const pane = paneOf(
    "mailboxes",
    mailboxesPane({
      factor: NONE,
      calendar: NONE,
      mailState: useMailState,
      useLimit: () => 10,
    }),
  );
  let refresh: MailStateBinding["refresh"];
  function Reread() {
    refresh = useMailState().refresh;
    return null;
  }
  await act(async () => {
    render(
      <TextProvider locale="en" messages={words}>
        <EngineContext.Provider value={binding}>
          <MailStateProvider scope="owner" probe={probe} mirrored={0}>
            <SettingsMenu menu={[pane]} current={null} go={go} />
            <Reread />
          </MailStateProvider>
        </EngineContext.Provider>
      </TextProvider>,
    );
  });
  const failed = frame.viewError.loadFailed;
  expect(within(row("Mailboxes")).getByText(failed)).toBeTruthy();
  await act(async () => {
    await refresh();
  });
  expect(within(row("Mailboxes")).queryByText(failed)).toBeNull();
  expect(within(row("Mailboxes")).getByText("1 of 10")).toBeTruthy();
  expect(within(row("Mailboxes")).getByText("Work")).toBeTruthy();
  await act(async () => {
    await refresh();
  });
  expect(probe).toHaveBeenCalledTimes(3);
  expect(within(row("Mailboxes")).getByText("1 of 10")).toBeTruthy();
  expect(within(row("Mailboxes")).getByText("Work")).toBeTruthy();
});

it("waits for the live folders answer after an older boot cache", () => {
  const pane = paneOf("folders", { Body: () => null, useSummary: useFoldersSummary });
  const mail = { mailboxes: [{ id: "work", status: "connected" }] } as unknown as MailStateBinding;
  const tree = (live: boolean) => {
    const consent = {
      known: true,
      foldersEnabled: live,
      folderMailboxesKnown: live,
      folderMailboxesOff: {},
    } as unknown as ConsentRow;
    return (
      <TextProvider locale="en" messages={words}>
        <ConsentContext.Provider value={consent}>
          <MailStateContext.Provider value={mail}>
            <SettingsMenu menu={[pane]} current={null} go={go} />
          </MailStateContext.Provider>
        </ConsentContext.Provider>
      </TextProvider>
    );
  };
  const { rerender } = render(tree(false));
  expect(row("Folders").getAttribute("aria-describedby")).toBeNull();
  rerender(tree(true));
  expect(within(row("Folders")).getByText("On")).toBeTruthy();
  expect(within(row("Folders")).getByText("1 mailbox")).toBeTruthy();
});

it("shows Away as off at the saved cutoff without asking for a new snapshot", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T12:00:00Z"));
  const saved = { enabled: true, audience: "everyone", startsAt: null, endsAt: "2026-11-21T12:00:01Z" };
  const state = vi.fn();
  const wire = { state, snapshot: { read: () => saved, subscribe: () => go } };
  const frame = { api: { host: { wires: { away: wire } } } } as unknown as FrameInner;
  const pane = paneOf("away", { Body: () => null, useSummary: useAwaySummary });
  render(
    <TextProvider locale="en" messages={words} timeZone="UTC">
      <FrameContext.Provider value={frame}>
        <SettingsMenu menu={[pane]} current={null} go={go} />
      </FrameContext.Provider>
    </TextProvider>,
  );
  expect(within(row("Away responder")).getByText("On")).toBeTruthy();
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(within(row("Away responder")).getByText("Off")).toBeTruthy();
  expect(row("Away responder").textContent).toMatch(/end date passed/i);
  expect(state).not.toHaveBeenCalled();
});
