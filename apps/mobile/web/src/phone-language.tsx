import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { fillOver, TextProvider, type Locale, type Messages } from "@ohmail/app/text";
import type { GeneralSettingsProps } from "@ohmail/app/settings/browser";

type Choice = "en" | "de" | null;
export interface PhoneLanguageDoor {
  readonly locale: Locale;
  readonly choice: Choice;
  set(next: Choice): Promise<Locale>;
}

const Language = createContext<GeneralSettingsProps["language"]>(null);

export function PhoneLanguage({ door, catalogue, timeZone, children }: {
  readonly door: PhoneLanguageDoor;
  readonly catalogue: { readonly en: Messages; readonly de: Messages };
  readonly timeZone: string;
  readonly children: ReactNode;
}) {
  const [{ locale, choice }, setLanguage] = useState({ locale: door.locale, choice: door.choice });
  const languages = useMemo(() => ({
    value: choice ?? "system",
    choices: ["system", "en", "de"],
    local: true,
    busy: false,
    async set(next: string) {
      if (next !== "system" && next !== "en" && next !== "de") return;
      const choice = next === "system" ? null : next;
      setLanguage({ locale: await door.set(choice), choice });
    },
  }), [choice, door]);
  const messages = useMemo(() => locale === "de" ? fillOver(catalogue.en, catalogue.de) : catalogue.en,
    [catalogue, locale]);
  return (
    <Language.Provider value={languages}>
      <TextProvider locale={locale} messages={messages} timeZone={timeZone}>{children}</TextProvider>
    </Language.Provider>
  );
}

export const usePhoneLanguage = () => useContext(Language);
