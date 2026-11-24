/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { afterEach, expect, it } from "vitest";
import { TextProvider } from "@ohmail/app/text";
import {
  CALENDAR_NOTICES_KEY,
  NOTIFICATION_CHANNELS_KEY,
} from "@ohmail/app-logic/notices/browser-channels";
import type { Bridge } from "../web/src/bridge";
import { storedNoticeChoices, storedWidgetChoices } from "../web/src/notices";
import { phoneNewMailPane } from "../web/src/settings-panes";
import { mount } from "./_rendered-dom";

const scope = "fixture-account";

afterEach(() => localStorage.clear());

it("reads widget choices from the same account as the phone's notices", () => {
  localStorage.setItem(NOTIFICATION_CHANNELS_KEY, JSON.stringify({ master: true }));
  localStorage.setItem(CALENDAR_NOTICES_KEY, JSON.stringify({ cal_alert: true, widgetTitles: true }));
  localStorage.setItem(
    `${CALENDAR_NOTICES_KEY}.${scope}`,
    JSON.stringify({ cal_alert: false, widgetTitles: false }),
  );
  expect(storedNoticeChoices(localStorage, true, scope).cal_alert).toBe(false);
  expect(storedWidgetChoices(localStorage, scope)).toMatchObject({
    cal_alert: false,
    widgetTitles: false,
  });
});

it("keeps the existing mail switches when previews are turned on for the first time", async () => {
  const key = `${NOTIFICATION_CHANNELS_KEY}.${scope}`;
  const shared = { master: false, ohbox: false, screener: false, scheduled: false, pairing: false };
  localStorage.setItem(NOTIFICATION_CHANNELS_KEY, JSON.stringify(shared));
  const bridge = {
    on: () => () => {},
    request: async () => ({ wake: { os: "android", state: { k: "no_distributor" }, choices: [], chosen: null, busy: false } }),
  } as unknown as Bridge;
  const Pane = phoneNewMailPane(bridge, scope, true);
  const view = mount(createElement(TextProvider, { locale: "en", timeZone: "UTC", messages: {}, children: createElement(Pane) }));
  try {
    await act(async () => {});
    const preview = view.el.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(preview).not.toBeNull();
    await act(async () => preview?.click());
    expect(JSON.parse(localStorage.getItem(key) ?? "null")).toEqual({ ...shared, showMailDetails: true });
    expect(JSON.parse(localStorage.getItem(NOTIFICATION_CHANNELS_KEY) ?? "null")).toEqual(shared);
    expect(storedNoticeChoices(localStorage, false, "another-account").showMailDetails).toBeUndefined();
  } finally {
    view.unmount();
  }
});
