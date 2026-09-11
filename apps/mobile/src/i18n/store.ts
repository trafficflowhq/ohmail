/**
 * Where the language choice is kept on a phone — the keystore. The appearance preferences are memory-only on
 * purpose (the account's synced face restores them); language has nothing on the other side to restore it
 * from, and forgetting it would mean German-on-an-English-phone met English every morning. The medium is the
 * one durable KV this app already has: `expo-secure-store` through the same {@link SecureKV} seam
 * `state/servers.ts` uses — the 2 KB size objection does not apply to a two-byte value. Residuals, written
 * down: an iOS Keychain item outlives deleting the app, so a reinstall opens in the previous language (a
 * surprise, undone in one press — the purge is not widened to cover a display preference); a keystore read
 * needs the device unlocked, and a locked read is `null` — the device's own language, not a failure.
 */
import { isAppLocale, normalizeLocale, type AppLocale } from "./locale";
import type { SecureKV } from "../state/servers";

/**
 * The one key. Namespaced like the pairing store's, so a reader of the keystore can tell whose it
 * is, and named for what it holds rather than for the screen that writes it.
 */
export const LOCALE_KEY = "ohmail.locale";

/**
 * The stored OVERRIDE, or `null` for "this device has chosen nothing".
 *
 * `null` covers three states that a caller treats identically — never written, written and then
 * cleared, or a store that would not answer — because all three mean the same thing: the device's
 * own language governs. A stored value this build does not recognise (a locale removed from
 * {@link LOCALES} in a later version, a corrupted write) reads as `null` too, rather than throwing
 * a launch away over a display preference.
 */
export async function readStoredLocale(kv: SecureKV): Promise<AppLocale | null> {
  try {
    return normalizeLocale(await kv.get(LOCALE_KEY));
  } catch {
    return null;
  }
}

/**
 * Persist the choice, or clear it with `null` — "follow this phone". Rejects when the store
 * refuses, deliberately: the Settings row awaits this and reports a failure rather than
 * showing a language that will be gone on the next launch — the webapp's language row keeps
 * the same contract ("resolve to what the database holds, never to what the click hoped
 * for"); a preference that silently did not save is exactly the failure a person cannot
 * report. A value that is not a locale this build speaks is refused before it reaches the
 * store, so a caller cannot write something `readStoredLocale` would then discard.
 */
export async function writeStoredLocale(kv: SecureKV, next: AppLocale | null): Promise<void> {
  if (next === null) {
    await kv.remove(LOCALE_KEY);
    return;
  }
  if (!isAppLocale(next)) throw new Error(`not a language this app speaks: "${String(next)}"`);
  await kv.set(LOCALE_KEY, next);
}
