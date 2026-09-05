/**
 * `Copy` — the accessor every screen already imports, now resolving a language per read.
 *
 * ── NOTHING ABOUT THE CALL SITES CHANGED, AND THAT IS THE POINT ───────────────────────────────
 *
 * `Copy.settings`, `Copy.doorbell(n)`, `Object.entries(Copy)` — all of them mean what they meant
 * before this file existed. The English text moved to `copy.en.ts`, German arrived in `copy.de.ts`,
 * and what stands here is a table of the SAME shape whose string members are GETTERS over whichever
 * deck the register names and whose function members forward to that deck's function.
 *
 * A property that is read on every access cannot go stale. These modules are imported at the top of
 * the graph, long before any provider renders and long before a language is chosen, so a value
 * captured at construction would be English for the life of the process. A getter has no such
 * moment — it answers English before the boot read, German after, and German again on the next
 * render, with nothing to invalidate.
 *
 * This is the webapp's `liveCopy` (`apps/webapp/app/shell/locale.ts`) with the ICU half removed:
 * there, the fallback is an English constant and the live value comes from a catalogue through
 * `createTranslator`; here both sides are ordinary TypeScript decks, so there is no ICU compiler in
 * a phone bundle and no message that can fail to parse at runtime. What ICU bought — plurals — the
 * decks do themselves, which they already did in English (`${n === 1 ? "" : "s"}`) and which German
 * does the same way, in the same two categories.
 *
 * ── ENUMERABLE, BECAUSE THE GUARDS WALK IT ────────────────────────────────────────────────────
 *
 * `test/copy-tails.test.ts` reads `Object.entries(Copy)` to hold every tail sentence to its shape
 * and `test/doors.test.ts` reads `Object.keys(Copy)` to assert a retired key is gone. Both keep
 * working because the getters are defined `enumerable` and the function members are plain
 * assignments. A non-enumerable accessor would have made those two guards silently pass over
 * everything.
 *
 * ── AND THERE IS NO PER-KEY FALLBACK, DELIBERATELY ────────────────────────────────────────────
 *
 * The webapp fills a missing German key from English at load time, because its catalogues are JSON
 * that nothing type-checks. Here the German deck is typed `Deck`: a key it does not hold is a
 * compile error, so the case that fallback exists for cannot reach a build. Adding one anyway would
 * mean an untranslated string could ship quietly, which is the exact failure the type is preventing.
 */

import { EN, type Deck } from "./copy.en";
import { DE } from "./copy.de";
import { activeLocale, type AppLocale } from "./i18n/locale";
import { isStoreFault } from "./state/servers";

export type { Deck };

/**
 * Every deck this build carries, by locale. Held against `LOCALES` by `test/locale.test.ts`, so a
 * locale added to the closed set without a deck fails there rather than answering `undefined` for
 * every string on somebody's phone.
 */
export const DECKS: Record<AppLocale, Deck> = { en: EN, de: DE };

type AnyDeck = Record<string, string | ((...args: never[]) => string)>;

function liveDeck(): Deck {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(EN)) {
    if (typeof (EN as unknown as AnyDeck)[key] === "function") {
      out[key] = (...args: never[]): string => {
        const member = (DECKS[activeLocale()] as unknown as AnyDeck)[key];
        return (member as (...a: never[]) => string)(...args);
      };
      continue;
    }
    Object.defineProperty(out, key, {
      enumerable: true,
      get(): string {
        return (DECKS[activeLocale()] as unknown as AnyDeck)[key] as string;
      },
    });
  }
  return out as Deck;
}

export const Copy: Deck = liveDeck();

/**
 * THE DETAIL INSIDE A TRANSLATED REFUSAL — our own failures worded, everything else quoted.
 *
 * The nine places that render a caught error used `String(err)`, which is right for a platform
 * exception and wrong for a failure this app authored: an English sentence ends up inside a German
 * one. A {@link StoreFault} carries a code, so it becomes language here; anything else is the
 * platform's own words and stays exactly as they are, because a paraphrase would be worse for
 * whoever has to search for the text.
 */
export function faultDetail(err: unknown): string {
  return isStoreFault(err) ? Copy.storeFault(err.code) : String(err);
}
