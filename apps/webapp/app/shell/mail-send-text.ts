"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import type { Translator } from "@ohmail/app-logic/text/translator";
import type { MailSendText } from "@ohmail/app-logic/writing/mail-send";
import { scheduleLabel } from "./format";

/** The web shell's words for sending: the whole catalogue's reader, and the time a send-later names. */
export function useMailSendText(): MailSendText {
  const t = useTranslations();
  return useMemo<MailSendText>(() => ({ t: t as unknown as Translator, scheduleLabel }), [t]);
}
