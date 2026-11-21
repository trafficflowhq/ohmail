import { expect, it } from "vitest";
import { loadWholeCatalog } from "../i18n/catalog";

it.each([
  ["en", "Connecting", "Alerts", "Week numbers off"],
  ["de", "Verbindet", "Erinnerungen", "Kalenderwochen aus"],
] as const)("loads %s Settings summaries from the runtime catalogue", async (locale, mailbox, alerts, weekNumbers) => {
  const words = await loadWholeCatalog(locale);
  expect(words).toMatchObject({
    settingsMenu: { mailboxConnecting: mailbox },
    settingsNotifications: { shortAlerts: alerts },
    calsettings: { view: { weekNumbersOff: weekNumbers } },
  });
});
