/**
 * THE LOCALE DIMENSION ON THE PHONE — the closed set, the device's answer, and the one register
 * every surface reads.
 *
 * The web and desktop clients resolve a locale through `next-intl` and a pair of ICU catalogues
 * (`apps/webapp/app/shell/locale.ts`). This app cannot: it has no next-intl, no RSC payload to
 * carry a catalogue on, and no `localStorage` for a host to read before the first paint. What it
 * has instead is what this file is built on — one JS bundle, a device whose language the platform
 * already knows, and a copy deck that is a TypeScript object rather than a JSON tree.
 *
 * So the SHAPE is the webapp's and the MEDIUM is not:
 *
 *  · the closed set of locales, English as the fallback, and a primary-subtag reduction, all
 *    written the same way and holding the same rules — `de-CH`, `de-DE` and `de` are one deck;
 *  · a module-level register rather than a hook, for the same reason the webapp has one: the copy
 *    is read from places that are not components at all (`state/live.ts` derives a view inside a
 *    memo, `state/model.ts` is a plain function library), and threading a locale through those is
 *    ten signatures where this is one;
 *  · and a SUBSCRIPTION beside it, which the webapp does not need. There, swapping the catalogue
 *    means re-rendering a provider that owns the messages; here the deck is reached through a
 *    module import, so nothing in React knows a switch happened unless it is told. See
 *    {@link subscribeLocale}.
 *
 * ── WHERE THE DEVICE'S OWN ANSWER COMES FROM, AND WHY IT IS NOT A NEW DEPENDENCY ──────────────
 *
 * `expo-localization` is the usual answer and this app does not carry it. It does not need to:
 * `Intl.DateTimeFormat().resolvedOptions().locale` is the platform's resolved language, and this
 * app ALREADY reads the sibling field off the same call — `state/live.ts#readerZone` takes
 * `.timeZone` from it to stamp every mail time in the reader's zone. One call, two fields, no new
 * package in a bundle that ships to a phone.
 *
 * It is wrapped, because an environment with no ICU data at all throws rather than answering, and
 * a language preference is not worth a crash on boot. That arm returns `null` — "the device says
 * nothing" — which is a different answer from "the device says English", and {@link resolveLocale}
 * treats it as such.
 */

/**
 * THE CLOSED SET, and it is closed in the same four places the webapp's is — here, the CHECK on
 * `account_settings.locale`, the wire validation in `PATCH /consent/settings`, and the selector in
 * Settings. `test/locale.test.ts` holds this array against the decks that exist in `copy.ts`, so
 * adding a member without adding a deck fails here rather than rendering `undefined` on a phone.
 */
export const LOCALES = ["en", "de"] as const;

export type AppLocale = (typeof LOCALES)[number];

/**
 * ENGLISH IS THE FALLBACK, not merely the default — the same distinction the webapp draws, and it
 * matters at the same two layers: nobody has chosen ⇒ English, and a device whose language this
 * app does not speak ⇒ English rather than a half-rendered deck.
 *
 * Typed as the LITERAL rather than as `AppLocale`, matching the webapp's, so a consumer that
 * subtracts it (`Exclude<AppLocale, typeof DEFAULT_LOCALE>`) gets `"de"` and not `never`.
 */
export const DEFAULT_LOCALE = "en" satisfies AppLocale;

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Reduce anything to a member of {@link LOCALES}, or `null` for "this says nothing".
 *
 * The PRIMARY SUBTAG only: a phone set to `de-CH` or `de-AT` gets the German deck rather than
 * falling through to English on a tag it happens not to match exactly. Case is folded because a
 * platform locale arrives in either (`de_DE` from Android's `Configuration`, `de-DE` from `Intl`),
 * and the separator may be either too.
 *
 * `null` rather than {@link DEFAULT_LOCALE}, and that is the whole point of the return type: the
 * caller has to tell "nobody has said" from "they said English", because the first keeps looking
 * at the next source and the second stops.
 */
export function normalizeLocale(value: string | null | undefined): AppLocale | null {
  if (typeof value !== "string") return null;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return isAppLocale(primary) ? primary : null;
}

/**
 * WHAT LANGUAGE THIS PHONE IS SET TO, reduced to a deck this app has — or `null` for "it did not
 * say, or it said something ohmail does not speak".
 *
 * Not cached. It is read on boot and whenever the stored override is cleared, which is twice in a
 * session at most, and a phone's language CAN change under a running app (Android applies a
 * system-language change to a live process). A cached first answer would leave the app speaking
 * the previous language until it was killed.
 */
export function deviceLocale(): AppLocale | null {
  try {
    return normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    /* No ICU data. The platform cannot name its own language, so nothing is known about it —
       which is exactly `null`, and the caller falls back to English. */
    return null;
  }
}

/**
 * THE ORDER, in one place so both the boot path and the Settings row agree.
 *
 * An explicit choice OUTRANKS the device, which is the whole reason the override exists: somebody
 * whose phone is in English and who wants ohmail in German has said so, and a later re-read of the
 * device must not overrule them. With no choice stored the device governs, and with the device
 * silent (or set to a language this app does not speak) it is English.
 */
export function resolveLocale(
  chosen: AppLocale | null, fromDevice: AppLocale | null = deviceLocale(),
): AppLocale {
  return chosen ?? fromDevice ?? DEFAULT_LOCALE;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE REGISTER — one live answer, and the subscription that makes a switch visible.

   `Copy` in `src/copy.ts` is a table of GETTERS over whichever deck this register names, so every
   one of the ~300 call sites is already reading the current language with no change to any of
   them. What a getter cannot do is tell React that its answer changed: a screen that rendered
   "Settings" holds an element tree React has no reason to rebuild.

   So the register publishes. `useLocale()` (see `LocaleProvider.tsx`) subscribes through
   `useSyncExternalStore`, and a screen that calls it re-renders — with its children, which are
   rebuilt as part of the same render — on the press that changed the language. That is why the
   listener set lives HERE rather than in the provider: `setActiveLocale` is called from the boot
   path before any provider has mounted, and from the Settings row after, and both have to reach
   the same subscribers.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

let active: AppLocale = DEFAULT_LOCALE;
const listeners = new Set<() => void>();

/** The language every deck read resolves against right now. */
export function activeLocale(): AppLocale {
  return active;
}

/**
 * Point the register at a language. Synchronous, and it has to be: the boot path calls it before
 * the first screen renders, so the first paint after a launch already carries the right deck.
 *
 * A no-op when nothing changes — a redundant notify would re-render every subscribed screen on
 * every boot read that confirmed what was already true.
 */
export function setActiveLocale(next: AppLocale): void {
  if (next === active) return;
  active = next;
  for (const listener of [...listeners]) listener();
}

/** Subscribe to switches. Returns the unsubscribe, which is `useSyncExternalStore`'s contract. */
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Put the register back to English with nobody listening — the reset a test needs between cases,
 * and nothing else. Exported rather than reached through `setActiveLocale` because the listener
 * set is module state too: a test that mounted a provider and unmounted it would otherwise leave a
 * dead subscriber behind for the next one.
 */
export function resetLocaleRegisterForTests(): void {
  active = DEFAULT_LOCALE;
  listeners.clear();
}
