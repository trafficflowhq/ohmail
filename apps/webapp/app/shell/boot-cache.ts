"use client";

/**
 * The device's copy of a server answer the boot render needs — per account, read at boot,
 * overwritten by every fresh answer, wiped on sign-out. The warm open paints the mirror in the
 * first frame, but `consentPartition` is keyed on two scalars only the server holds (the dormancy
 * window, the screening baseline); until `GET /consent` answered, the piles rendered over the RAW
 * mirror — and the raw Screener includes every sender long since decided about, because deciding
 * writes a rule and never moves old mail. Verified live: the stale rows survived three completed
 * `/sync` drains untouched, then collapsed within 100 ms of the consent answer. Sync was never the
 * fixer; the missing partition inputs were the whole defect.
 */

/**
 * A cached ANSWER, never a guess: what is stored is the account's own last answer, written only after a real `GET
 * /consent` (or `GET /mailboxes`) succeeded, keyed by the server-issued account id — the staleness class
 * `consent-state.ts` already accepts for a second tab. Bounded by one rule: NOTHING THAT AUTHORISES — a cached flag
 * must never spend money (`autoSuggest`) or load a sender's remote content (`blockRemoteImages`); those keep their
 * safe resting values until the live answer (`test/consent-boot-cache.test.tsx` watches the boundary).
 */

/**
 * Mechanics: localStorage per the `persisted-ui.ts` rules (post-mount reads, wrapped access); a refused store means
 * the next boot pays the round trip again. Keys are `ohmail.boot.<scope>.<owner>`, so two accounts never read each
 * other's answer and `clearBootCaches` can drop the prefix blind.
 */

import { durableSet } from "./durable";

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

/**
 * Record a fresh server answer for the next boot. A refused write costs one round trip later —
 * nothing is lost — but it goes through the durable door all the same, because the jar that
 * refused a cache is the jar about to refuse a decision.
 */
export function writeBootCache(scope: string, owner: string, value: unknown): void {
  durableSet(bootCacheKey(scope, owner), JSON.stringify(value), "boot.cache");
}

/**
 * Drop EVERY boot cache on this origin — the sign-out half, called beside the mirror wipe.
 *
 * By prefix rather than by owner, deliberately: sign-out is "this browser forgets", and a cache
 * some earlier account left behind is exactly what must not survive the one act whose meaning
 * is leaving nothing behind.
 */
export function clearBootCaches(): LocalSweep {
  return dropLocalStorageKeys([PREFIX]);
}

/**
 * What a prefix sweep can honestly say. `survivors` are the matched keys still present;
 * `enumerated` is whether the jar could be walked AT ALL — a browser that refused proves
 * nothing by naming no survivors.
 */
export interface LocalSweep {
  survivors: string[];
  enumerated: boolean;
}

/**
 * Remove every `localStorage` key on this origin matching any of `prefixes`. Extracted from {@link clearBootCaches}
 * because sign-out has to sweep MORE than the boot caches and the sweep is the part nobody should write twice. One
 * pass over the jar for all of them: the index shifts as keys are removed, so the doomed set is collected before
 * anything is deleted. An exact key is a prefix of itself, so a legacy un-owned key is passed here unchanged. ANSWERS
 * THE KEYS THAT SURVIVED. See the read-back below for why `void` was not enough.
 */
export function dropLocalStorageKeys(prefixes: readonly string[]): LocalSweep {
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
    const survivors = doomed.filter((key) => {
      try {
        return window.localStorage.getItem(key) !== null;
      } catch {
        return true; // cannot be checked ⇒ cannot be claimed gone
      }
    });
    return { survivors, enumerated: true };
  } catch {
    /**
     * ── AN UNREADABLE JAR IS NOT AN EMPTY ONE ────────────────────────────────────────────
     *
     * This returned `[]`, which the caller read as "nothing survived" — so a browser that
     * refused to enumerate `localStorage` during a sign-out certified a clean browser while
     * every draft, reply body and journalled decision sat there untouched, readable again the
     * moment storage came back. The comment even said "nothing was ever cached there", which
     * is a claim about a jar this call could not open.
     *
     * `enumerated: false` says what actually happened, and the caller refuses to call the
     * browser clean on it.
     */
    return { survivors: [], enumerated: false };
  }
}
