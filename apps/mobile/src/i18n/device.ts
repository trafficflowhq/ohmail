/**
 * WHAT THIS DEVICE IS CALLED. The decks say "this phone" in 270-odd places, and on an iPad every
 * first-run, organizer and sidebar sentence named a phone. The decks keep one noun;
 * on an iPad the live deck (`copy.ts`) reads each sentence through {@link deviceNoun}. The device is
 * set once at the root (`app/_layout.tsx`), so this module loads in a node test with no platform.
 * "iPhone" is a different word and is never touched.
 */
import type { AppLocale } from "./locale";

let pad = false;

export function setPadDevice(isPad: boolean): void {
  pad = isPad;
}

export function isPadDevice(): boolean {
  return pad;
}

/** The sentence with the phone named as an iPad; the same string where there is no phone in it. */
export function deviceNoun(text: string, locale: AppLocale): string {
  if (locale === "de") {
    return text.replace(/\b(Telefon|Handy)s\b/g, "iPads").replace(/\b(Telefon|Handy)\b/g, "iPad");
  }
  return text
    .replace(/\b([Aa]) phone\b(?!s)/g, "$1n iPad")
    .replace(/(?<![A-Za-z])phone\b(?!s)/g, "iPad")
    .replace(/(?<![A-Za-z])Phone\b(?!s)/g, "iPad");
}
