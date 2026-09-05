/**
 * WHERE THE LANGUAGE CHOICE IS KEPT ON A PHONE — and why it is the keystore.
 *
 * ── THE CHOICE HAD TO BE MADE, BECAUSE THE PHONE'S OTHER PREFERENCES ARE NOT KEPT AT ALL ──────
 *
 * `state/store.tsx` holds the appearance preferences in memory on purpose, and says so: a relaunch
 * returns the scheme to "system" and drops the face pin, after which the ACCOUNT's synced face
 * governs again. That argument is sound for the face and does not carry to language, for one
 * reason — there is nothing on the other side to restore it from. The face arrives on every boot's
 * `GET /consent`; a language chosen here is chosen HERE, and forgetting it on relaunch would mean a
 * person who set ohmail to German on an English phone met English again every morning.
 *
 * ── AND THE MEDIUM IS THE ONE DURABLE KEY-VALUE STORE THIS APP ALREADY HAS ────────────────────
 *
 * `expo-secure-store`, through the same two-method {@link SecureKV} seam `state/servers.ts` uses,
 * bound by `state/servers-native.ts`. No new dependency, no new platform seam, and the node suite
 * drives it through the memory double it already drives every pairing test through.
 *
 * The keystore's own header calls itself "a keystore, not a database", and that objection is about
 * SIZE — iOS warns past 2 KB per value and a pairing blob would cross it. This value is two bytes.
 * Nothing here is secret, and nothing about the store makes a non-secret wrong to put in it: it is
 * an encrypted KV whose contents are readable by this app alone.
 *
 * ── TWO RESIDUALS, WRITTEN DOWN RATHER THAN LEFT TO BE FOUND ──────────────────────────────────
 *
 *  · **On iPhone and iPad a Keychain item outlives deleting the app** — the asymmetry
 *    `state/install-marker.ts` exists for. So a reinstalled app opens in the language the previous
 *    install chose. For a pairing that is a security defect and the marker purges it; for a display
 *    preference it is at worst a surprise, and the Settings row undoes it in one press. The purge
 *    is deliberately NOT widened to cover this key: it runs before anything is read, and taking a
 *    person's language away as part of a credential sweep would be a second, unrelated act.
 *  · **A keystore read needs the device unlocked** (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`, which is what
 *    keeps this out of every cloud and computer backup). A launch from a locked device reads
 *    nothing, which is {@link readStoredLocale}'s `null` — the device's own language, not a
 *    failure. In practice a launch follows an unlock.
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
 * Persist the choice, or clear it with `null` — "follow this phone".
 *
 * REJECTS when the store refuses, and that is deliberate: the Settings row awaits this and reports
 * a failure rather than showing a language that will be gone on the next launch. The webapp's
 * language row keeps the same contract for the same reason ("resolve to what the database holds,
 * never to what the click hoped for"); a preference that silently did not save is exactly the
 * failure a person cannot report.
 *
 * A value that is not a locale this build speaks is refused before it reaches the store, so a
 * caller cannot write something `readStoredLocale` would then discard.
 */
export async function writeStoredLocale(kv: SecureKV, next: AppLocale | null): Promise<void> {
  if (next === null) {
    await kv.remove(LOCALE_KEY);
    return;
  }
  if (!isAppLocale(next)) throw new Error(`not a language this app speaks: "${String(next)}"`);
  await kv.set(LOCALE_KEY, next);
}
