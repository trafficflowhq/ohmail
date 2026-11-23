import { expect, it } from "vitest";
import { loadWholeCatalog } from "../i18n/catalog";

it.each([
  ["en", "Connecting", "Alerts", "Week numbers", "Off"],
  ["de", "Verbindet", "Erinnerungen", "Kalenderwochen", "Aus"],
] as const)("loads %s Settings summaries from the runtime catalogue", async (locale, mailbox, alerts, weekNumbers, off) => {
  const words = await loadWholeCatalog(locale);
  expect(words).toMatchObject({
    settingsMenu: { mailboxConnecting: mailbox },
    settingsNotifications: { shortAlerts: alerts },
    calsettings: { view: { weekNumbers, off } },
  });
});
