/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { ConsentContext, useConsentState } from "@ohmail/app-logic/consent";
import { mailSettings, NO_PANE_PARTS } from "@ohmail/app/mail";
import { readAfterVerb } from "@ohmail/app-logic/press/after-verb";
import { readImageQualityLevel } from "@ohmail/app-logic/write/image-quality";
import { fakeHost, NO_ENGINE } from "../../../../packages/app/test/support/fake-host.js";
import { fakeAddress } from "../../../../packages/app/test/support/fake-window.js";
import { WEB_PANE_PARTS } from "../../app/(product)/mailbox/pane-parts";
import { MailFrame } from "../../app/shell/browser-mail";
import words from "../../messages/en.json";

const settings = mailSettings({ ...NO_PANE_PARTS, general: WEB_PANE_PARTS.general });
const t = words.settings;

function AccountConsent({ scope, children }: { scope: string; children: ReactNode }) {
  const consent = useConsentState(false, scope, "none");
  return <ConsentContext.Provider value={consent}>{children}</ConsentContext.Provider>;
}

function view(scope: string) {
  const { host } = fakeHost({
    scope, engine: NO_ENGINE, service: "self", address: fakeAddress("#/settings/general"), places: { settings },
  });
  return (
    <NextIntlClientProvider messages={words} locale="en" timeZone="UTC">
      <ThemeProvider>
        <ToastHost>
          <AccountConsent key={scope} scope={scope}><MailFrame host={host} /></AccountConsent>
        </ToastHost>
      </ThemeProvider>
    </NextIntlClientProvider>
  );
}

afterEach(() => { cleanup(); localStorage.clear(); });

it("stores the reading and picture choices for the current account and resumes them on its next visit", () => {
  const mounted = render(view("account-a"));
  const choice = (label: string, name: string) =>
    within(screen.getAllByRole("group", { name: label })[0]!).getByRole("button", { name });
  fireEvent.click(choice(t.afterVerbAria, t.afterVerbChoice.stay));
  fireEvent.click(choice(t.imageQualityAria, t.imageQualityLevel.original));
  expect(readAfterVerb("account-a")).toBe("stay");
  expect(readImageQualityLevel("account-a")).toBe("original");
  mounted.rerender(view("account-b"));
  expect(choice(t.afterVerbAria, t.afterVerbChoice.stay).getAttribute("aria-pressed")).toBe("false");
  expect(choice(t.imageQualityAria, t.imageQualityLevel.original).getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryByRole("switch", { name: t.images.title })).toBeNull();
  mounted.rerender(view("account-a"));
  expect(choice(t.afterVerbAria, t.afterVerbChoice.stay).getAttribute("aria-pressed")).toBe("true");
  expect(choice(t.imageQualityAria, t.imageQualityLevel.original).getAttribute("aria-pressed")).toBe("true");
});
