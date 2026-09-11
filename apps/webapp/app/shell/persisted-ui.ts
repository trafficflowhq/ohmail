import { useCallback, useEffect, useState } from "react";
import { durableSet } from "./durable";

/**
 * UI state that must survive a reload — "saved if it's collapsed or not so ui stays as one left
 * it" (owner, on the Tags rail group). Local, not server: this is chrome, worth neither a column
 * nor a request per toggle, and legitimately per-machine — a 13" laptop and a 27" display want
 * different answers. Not simply `useState(localStorage.getItem(...))` for two real reasons:
 * hydration — the first render happens on the server, and a mismatch resolves by keeping the
 * SERVER's value, so the stored preference would be read and silently discarded; the read happens in
 * an effect, one frame of the default and then the truth. And storage can refuse — Safari private
 * mode throws on `setItem`, a site-data-blocked browser on read — so every access is wrapped.
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
      // The toggle still works for this session; a jar that refused it says so once.
      durableSet(key, next ? "1" : "0", "ui.flag");
    },
    [key],
  );

  return [value, set];
}

/**
 * A capped set of ids under one key — the store behind the dark viewer's per-message "show the
 * original (light) rendering" override. One key, capped: a key per message is unbounded the worse
 * way (ten thousand opened messages leave ten thousand keys nobody collects); one JSON array is
 * bounded to `cap` ids, evicted oldest-first, and the thing forgotten is the least surprising one.
 * An override is a viewing preference, not data — a dropped id just follows the theme next open.
 * Same two hazards as `usePersistedFlag`, handled the same way: the read is a post-mount effect
 * (hydration keeps the server's value otherwise) and every access is wrapped (Safari private mode
 * throws on write).
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
        // The choice still holds for this session; a jar that refused it says so once.
        durableSet(key, JSON.stringify(next), "ui.idset");
        return next;
      });
    },
    [key, cap],
  );

  const has = useCallback((id: string) => ids.includes(id), [ids]);
  return { has, set };
}

/**
 * One value out of a closed set — the store behind Search's result ordering. A third hook because
 * the shape matters: `allowed` is passed in and a stored value outside it is DISCARDED, not
 * repaired. The preference is about to be sent to a server that refuses an unknown value with a 400
 * rather than substituting a default, so a stale key from a build that offered an option this one no
 * longer does must read as "no preference" — otherwise every search a returning user runs fails
 * until they clear site data, and nothing says why. Same two hazards as its siblings: post-mount
 * read (hydration) and wrapped access (Safari private mode); a refused store means the choice holds
 * for this session only, the right failure for a preference.
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
      // The choice still holds for this session; a jar that refused it says so once.
      durableSet(key, next, "ui.choice");
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
  /**
   * The three columns' widths — `{"v":1,"rail":<px>,"list":<px>}`, a field absent meaning the
   * default and the key removed when both are. Named here so everything this app stores stays
   * greppable from one prefix, but read and written by `column-store.ts`: the two widths are ONE
   * record (a reset of one must not rewrite the other), they are stamped on `<html>` before first
   * paint by a script with no React, and a drag writes at 60 Hz and persists once — none of which
   * suits a post-mount hook. Per machine, and it survives sign-out with the rail's disclosures and
   * the face pin: there is no mail in a number of pixels
   * (`test/sign-out-clears-durable-stores.test.ts` records that decision).
   */
  columns: "ohmail.ui.columns",
} as const;

/**
 * The Search result order, per account and per device. Per account because two people sharing a
 * browser must not inherit each other's preferences — the rule `boot-cache.ts` keys on, for a weaker
 * reason here but the same habit. Per device because it is chrome: a laptop and a phone may
 * disagree. `owner` is `storageOwner()` — the account cookie where there is one, otherwise whatever
 * identity the HOST established (`storage-owner.ts`); `null` only before sign-in and on a surface
 * with genuinely no account, which gets its own stable key rather than a blank suffix. NOT
 * `readOwner()`, which is null on the whole standalone desktop and gave every mailbox one shared key.
 */
export function searchSortKey(owner: string | null): string {
  return `ohmail.ui.search.sort.${owner ?? "local"}`;
}
