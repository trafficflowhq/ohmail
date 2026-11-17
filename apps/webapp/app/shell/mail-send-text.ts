"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import type { Translator } from "@ohmail/app-logic/text/translator";
import type { ComposerWords } from "@ohmail/app-logic/writing/composer-types";
import type { MailSendText } from "@ohmail/app-logic/writing/mail-send";
import { scheduleLabel } from "./format";
import { activeFormatLocale, activeFormatZone } from "./locale";
import { sendLineValues } from "./SendStatus";

/** The web shell's words for sending: the whole catalogue's reader, and the time a send-later names. */
export function useMailSendText(): MailSendText {
  const t = useTranslations();
  return useMemo<MailSendText>(() => ({ t: t as unknown as Translator, scheduleLabel }), [t]);
}

/**
 * The web shell's answers to the composer's words beside the catalogue: the shell's own label for a time to come,
 * the draft ceiling as its send lines name it, and the reader's clock as the shell's formatting holds it now.
 */
export const TODAYS_COMPOSER_WORDS: ComposerWords = {
  scheduleLabel,
  sendLineValues,
  clock: () => ({ zone: activeFormatZone(), locale: activeFormatLocale() }),
};
