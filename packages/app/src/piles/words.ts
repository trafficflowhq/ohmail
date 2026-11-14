/** When a Resurface row is back, on the reader's own calendar. */
import { headStamp, readerZone } from "@ohmail/app-logic/reader";
import type { Text } from "../text/index.js";

export function backStamp(iso: string, tl: Text, locale: string, now: Date = new Date()): string {
  return headStamp(iso, now, readerZone(), locale, { yesterday: (time) => tl("stamp.yesterday", { time }) })
    .when;
}
