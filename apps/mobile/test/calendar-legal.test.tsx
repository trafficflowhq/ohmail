/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { expect, it, vi } from "vitest";
import { TextProvider } from "@ohmail/app/text";
import accountEn from "../../../packages/app/messages/account.en.json";
import accountDe from "../../../packages/app/messages/account.de.json";
import phoneEn from "../../../packages/app/messages/phone.en.json";
import phoneDe from "../../../packages/app/messages/phone.de.json";
import settingsEn from "../../../packages/app/messages/settings.en.json";
import settingsDe from "../../../packages/app/messages/settings.de.json";
import type { Bridge } from "../web/src/bridge";
import { phoneCalendarAbout } from "../web/src/remaining-settings";
import { mount } from "./_rendered-dom";

it.each([
  { locale: "en", setting: "managed", privacy: "Privacy policy", imprint: "Imprint", support: "Support", erase: "Delete account",
    consequence: /deletes the account you use in both ohcal and ohmail, including the stored copies of your calendar data and mail\. This cannot be undone\./,
    messages: { ...phoneEn, ...settingsEn, ...accountEn } },
  { locale: "de", setting: "desktopHost", privacy: "Datenschutzerklärung", imprint: "Impressum", support: "Support", erase: "Account löschen",
    consequence: /wird der Account gelöscht, den du in ohcal und ohmail nutzt, samt den gespeicherten Kopien deiner Kalenderdaten und Mails\. Das lässt sich nicht rückgängig machen\./,
    messages: { ...phoneDe, ...settingsDe, ...accountDe } },
] as const)("opens the calendar's legal pages and shared-account deletion in $locale", async (row) => {
  const request = vi.fn(async () => ({}));
  const bridge = { request } as unknown as Bridge;
  const About = phoneCalendarAbout(bridge, {
    scope: "calendar", setting: row.setting, build: { version: "1.0.0", number: "1", commit: null },
  });
  const view = mount(createElement(TextProvider, {
    locale: row.locale, timeZone: "UTC", messages: row.messages as never, children: createElement(About),
  }));
  try {
    expect(view.el.textContent).toMatch(row.consequence);
    expect(view.el.textContent).toContain("1.0.0 (1)");
    for (const label of [row.privacy, row.imprint, row.support, row.erase]) {
      const button = [...view.el.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
      expect(button, label).toBeDefined();
      await act(async () => button?.click());
    }
    expect(request.mock.calls).toEqual([
      ["act", { act: "about.page", page: "privacy" }],
      ["act", { act: "about.page", page: "imprint" }],
      ["act", { act: "about.page", page: "support" }],
      row.setting === "managed" ? ["phone.account", { scope: "calendar", do: "deletePage" }]
        : ["act", { act: "about.page", page: "deleteAccount" }],
    ]);
  } finally {
    view.unmount();
  }
});
