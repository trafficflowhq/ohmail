/** @vitest-environment jsdom */
/**
 * THE HEADS OF THE SETTINGS MENU: the "Settings" head and the "Mail" head end in the same dot as the menu's
 * own rows: it is hot when Notifications is blocked — the flag the notifications row already wears — and
 * stays ink when nothing stands open.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PANE_IDS, type SettingsPane } from "../../src/settings/contract.js";
import { paneOf } from "../../src/settings/facts.js";
import { NotificationsContext } from "../../src/settings/notifications/summary.js";
import type { NotificationsModel } from "../../src/settings/notifications/model.js";
import { SettingsMenu } from "../../src/settings/SettingsMenu.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import settingsEn from "../../messages/settings.en.json" with { type: "json" };
import notifyEn from "../../messages/settings-notifications.en.json" with { type: "json" };
import menuEn from "../../messages/settings-menu.en.json" with { type: "json" };

const WORDS: Messages = {
  settings: settingsEn.settings,
  settingsNotifications: notifyEn.settingsNotifications,
  settingsMenu: menuEn.settingsMenu,
};

/** Every section of the contract stands in the menu; the device's answer comes from the mounted model alone. */
const MENU: readonly SettingsPane[] = PANE_IDS.map((id) => paneOf(id, { Body: () => null }));

const modelOf = (permission: "denied" | "granted"): NotificationsModel => ({
  channels: { master: true, ohbox: true, screener: true, scheduled: true, pairing: true },
  permission,
  live: true,
  carries: [],
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
