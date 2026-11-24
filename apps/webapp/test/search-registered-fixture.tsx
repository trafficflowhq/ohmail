import type { OhmailEngine } from "@ohmail/client-engine";
import { NONE } from "@ohmail/app/host";
import { ThemeProvider } from "@ohmail/ui";
import { NextIntlClientProvider } from "next-intl";
import { fireEvent, within } from "@testing-library/react";
import messages from "../messages/en.json";
import german from "../messages/de.json";
import { MailShell } from "./_mail-shell";

export function enterSearchRoute(): () => void {
  const previous = window.location.href;
  window.history.replaceState(null, "", "#/search");
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as typeof Element.prototype.animate;
  Element.prototype.scrollIntoView ??= () => {};
  return () => window.history.replaceState(null, "", previous);
}

export function RegisteredSearch({ engine, now, locale = "en", catalogue = messages, scope }: {
  engine: OhmailEngine;
  now: Date;
  locale?: string;
  catalogue?: typeof messages;
  scope?: string;
}) {
  return (
    <NextIntlClientProvider locale={locale} messages={catalogue} timeZone="UTC" now={now}>
      <ThemeProvider storageKey={null}>
        <MailShell engine={engine} consentTransport={NONE} scope={scope} />
      </ThemeProvider>
    </NextIntlClientProvider>
  );
}

const searchName = (name: string) => name === messages.search.aria || name === german.search.aria;

export const searchField = (host: HTMLElement) => within(host).getByRole("textbox", { name: searchName });
export const findSearchField = (host: HTMLElement) => within(host).findByRole("textbox", { name: searchName });

export function typeSearch(host: HTMLElement, query: string): void {
  fireEvent.change(searchField(host), { target: { value: query } });
}
