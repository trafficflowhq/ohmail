"use client";

/**
 * THE DEVICE'S COPY OF A SERVER ANSWER THE BOOT RENDER NEEDS — per account, read at boot,
 * overwritten by every fresh answer, wiped on sign-out.
 *
 * ── THE DEFECT THIS EXISTS FOR — measured live ────────────────────────────────────────────
 *
 * The warm open paints the mirror from IndexedDB in the first frame, but the consent partition
 * (`consentPartition` — the projection that decides where every message PRESENTS) is keyed on
 * two scalars only the server holds: the account's dormancy window and its screening baseline.
 * Until `GET /consent` answered, `AppShell` rendered the piles over the RAW mirror — and the raw
 * Screener is "every sender whose mail physically sits in `ohmail/Screener`", which includes
 * every sender the user has long since decided about, because deciding writes a rule and the
 * product deliberately never moves the old mail. So every reload resurrected the same set of
 * already-handled Screener rows and held them until the consent answer landed.
 *
 * Verified by holding the consent response open on a live session: the stale rows survived
 * three completed `/sync` drains untouched, then collapsed within 100 ms of the answer
 * arriving. Sync was never the fixer; the missing partition inputs were the whole defect.
 *
 * ── THE TRUST MODEL: A CACHED ANSWER, NEVER A GUESS ───────────────────────────────────────
 *
 * The partition refuses to run on a guessed window (`AppShell`'s known-gate), and this cache
 * does not weaken that: what it stores is the account's OWN last answer, written only after a
 * real `GET /consent` (or `GET /mailboxes`) succeeded, keyed by the server-issued account id.
 * That is the same staleness class `consent-state.ts` already accepts for a second open tab —
 * the dial moves in one tab and the other keeps the old window until reload. A fresh answer
 * overwrites both the state and the cache, so a device converges on its next round trip.
 *
 * What may be cached is bounded by one rule: NOTHING THAT AUTHORISES. A cached flag must never
 * be able to spend money (`autoSuggest`) or load a sender's remote content
 * (`blockRemoteImages`); those keep their safe resting values until the live answer, and
 * `test/consent-boot-cache.test.tsx` watches that boundary.
 *
 * ── MECHANICS ─────────────────────────────────────────────────────────────────────────────
 *
 * localStorage, per the `persisted-ui.ts` rules: reads happen in post-mount effects (the server
 * renders no localStorage, and a hydration-render read is discarded as a mismatch), and every
 * access is wrapped because Safari private mode throws on write and a site-data-blocked browser
 * throws on read. A refused store simply means the next boot pays the round trip again — which
 * is exactly the pre-cache behaviour.
 *
 * Keys are namespaced `ohmail.boot.<scope>.<owner>` so two accounts on one browser can never
 * read each other's answer, and so `clearBootCaches` (sign-out) can drop everything under the
 * prefix without knowing who wrote it.
 */

const PREFIX = "ohmail.boot.";

/** The storage key for one scope of one account's cache. Exported for tests and sign-out. */
export function bootCacheKey(scope: string, owner: string): string {
  return `${PREFIX}${scope}.${owner}`;
}

/**
 * The cached answer for `owner`, or `null` — absent, unreadable, unparseable, or refused by
 * `accept`. The validator is the caller's, because the caller owns the shape: a cache written
 * by an older build must degrade to "no cache", never to a value with the wrong type in it.
 */
export function readBootCache<T>(
  scope: string,
  owner: string,
  accept: (parsed: unknown) => T | null,
): T | null {
  try {
    const raw = window.localStorage.getItem(bootCacheKey(scope, owner));
    if (raw === null) return null;
    return accept(JSON.parse(raw) as unknown);
  } catch {
    return null; // storage blocked, or a malformed value — boot proceeds as if uncached
  }
}

/** Record a fresh server answer for the next boot. A refused write costs one round trip later. */
export function writeBootCache(scope: string, owner: string, value: unknown): void {
  try {
    window.localStorage.setItem(bootCacheKey(scope, owner), JSON.stringify(value));
  } catch {
    /* private mode refuses writes — the next boot simply asks the server first again */
  }
}

/**
 * Drop EVERY boot cache on this origin — the sign-out half, called beside the mirror wipe.
 *
 * By prefix rather than by owner, deliberately: sign-out is "this browser forgets", and a cache
 * some earlier account left behind is exactly what must not survive the one act whose meaning
 * is leaving nothing behind.
 */
export function clearBootCaches(): string[] {
  return dropLocalStorageKeys([PREFIX]);
}

/**
 * Remove every `localStorage` key on this origin matching any of `prefixes`.
 *
 * Extracted from {@link clearBootCaches} because sign-out has to sweep MORE than the boot caches
 * and the sweep is the part nobody should write twice. One pass over the jar for all of them: the
 * index shifts as keys are removed, so the doomed set is collected before anything is deleted.
 *
 * An exact key is a prefix of itself, so a legacy un-owned key is passed here unchanged.
 *
 * ANSWERS THE KEYS THAT SURVIVED. See the read-back below for why `void` was not enough.
 */
export function dropLocalStorageKeys(prefixes: readonly string[]): string[] {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key !== null && prefixes.some((p) => key.startsWith(p))) doomed.push(key);
    }
    for (const key of doomed) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* one refusal must not spare the rest — the read-back below is the judge */
      }
    }
    // ── AND THE SURVIVORS ARE ANSWERED, because this sweep is not hygiene ──────────────────
    //
    // These prefixes hold MAIL: an unfinished message, a reply body, a journalled Screener
    // decision, a send lane. `void` plus a swallowing catch meant a removal that refused was
    // indistinguishable from one that worked, and `signOut` earned its clean verdict over
    // message text still readable on a shared machine. A key that is still there after this
    // is named, and the caller decides what to say about it.
    return doomed.filter((key) => {
      try {
        return window.localStorage.getItem(key) !== null;
      } catch {
        return true; // cannot be checked ⇒ cannot be claimed gone
      }
    });
  } catch {
    /* storage is entirely unavailable — nothing was ever cached there to clear */
    return [];
  }
}
