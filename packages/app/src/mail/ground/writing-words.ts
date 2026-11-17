/**
 * THE COMPOSER'S WORDS BESIDE THE CATALOGUE, AS THE GROUND ANSWERS THEM: how a time to come is written, the size of a
 * file and the draft ceiling as the send lines name it, and the reader's clock. Each is asked at the moment something
 * is said or sent and never held: the reader's zone and language may change under a mounted composer. They read the
 * format's own words (`@ohmail/app-logic/text`), which the host hands where it builds its text provider.
 */
import { activeFormatLocale, activeFormatZone } from "@ohmail/app-logic/text";
import { scheduleLabel } from "@ohmail/app-logic/text/format";
import type { ComposerWords } from "@ohmail/app-logic/writing/composer-types";
import { sendLineValuesOver } from "@ohmail/app-logic/writing/send-line";
import { formatFileSize } from "@ohmail/ui/base";

/** A file's size in the person's language, as every line of the letter names one. */
export function fileSize(bytes: number): string {
  return formatFileSize(bytes, activeFormatLocale());
}

/** What a send line's sentence takes beside its key: the draft ceiling as the sentences name it. */
export function sendLineValues(): { size: string } {
  return sendLineValuesOver(fileSize);
}

/** One record for the frame's life: three functions, each asked when it is needed. */
export const COMPOSER_WORDS: ComposerWords = {
  scheduleLabel,
  sendLineValues,
  clock: () => ({ zone: activeFormatZone(), locale: activeFormatLocale() }),
};
