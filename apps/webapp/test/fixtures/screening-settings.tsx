import { MailGround, mailSettings, NO_PANE_PARTS, prepareWriting } from "@ohmail/app/mail";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { NextIntlClientProvider } from "next-intl";
import type en from "../../messages/en.json";
import { WEB_MAIL_PARTS } from "../../app/(product)/mailbox/mail-parts";
import { screeningSettings } from "../../app/api-client";
import { MailFrame } from "../../app/shell/browser-mail";
import { fakeMail } from "../../../../packages/app/test/reader/support/mail.js";
import { fakeHost } from "../../../../packages/app/test/support/fake-host.js";
import { fakeAddress } from "../../../../packages/app/test/support/fake-window.js";

await prepareWriting();

export function screeningSettingsFrame() {
  const account = "screening-settings-fixture";
  const { host } = fakeHost({
    engine: fakeMail([]).engine,
    service: "managed",
    scope: account,
    account,
    above: MailGround,
    address: fakeAddress("#/settings/screener"),
    features: { screener: { name: "screener", render: () => null } },
    places: { settings: mailSettings({ ...NO_PANE_PARTS, screener: WEB_MAIL_PARTS.paneParts.screener }) },
    wires: {
      screening: {
        read: () => screeningSettings.get(),
        change: (change) => screeningSettings.set(change),
      },
    },
  });
  return function SettingsFrame({ locale, messages }: { locale: "en" | "de"; messages: typeof en }) {
    return (
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
        <ThemeProvider storageKey={null}>
          <ToastHost>
            <MailFrame host={host} />
          </ToastHost>
        </ThemeProvider>
      </NextIntlClientProvider>
    );
  };
}
