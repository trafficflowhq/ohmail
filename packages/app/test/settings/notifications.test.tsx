/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NotificationsPane,
  notificationsState,
  type NotificationsModel,
} from "../../src/settings/notifications/index.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import notifyDe from "../../messages/settings-notifications.de.json" with { type: "json" };
import notifyEn from "../../messages/settings-notifications.en.json" with { type: "json" };
import settingsDe from "../../messages/settings.de.json" with { type: "json" };
import settingsEn from "../../messages/settings.en.json" with { type: "json" };

const WORDS: Record<"en" | "de", Messages> = {
  en: { settings: settingsEn.settings, ...notifyEn } as Messages,
  de: { settings: settingsDe.settings, ...notifyDe } as Messages,
};
const S = settingsEn.settings;

function mount(model: NotificationsModel, locale: "en" | "de" = "en") {
  return render(
    <TextProvider locale={locale} messages={WORDS[locale]} timeZone="Europe/Zurich">
      <NotificationsPane model={model} />
    </TextProvider>,
  );
}
const line = (name: string) => screen.queryAllByRole("group", { name })[0] ?? null;
const sw = (name: string) => within(line(name)!).getByRole("switch");
const state = (over: Partial<NotificationsModel> = {}): NotificationsModel => ({
  ...notificationsState(),
  ...over,
});

afterEach(cleanup);

describe("Notifications", () => {
  it("is on only when it is stored on AND the platform granted it", () => {
    mount(state({ permission: "default", live: false }));
    expect(sw(S.notifyMaster).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(S.notifyAskFirst)).toBeTruthy();
    cleanup();
    mount(state());
    expect(sw(S.notifyMaster).getAttribute("aria-checked")).toBe("true");
  });

  it("says a blocked platform on the sheet and leaves the master unpressable", () => {
    const pressMaster = vi.fn();
    mount(state({ permission: "denied", live: false, pressMaster }));
    expect(screen.getByText(S.notifyDenied, { exact: false })).toBeTruthy();
    expect(screen.getByText(notifyEn.settingsNotifications.blocked)).toBeTruthy();
    expect(sw(S.notifyMaster).hasAttribute("disabled")).toBe(true);
    fireEvent.click(line(S.notifyMaster)!);
    expect(pressMaster).not.toHaveBeenCalled();
  });

  it("hands the master's press to the model, which alone may ask the platform", () => {
    const pressMaster = vi.fn();
    mount(
      state({
        permission: "default",
        live: false,
        channels: { ...notificationsState().channels, master: false },
        pressMaster,
      }),
    );
    fireEvent.click(sw(S.notifyMaster));
    expect(pressMaster).toHaveBeenCalledWith(true);
  });

  it("offers a switch for exactly the kinds the emitter draws, and only while the master is live", () => {
    mount(state({ carries: ["ohbox", "pairing"] }));
    expect(line(S.notifyOhbox)).not.toBeNull();
    expect(line(S.notifyPairing)).not.toBeNull();
    expect(line(S.notifyScreener)).toBeNull();
    expect(line(S.notifyScheduled)).toBeNull();
    cleanup();
    mount(state({ live: false }));
    expect(line(S.notifyOhbox)).toBeNull();
  });

  it("has no switch where the host's emitter does not draw the kind, and no kind switch at all without an emitter", () => {
    mount(state({ carries: ["cal_alert"] }));
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    cleanup();
    mount(state({ carries: [] }));
    expect(screen.getAllByRole("switch"), "only the master stands").toHaveLength(1);
    expect(line(S.notifyMaster)).not.toBeNull();
  });

  it("offers no switch to show who a notice is from or its subject", () => {
    mount(state());
    // The master and the four kinds the emitter draws, and nothing beside them.
    expect(screen.getAllByRole("switch")).toHaveLength(5);
    expect(screen.queryAllByRole("group", { name: /subject|who it is from/i })).toEqual([]);
  });

  it("writes a kind's switch as the whole set of choices", () => {
    const set = vi.fn();
    mount(state({ set }));
    fireEvent.click(sw(S.notifyScreener));
    expect(set).toHaveBeenCalledWith({ ...notificationsState().channels, screener: false });
  });

  it("says what the last reconcile answered, and nothing once it clears", () => {
    const { rerender } = mount(state({ delivery: "no_server_key" }));
    expect(screen.getByText(S.notifyNoServerKey, { exact: false })).toBeTruthy();
    rerender(
      <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
        <NotificationsPane model={state({ delivery: null })} />
      </TextProvider>,
    );
    expect(screen.queryByText(S.notifyNoServerKey, { exact: false })).toBeNull();
  });

  it("says where the platform holds the answer, and the device's own reach", () => {
    mount(state({ osHolds: true, permission: "default", live: false }));
    expect(screen.getByText(S.notifyOsHeld)).toBeTruthy();
    expect(screen.queryByText(S.notifyAskFirst)).toBeNull();
    expect(screen.getByText("This device")).toBeTruthy();
    expect(
      screen.queryByText(
        "The numbers mean the same thing on every device: the app icon and the Ohbox count unread mail in your Ohbox, the Screener counts first-time senders waiting, and News and Receipts count what arrived since you last looked.",
      ),
    ).toBeNull();
  });

  it("reads in German", () => {
    mount(state({ permission: "denied", live: false }), "de");
    expect(line(settingsDe.settings.notifyMaster)).not.toBeNull();
    expect(screen.getByText(notifyDe.settingsNotifications.blocked)).toBeTruthy();
  });
});
