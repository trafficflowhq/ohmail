"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import type { Translator } from "@ohmail/app-logic/text/translator";
import type { ScreenerText } from "@ohmail/app-logic/screener/screener-state";
import { pileNames } from "./decision-copy";
import { PLACE_LABEL } from "./format";
import { activeFormatZone } from "./locale";
import { useAppLocale } from "./LocaleContext";

/**
 * The web shell's words for the Screener's state: its four catalogue readers, the pile names, the place labels (the
 * live object itself, so its getters follow a language switch), the locale and the format zone.
 */
export function useScreenerText(): ScreenerText {
  const screener = useTranslations("screener");
  const screening = useTranslations("screening");
  const ohbox = useTranslations("ohbox");
  const session = useTranslations("session");
  const locale = useAppLocale()?.locale ?? "en";
  return useMemo<ScreenerText>(() => ({
    screener: screener as unknown as Translator,
    screening: screening as unknown as Translator,
    ohbox: ohbox as unknown as Translator,
    session: session as unknown as Translator,
    piles: pileNames(screener),
    places: PLACE_LABEL,
    locale,
    zone: activeFormatZone,
  }), [screener, screening, ohbox, session, locale]);
}
