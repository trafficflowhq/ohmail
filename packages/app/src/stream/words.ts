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

const RECEIPT_TOTAL =
  /^[ \t]*(?:grand total|order total|total(?: paid)?|amount paid|gesamtbetrag|endbetrag|totalbetrag|betrag bezahlt)[ \t]*:?[ \t]*((?:CHF|EUR|USD|GBP)[ \u00a0]+(?:\d{1,3}(?:[ '’.,]\d{3})+|\d+)[.,]\d{2})[ \t]*$/gim;

/** Show one explicitly stated total from the receipt text already available to the preview. */
export function receiptAmount(message: EngineMessage, text: string | null): string | undefined {
  if (message.amount) return message.amount;
  const totals = new Set(
    Array.from((text ?? message.snippet ?? "").matchAll(RECEIPT_TOTAL), (match) =>
      match[1]!.replace(/\s+/g, " "),
    ),
  );
  return totals.size === 1 ? totals.values().next().value : undefined;
}
