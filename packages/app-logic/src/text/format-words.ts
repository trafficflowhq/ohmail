/**
 * WHAT THE ROWS' WORDS ARE FORMATTED WITH, HANDED IN BY WHOEVER BUILDS THE INTL PROVIDER: the locale, the zone every
 * instant is read in, and a translator per catalogue namespace. The rows' words are a function library read from
 * reducers, callbacks and selectors, so these are a register, not a hook (the letter's body is handed its words the
 * same way). Nothing handed reads as a host's register at rest: English, the platform's own zone, no catalogue.
 */
import { liveCopyOver } from "./live-copy.js";
import type { AppLocale } from "./locale.js";
import type { Translator } from "./translator.js";

export interface FormatWords {
  /** The locale the words are in, what `Intl` is asked with. */
  readonly locale: () => AppLocale;
  /** The IANA zone every instant is read in. */
  readonly zone: () => string;
  /** The namespace's translator, or `null` where no catalogue holds it. */
  readonly translatorOf: (namespace: string) => Translator | null;
}

let words: FormatWords | null = null;

/** Hand the rows' words what they read; `null` gives the resting answers back. */
export function setFormatWords(next: FormatWords | null): void {
  words = next;
}

let platformZone: string | null = null;

/** The platform's own zone, resolved once; UTC where the platform names none. */
function platformFormatZone(): string {
  if (platformZone === null) {
    try {
      platformZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      platformZone = "UTC";
    }
  }
  return platformZone;
}

/** The locale the rows' words are in. */
export function activeFormatLocale(): AppLocale {
  return words?.locale() ?? "en";
}

/** The IANA zone every instant of the rows' words is read in. */
export function activeFormatZone(): string {
  return words?.zone() ?? platformFormatZone();
}

/** A table of English sentences as a live view of one namespace of the handed catalogue. */
export function liveCopy<T extends Record<string, unknown>>(
  namespace: string,
  english: T,
  params: Partial<Record<keyof T, readonly string[]>> = {},
): T {
  return liveCopyOver(() => words?.translatorOf(namespace) ?? null, english, params);
}
