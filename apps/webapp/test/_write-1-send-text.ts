/** The send machine receives its text from the mail ground. Use the same catalogue reader and schedule-label formatter as the writing mount. */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useMemo } from "react";
import { createTranslator } from "next-intl";
import { useSendText } from "@ohmail/app-logic/writing/mail-send-text";
import type { MailSendText } from "@ohmail/app-logic/writing/mail-send";
import type { Translator } from "@ohmail/app-logic/text/translator";
import { COMPOSER_WORDS } from "../../../packages/app/src/mail/ground/writing-words.js";

/** Every English catalogue of the app, merged by namespace: what the ground's reader reads. */
const AT = resolve(__dirname, "..", "..", "..", "packages", "app", "messages");
const MESSAGES: Record<string, Record<string, unknown>> = Object.assign(
  {},
  ...readdirSync(AT)
    .filter((name) => name.endsWith(".en.json"))
    .map((name) => JSON.parse(readFileSync(resolve(AT, name), "utf8")) as Record<string, Record<string, unknown>>),
);

const translate = createTranslator({ locale: "en", messages: MESSAGES as never, timeZone: "UTC" });
/** The whole catalogue's reader, as the ground hands the composer one. */
export const GROUND_CATALOGUE: Translator = ((key: string, values?: Record<string, unknown>) =>
  (translate as unknown as (k: string, v?: Record<string, unknown>) => string)(key, values)) as unknown as Translator;

/** The send machine's words, as the ground's Write mount makes them. */
export function useMailSendText(): MailSendText {
  const text = useSendText(GROUND_CATALOGUE, COMPOSER_WORDS.scheduleLabel);
  return useMemo(() => text, [text]);
}

/** The composer's words beside the catalogue, the ground's own record. */
export { COMPOSER_WORDS };
