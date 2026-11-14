/**
 * The words Settings' acting panes read, in both languages, from their place files: the settings place's six old
 * namespaces, each pane's own, and `shared`. And a mount that draws a pane under them.
 */
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { fillOver, TextProvider, type Messages } from "../../../src/text/index.js";
import screeningDe from "../../../messages/screener.de.json" with { type: "json" };
import screeningEn from "../../../messages/screener.en.json" with { type: "json" };
import settingsDe from "../../../messages/settings.de.json" with { type: "json" };
import settingsEn from "../../../messages/settings.en.json" with { type: "json" };
import sharedDe from "../../../messages/shared.de.json" with { type: "json" };
import sharedEn from "../../../messages/shared.en.json" with { type: "json" };
import aiDe from "../../../messages/settings-ai.de.json" with { type: "json" };
import aiEn from "../../../messages/settings-ai.en.json" with { type: "json" };
import aboutDe from "../../../messages/settings-about.de.json" with { type: "json" };
import aboutEn from "../../../messages/settings-about.en.json" with { type: "json" };
import screenerDe from "../../../messages/settings-screener.de.json" with { type: "json" };
import screenerEn from "../../../messages/settings-screener.en.json" with { type: "json" };
import awayDe from "../../../messages/settings-away.de.json" with { type: "json" };
import awayEn from "../../../messages/settings-away.en.json" with { type: "json" };
import rulesDe from "../../../messages/settings-rules.de.json" with { type: "json" };
import rulesEn from "../../../messages/settings-rules.en.json" with { type: "json" };

const EN: Messages = {
  ...settingsEn,
  ...sharedEn,
  ...aiEn,
  ...aboutEn,
  ...screenerEn,
  ...screeningEn,
  ...awayEn,
  ...rulesEn,
};
const DE: Messages = {
  ...settingsDe,
  ...sharedDe,
  ...aiDe,
  ...aboutDe,
  ...screenerDe,
  ...screeningDe,
  ...awayDe,
  ...rulesDe,
};

/** German is filled over English, as both shells hand the reader its catalogue. */
export const ACTING_WORDS: Readonly<Record<"en" | "de", Messages>> = { en: EN, de: fillOver(EN, DE) };

/** One key of one namespace, as the catalogue holds it: a test names a sentence by its key, never by its words. */
export function said(lang: "en" | "de", namespace: string, key: string): string {
  let at: unknown = ACTING_WORDS[lang][namespace];
  for (const part of key.split(".")) at = (at as Record<string, unknown> | undefined)?.[part];
  if (typeof at !== "string") throw new Error(`no sentence ${namespace}.${key} in ${lang}`);
  return at;
}

/** Every key of every namespace a pane reads, with its English and German, so a test can find an untranslated one. */
export function wordsUnder(lang: "en" | "de", namespace: string): Readonly<Record<string, unknown>> {
  return ACTING_WORDS[lang][namespace] as Readonly<Record<string, unknown>>;
}

export function drawn(node: ReactNode, lang: "en" | "de" = "en") {
  return render(node, {
    wrapper: ({ children }) => (
      <TextProvider
        locale={lang}
        messages={ACTING_WORDS[lang]}
        timeZone="Europe/Zurich"
        now={new Date("2026-11-16T09:00:00Z")}
      >
        {children}
      </TextProvider>
    ),
  });
}
