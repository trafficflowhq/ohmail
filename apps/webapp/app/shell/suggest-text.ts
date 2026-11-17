"use client";

import { useTranslations } from "next-intl";
import type { Translator } from "@ohmail/app-logic/text/translator";
import type { SuggestText } from "@ohmail/app-logic/screener/screener-suggest";

/**
 * The web shell's words for the suggestion run: the catalogue's `screener` reader, and the reader of the AI
 * refusals every surface shares. Each caller of the run hands these; the run binds no text package of its own.
 */
export function useSuggestText(): SuggestText {
  const screener = useTranslations("screener");
  const aiRefusal = useTranslations("aiRefusal");
  return { screener: screener as unknown as Translator, aiRefusal: aiRefusal as unknown as Translator };
}
