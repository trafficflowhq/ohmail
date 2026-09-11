/**
 * The locale dimension on the phone — the closed set, the device's answer, and the one
 * register every surface reads. The shape is the webapp's, the medium is not: the closed set,
 * English fallback and a primary-subtag reduction hold the same rules; a module-level register
 * rather than a hook, because the copy is read from places that are not components; and a
 * subscription beside it, because the deck is reached through a module import and React must
 * be told a switch happened ({@link subscribeLocale}). The device's answer is
 * `Intl.DateTimeFormat().resolvedOptions().locale` — no expo-localization. Wrapped: no ICU
 * throws, answering `null` ("says nothing") — different from "says English".
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
 * Reduce anything to a member of {@link LOCALES}, or `null` for "this says nothing". The
 * primary subtag only: a phone set to `de-CH` or `de-AT` gets the German deck rather than
 * falling through to English on a tag it happens not to match exactly. Case and separator are
 * folded (`de_DE` from Android, `de-DE` from `Intl`). `null` rather than
 * {@link DEFAULT_LOCALE} is the whole point of the return type: the caller must tell "nobody
 * has said" from "they said English" — the first keeps looking, the second stops.
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

/* The register — one live answer, and the subscription that makes a switch visible. `Copy` is
   a table of getters over whichever deck this register names, so every call site already reads
   the current language; what a getter cannot do is tell React its answer changed. So the
   register publishes: `useLocale()` subscribes through `useSyncExternalStore`, and a screen
   that calls it re-renders on the press that changed the language. The listener set lives here
   rather than in the provider because `setActiveLocale` is called from the boot path before
   any provider has mounted, and from the Settings row after — both reach the same subscribers. */

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
