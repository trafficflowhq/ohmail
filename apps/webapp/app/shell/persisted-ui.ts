import { useCallback, useEffect, useState } from "react";

/**
 * UI state that must survive a reload — "saved if it's collapsed or not so ui stays as one
 * left it" (owner, on the Tags rail group).
 *
 * ── WHY LOCAL, NOT SERVER ───────────────────────────────────────────────────────────────
 *
 * This is chrome, not data. Whether a rail group is folded says nothing about the mailbox and
 * is worth neither a column, a migration, nor a request on every toggle. It is also the kind
 * of preference that is legitimately per-machine: a 13" laptop and a 27" display want
 * different answers, and syncing it would make the small screen dictate to the large one.
 *
 * ── WHY IT IS NOT SIMPLY `useState(localStorage.getItem(...))` ──────────────────────────
 *
 * Two reasons, and both are real rather than theoretical here.
 *
 * **Hydration.** The first render happens on the server, where `localStorage` does not exist.
 * Reading it in the initial state makes the server and client render different markup, which
 * React reports as a hydration mismatch and — worse — resolves by keeping the SERVER's value.
 * So the stored preference would be read and then silently discarded. The read therefore
 * happens in an effect, after mount, which is one frame of the default and then the truth.
 *
 * **Storage can refuse.** Safari in private mode throws on `setItem`, and a browser with
 * site data blocked throws on read. A preference is never worth breaking the shell over, so
 * every access is wrapped and a failure simply means the preference does not persist.
 */
export function usePersistedFlag(
  key: string,
  fallback: boolean,
): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(fallback);

  // Read AFTER mount — see the hydration note above. Runs once per key.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === "0" || raw === "1") setValue(raw === "1");
    } catch {
      /* storage blocked or unavailable — the fallback stands */
    }
  }, [key]);

  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next ? "1" : "0");
      } catch {
        /* private mode refuses writes; the toggle still works for this session */
      }
    },
    [key],
  );

  return [value, set];
}

/**
 * A CAPPED SET OF IDS UNDER ONE KEY — the store behind the dark viewer's per-message "show
 * the original (light) rendering" override.
 *
 * ── WHY ONE KEY, AND WHY CAPPED ─────────────────────────────────────────────────────────
 *
 * The alternative is a key per message, which is unbounded in a different, worse way — a
 * reader who opens ten thousand messages leaves ten thousand keys nobody ever collects. One
 * JSON array under one key is bounded to `cap` ids and evicted oldest-first, so the footprint
 * is fixed and the thing forgotten is the least surprising one (the message read longest ago).
 * An override is a viewing preference, not data: dropping the oldest one silently is fine, and
 * the message simply falls back to following the theme the next time it is opened.
 *
 * ── SAME TWO HAZARDS AS `usePersistedFlag`, HANDLED THE SAME WAY ─────────────────────────
 *
 * The read is a POST-MOUNT effect — the server has no `localStorage`, and reading it during
 * render is a hydration mismatch that resolves by keeping the server's value. And every access
 * is wrapped, because Safari private mode throws on write and a site-data-blocked browser
 * throws on read; a viewing preference is never worth breaking the surface over.
 */
const OVERRIDE_CAP = 300;

export function usePersistedIdSet(
  key: string,
  cap = OVERRIDE_CAP,
): { has: (id: string) => boolean; set: (id: string, on: boolean) => void } {
  const [ids, setIds] = useState<string[]>([]);

  // Read AFTER mount — the hydration note above. Runs once per key.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setIds(parsed.filter((x): x is string => typeof x === "string").slice(-cap));
      }
    } catch {
      /* storage blocked, or a malformed value — the empty set stands */
    }
  }, [key, cap]);

  const set = useCallback(
    (id: string, on: boolean) => {
      setIds((prev) => {
        // Re-adding moves an id to the newest slot, so eviction stays honestly oldest-first.
        const without = prev.filter((x) => x !== id);
        const next = on ? [...without, id].slice(-cap) : without;
        try {
          window.localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* private mode refuses writes; the choice still holds for this session */
        }
        return next;
      });
    },
    [key, cap],
  );

  const has = useCallback((id: string) => ids.includes(id), [ids]);
  return { has, set };
}

/**
 * ONE VALUE OUT OF A CLOSED SET — the store behind Search's result ordering.
 *
 * ── WHY A THIRD HOOK RATHER THAN `usePersistedFlag` WITH MORE STATES ────────────────────────
 *
 * The two above answer yes/no questions, and the shape of THIS one is the part that matters:
 * `allowed` is passed in and a stored value outside it is discarded, not repaired. A preference
 * naming a sort order is about to be sent to a server that REFUSES an unknown value with a 400
 * rather than quietly substituting a default, so a stale key written by a build that offered an
 * option this one no longer does must read as "no preference" — otherwise every search a
 * returning user runs fails until they clear their site data, and nothing on screen says why.
 *
 * ── SAME TWO HAZARDS AS ITS SIBLINGS, HANDLED THE SAME WAY ─────────────────────────────────
 *
 * The read is a POST-MOUNT effect (the server has no `localStorage`, and a read during the
 * hydration render is discarded as a mismatch — which would silently keep the server's default
 * and make the preference look like it never saved), and every access is wrapped, because
 * Safari private mode throws on write and a site-data-blocked browser throws on read. A refused
 * store means the choice holds for this session and no longer, which is the right failure for a
 * preference and the wrong one for anything that authorises.
 */
export function usePersistedChoice<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(fallback);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      // The membership test IS the validator — see the note above on why a stale value is
      // dropped rather than repaired.
      if (raw !== null && (allowed as readonly string[]).includes(raw)) setValue(raw as T);
    } catch {
      /* storage blocked or unavailable — the fallback stands */
    }
    // `allowed` is a module-level constant at every call site; listing it would re-run this
    // effect on every render for a caller that built the array inline, and re-reading storage
    // would stamp over a choice the user has since made in this session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        /* private mode refuses writes; the choice still holds for this session */
      }
    },
    [key],
  );

  return [value, set];
}

/**
 * Namespaced so a future preference cannot collide with an unrelated one, and so everything
 * this app stores is greppable from a single prefix.
 */
export const UI_KEYS = {
  tagsOpen: "ohmail.ui.rail.tagsOpen",
  /** The rail's Folders group — `tagsOpen`'s sibling, one flag for the whole group. */
  foldersOpen: "ohmail.ui.rail.foldersOpen",
  /**
   * The OPENED branches of the folder tree (FOLDERS-SPEC.md §15): keys are `mailboxId|path`,
   * stored through {@link usePersistedIdSet} so the default needs no seeding — a branch never
   * touched has no entry anywhere, and one the user opens stays open across sessions. Keys
   * carry the mailbox id, so two accounts sharing a browser cannot collide.
   */
  foldersOpened: "ohmail.ui.rail.foldersOpened",
  /** Ids the reader chose to view in their ORIGINAL (light) rendering, despite a dark theme. */
  mailOriginal: "ohmail.ui.mail.original",
} as const;

/**
 * The Search result order, PER ACCOUNT and per device.
 *
 * Per account because two people sharing a browser must not inherit each other's preferences —
 * the same rule `boot-cache.ts` keys on, and for a weaker reason here (an order reveals nothing)
 * but the same habit. Per device because it is chrome: this is not a fact about the mailbox, and
 * a laptop and a phone are allowed to disagree about it.
 *
 * `owner` is `storageOwner()` — the account cookie where there is one, and otherwise whatever
 * identity the HOST established for this surface (`storage-owner.ts`). It is `null` only before
 * sign-in and on a surface with genuinely no account; that case gets its own stable key rather
 * than a blank suffix — a device with no account is a real situation, not a missing value. It is
 * NOT `readOwner()`, which is null on the whole standalone desktop and so gave every mailbox on
 * an install one shared key.
 */
export function searchSortKey(owner: string | null): string {
  return `ohmail.ui.search.sort.${owner ?? "local"}`;
}
