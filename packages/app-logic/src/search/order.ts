/**
 * Ordering the device's first paint under the chosen sort, so the top moves the moment the order
 * does; the store's page, which the store orders, then replaces it. `mailbox` is the one order this
 * client cannot compute — a message carries `mailboxId`, never the address — so over the device's
 * rows it degrades to date order, the store's answer being the one that orders by address.
 */
import { useMemo } from "react";
import {
  SERVER_SEARCH_SORTS,
  type EngineMessage,
  type SearchHit,
  type ServerSearchSort,
} from "@ohmail/client-engine";
import type { StorageScope } from "../storage/scope.js";
import { searchSortKey, usePersistedChoice } from "../storage/persisted-ui.js";

type SortRank = ReadonlyMap<string, number>;
const NO_RANK: SortRank = new Map();

/** Millis for ordering; a message with no `Date:` header sorts last in both directions. */
function stampOf(m: EngineMessage): number | null {
  if (!m.date) return null;
  const t = Date.parse(m.date);
  return Number.isFinite(t) ? t : null;
}

/** `a` before `b` by date, `dir` 1 for ascending. Undated always last, never first. */
function byDate(a: EngineMessage, b: EngineMessage, dir: 1 | -1): number {
  const ta = stampOf(a);
  const tb = stampOf(b);
  if (ta === null && tb === null) return 0;
  if (ta === null) return 1;
  if (tb === null) return -1;
  return (ta - tb) * dir;
}

/** The displayed order for one sort. `relevance` returns the device's own ranking UNTOUCHED. */
export function orderHits(
  items: readonly SearchHit[],
  sort: ServerSearchSort,
  mailboxRank: SortRank = NO_RANK,
): readonly SearchHit[] {
  if (sort === "relevance") return items;
  // `toSorted` is not available on every target this bundle supports; copy first so the memo
  // input is never mutated in place (React would not see the change, and the next render would
  // sort an already-sorted array — stable, but only by luck).
  const out = [...items];
  out.sort((x, y) => {
    const a = x.message;
    const b = y.message;
    if (sort === "date_desc") return byDate(a, b, -1) || a.id.localeCompare(b.id);
    if (sort === "date_asc") return byDate(a, b, 1) || a.id.localeCompare(b.id);
    if (sort === "sender") {
      const cmp = a.from.address.toLowerCase().localeCompare(b.from.address.toLowerCase());
      // Newest-first WITHIN a sender: address-major with arbitrary dates inside a block is not
      // a list anybody reads. Matches the server arm's own tiebreak.
      return cmp || byDate(a, b, -1) || a.id.localeCompare(b.id);
    }
    // mailbox — see the note above on why this is a rank and not a comparison of addresses.
    const ra = mailboxRank.get(a.mailboxId) ?? Number.MAX_SAFE_INTEGER;
    const rb = mailboxRank.get(b.mailboxId) ?? Number.MAX_SAFE_INTEGER;
    return ra - rb || byDate(a, b, -1) || a.id.localeCompare(b.id);
  });
  return out;
}

/**
 * The order, remembered per scope and per device, under the scope the host hands in (none: for the mount only).
 * Deliberately NOT a server setting: chrome, legitimately per-machine, and the alternative costs a column, a migration
 * and a request per dropdown change.
 */
export function useSearchSort(
  scope: StorageScope | false,
  /** No words are asked: the store answers best match and newest only. */
  wordless: boolean,
): [ServerSearchSort, (sort: ServerSearchSort) => void] {
  /* No scope names no key: the order is read and written nowhere (`local` is never spelled for want of one). */
  const key = useMemo(() => (scope === false ? null : searchSortKey(scope)), [scope]);
  const [kept, setSort] = usePersistedChoice<ServerSearchSort>(key, SERVER_SEARCH_SORTS, "relevance");
  /* Any other kept order asks best match with no words, and stays kept. */
  return [wordless && kept !== "date_desc" ? "relevance" : kept, setSort];
}
