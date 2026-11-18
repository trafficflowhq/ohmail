/** A stream item's sender and stamp, as its row and its sheet print them. */
import type { EngineMessage } from "@ohmail/wire";
import { headStamp, readerZone } from "@ohmail/app-logic/reader";
import type { StreamPlace } from "@ohmail/app-logic/streams";
import { useText, type Text } from "../text/index.js";

export function senderOf(m: EngineMessage): { name: string; address: string } {
  return { name: m.from.name?.trim() || m.from.address, address: m.from.address };
}

/** The stamp on the reader's own calendar: the clock today, "yesterday" and the clock, then the day. */
export function stampOf(iso: string | null | undefined, t: Text, locale: string, now: Date = new Date()) {
  return headStamp(iso, now, readerZone(), locale, { yesterday: (time) => t("stamp.yesterday", { time }) });
}

/**
 * The place's own words. Each namespace is read by its name, never computed: a build that ships only the namespaces
 * its sources read (the desktop's window) finds both.
 */
export function useStreamText(place: StreamPlace): Text {
  const news = useText("news");
  const receipts = useText("receipts");
  return place === "news" ? news : receipts;
}
