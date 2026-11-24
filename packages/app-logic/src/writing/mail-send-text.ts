import { useMemo } from "react";
import type { Translator } from "../text/translator.js";
import type { MailSendText } from "./mail-send.js";

/**
 * The send machine's words as one record: the catalogue's reader and how a time to come is written, the same object
 * while neither moved. Whoever mounts the send machine calls it with its host's two answers.
 */
export function useSendText(t: Translator, scheduleLabel: MailSendText["scheduleLabel"]): MailSendText {
  return useMemo<MailSendText>(() => ({ t, scheduleLabel }), [t, scheduleLabel]);
}
