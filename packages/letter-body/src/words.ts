/**
 * THE BODY'S WORDS, HANDED IN BY WHOEVER MOUNTS IT. The body renders bare in many tests and reads
 * its sentences from module-level tables, so its words are a register, not a hook: the host that
 * builds the intl provider hands the locale and a translator per namespace here, in the same place.
 * Nothing handed means English, and the format locale "en".
 */
import { liveCopyOver } from "@ohmail/app-logic/text/live-copy";
import type { Translator } from "@ohmail/app-logic/text/translator";

/** The catalogue namespaces the body reads. */
export type BodyNamespace = "mailBody" | "bodyText";

export interface BodyWords {
  /** The locale the sentences are in: the ask page's `lang`. */
  readonly locale: string;
  /** The namespace's translator, or `null` where the catalogue has none. */
  readonly translatorOf: (namespace: BodyNamespace) => Translator | null;
}

let words: BodyWords | null = null;

/** Hand the body its words; `null` gives English back. */
export function setBodyWords(next: BodyWords | null): void {
  words = next;
}

/** The locale the body's words are in. */
export function bodyFormatLocale(): string {
  return words?.locale ?? "en";
}

/** A table of English sentences as a live view of one namespace of the handed words. */
export function bodyCopy<T extends Record<string, unknown>>(
  namespace: BodyNamespace,
  english: T,
  params: Partial<Record<keyof T, readonly string[]>> = {},
): T {
  return liveCopyOver(() => words?.translatorOf(namespace) ?? null, english, params);
}
