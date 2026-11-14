import { useCallback, useMemo } from "react";
import type { PaneLine } from "@ohmail/app-logic/mailboxes/pane/lines";
import type { PaneSaid } from "@ohmail/app-logic/mailboxes/pane/organizer";
import type { Say } from "@ohmail/app-logic/mailboxes/pane/said";
import { stampsOf, type Stamps } from "@ohmail/app-logic/mailboxes/pane/stamps";
import { useLocale, useText, useTextLookup, useTimeZone } from "../../text/index.js";

/**
 * The namespaces the pane reads: its own, the sync's closed set, the provider's label, the filings' words and the time's
 * young arm; and the second factor's one sentence (`devices.stepUpExpired`), read by name as the connect form reads it.
 * A shell that mounts the pane ships them all.
 */
export const PANE_NAMESPACES = [
  "mailboxes",
  "devices",
  "sync",
  "providerPicker",
  "relativeTime",
  "mailboxFilings",
] as const;

/** A sentence of the pane's catalogues, said: `mailboxes` unless it names another. */
export function useSay(): Say {
  const lookup = useTextLookup();
  return useCallback((s: PaneSaid) => lookup(s.ns ?? "mailboxes")(s.key, s.values), [lookup]);
}

/** A line: the catalogue's sentence, or the server's own words. */
export function useLine(): (line: PaneLine) => string {
  const say = useSay();
  return useCallback((line: PaneLine) => ("server" in line ? line.server : say(line.said)), [say]);
}

/** The times, in the reader's language and zone. */
export function useStamps(): Stamps {
  const locale = useLocale();
  const timeZone = useTimeZone();
  const relative = useText("relativeTime");
  const justNow = relative("justNow");
  return useMemo(() => stampsOf(locale, timeZone, justNow), [justNow, locale, timeZone]);
}

/** A count as the reader's language writes it. */
export function useFigure(): (n: number) => string {
  const locale = useLocale();
  return useMemo(() => {
    const format = new Intl.NumberFormat(locale);
    return (n: number) => format.format(n);
  }, [locale]);
}
