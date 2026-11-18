/**
 * The Ohbox's session placement: the order of its two upper groups for this visit, reconciled at render against
 * what the selector files, and the explicit way back into New for a row marked unread.
 */
import type { EngineMessage } from "@ohmail/wire";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ResurfacedThreadRow } from "@ohmail/client-engine";
import { createUnreadHold, type UnreadHold } from "../reading/reader-seen.js";
import type { OhboxListInput } from "./types.js";

/**
 * The stable merge: where a fresh id enters the session order — before the first kept row the
 * selector ranks after it (for New: date desc, so a genuinely new arrival enters at the top), at
 * the end when none. A merge, not a re-sort: kept rows never move relative to each other, and an
 * OLD unread arrival (a backfill, a foreign mark-unread) files at its date slot. The rank is the
 * id's index in `current`, the selector's own output — an explicit unread included, which is
 * therefore at its arrival place on every surface at once. A dismissal is spent when the selector
 * stops filing the row under "Earlier" (`dropped`) — a permanent one would swallow the way back
 * for mail marked unread elsewhere.
 */
export function reconcile(
  prev: string[],
  current: EngineMessage[],
  byId: ReadonlyMap<string, EngineMessage>,
  dropped: (id: string) => boolean,
): string[] {
  const keep = prev.filter((id) => byId.has(id) && !dropped(id));
  const have = new Set(keep);
  const rank = new Map(current.map((m, i) => [m.id, i]));
  const fresh: string[] = [];
  for (const m of current) {
    if (dropped(m.id) || have.has(m.id)) continue;
    have.add(m.id);
    fresh.push(m.id);
  }
  if (fresh.length === 0) return keep;
  /**
   * One pass, not one scan per fresh id: the naive splice is
   * O(kept × fresh), maximised by the most ordinary case — a cold mount,
   * where every id is fresh and a large unread group costs millions of
   * rank lookups inside a render. A two-pointer merge is equivalent
   * because the anchor is monotonic: `fresh` ascends in rank, so "the
   * first kept row with rank > r" only moves down the list as r grows,
   * and a kept row skipped for one fresh id is skipped for every later
   * one. Nothing is revisited.
   */
  const merged: string[] = [];
  let ki = 0;
  for (const id of fresh) {
    const r = rank.get(id)!;
    while (ki < keep.length) {
      const kr = rank.get(keep[ki]!);
      if (kr !== undefined && kr > r) break;
      merged.push(keep[ki]!);
      ki += 1;
    }
    merged.push(id);
  }
  for (; ki < keep.length; ki += 1) merged.push(keep[ki]!);
  return merged;
}

/**
 * Record an explicit "this is unread again" for one or more ids. The slide timer is torn up and
 * `settling` comes off, so a row caught mid-descent stops where it is; and it leaves `dismissed`,
 * so a completed slide cannot keep filtering it out of New. WHERE it re-enters is not decided
 * here: `reconcile` merges it at the selector's arrival rank, so the surface that pressed and every
 * surface that received the change list it in one place (leading New with it kept the pressing
 * surface disagreeing with every other for the rest of the session). The ids are held unread for
 * the visit.
 */
export function useReturnToNew(
  unreadHold: UnreadHold,
  slideTimers: MutableRefObject<Map<string, ReturnType<typeof setTimeout>>>,
  setSettling: Dispatch<SetStateAction<Set<string>>>,
  setDismissed: Dispatch<SetStateAction<Set<string>>>,
): (ids: readonly string[]) => void {
  return useCallback(
    (ids: readonly string[]) => {
      unreadHold.add(ids);
      for (const id of ids) {
        const timer = slideTimers.current.get(id);
        if (timer === undefined) continue;
        clearTimeout(timer);
        slideTimers.current.delete(id);
      }
      setSettling((prev) => {
        if (!ids.some((id) => prev.has(id))) return prev;
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      setDismissed((prev) => {
        if (!ids.some((id) => prev.has(id))) return prev;
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    },
    [unreadHold, slideTimers, setSettling, setDismissed],
  );
}

/** No pinned rows: one value, so a host that hands none keeps every memo over them. */
export const NO_ROWS: ResurfacedThreadRow[] = [];

/** What the placement hands the rest of the list: the groups as displayed, and the slide's state and orders. */
export interface SessionPlacement {
  settling: Set<string>;
  setSettling: Dispatch<SetStateAction<Set<string>>>;
  setDismissed: Dispatch<SetStateAction<Set<string>>>;
  slideTimers: MutableRefObject<Map<string, ReturnType<typeof setTimeout>>>;
  unreadHold: UnreadHold;
  returnToNew: (ids: readonly string[]) => void;
  byId: Map<string, EngineMessage>;
  earlierIds: Set<string>;
  resurfacedOrder: MutableRefObject<string[]>;
  newOrder: MutableRefObject<string[]>;
  displayResurfaced: EngineMessage[];
  displayNew: EngineMessage[];
  displayPrev: EngineMessage[];
}

export function useSessionPlacement(input: OhboxListInput): SessionPlacement {
  const { resurfacedRows = NO_ROWS, newForYou, previouslySeen } = input;
  /**
   * Session-scoped placement, and the slide that ends it. Two refs, one per pinned upper group, reconciled at
   * render (the value must be right for the render that reads it): a row keeps its slot; a live arrival INSERTS
   * at the selector's slot — the top for genuinely new mail (appending filed every post-mount arrival at the
   * bottom; reported). A read message leaves "New for you" NOW — keeping read rows made a read mailbox look
   * unread all session: the moment the selector re-files a row it slides (`SETTLE_MS`) and `dismissed` releases
   * its slot. The one unmoved row is the message being read — its place is held until the reader leaves or answers
   * it ({@link armRead}). {@link returnToNew} is the reverse move: an explicit mark-unread cancels a slide in flight
   * and re-enters New at its ARRIVAL place, exactly where a surface that only received the change puts it.
   */
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [settling, setSettling] = useState<Set<string>>(() => new Set());
  /**
   * EVERY MESSAGE THE PINNED BLOCK STANDS FOR — the rows' members, flattened. The session order,
   * the slide and `upper` all work per MESSAGE (a member is released one at a time), so the rows
   * are folded back at render; deriving this here rather than taking it as a second prop keeps
   * one answer to "which messages are up there".
   */
  const resurfaced = useMemo(() => resurfacedRows.flatMap((r) => r.members), [resurfacedRows]);
  const resurfacedOrder = useRef<string[]>([]);
  const newOrder = useRef<string[]>([]);
  /** Slides in flight, id → timer handle. Cancelled by `returnToNew` and by unmount. */
  const slideTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /**
   * What was marked unread while the Ohbox is open, by id: `returnToNew`'s doors and the open row's own turn
   * (`useUnreadTurn`). No landing's rest or arrow scroll reads it back (`UnreadHold`).
   */
  const [unreadHold] = useState(createUnreadHold);

  const returnToNew = useReturnToNew(unreadHold, slideTimers, setSettling, setDismissed);

  const ohboxAll = useMemo(
    () => [...resurfaced, ...newForYou, ...previouslySeen],
    [resurfaced, newForYou, previouslySeen],
  );
  const byId = useMemo(() => new Map(ohboxAll.map((m) => [m.id, m])), [ohboxAll]);

  /**
   * The rows the selector now files under "Earlier" — the predicate the slide turns on.
   * Membership of `previouslySeen`, NOT `m.unread === false`: a resurfaced row that has been
   * read still belongs at the top — the pin, not the read state, decides that group, and
   * sliding on the read flag would drop it into a section that does not contain it (a row that
   * vanishes until the server catches up). The question asked is the one the answer depends on:
   * does the selector say this row's place is now "Earlier"? Every cause — in-app read,
   * answered message, adopted `\Seen` — reaches this view as the same re-partition.
   */
  const earlierIds = useMemo(() => new Set(previouslySeen.map((m) => m.id)), [previouslySeen]);

  /*
   * Kept per what it reads. `reconcile` and its pruning are idempotent over the same inputs, so a render that
   * changes none of them would only write the orders they already hold; keeping the result lets the groups, and
   * every memo and effect keyed on them, change exactly when the placement does.
   */
  const { displayResurfaced, displayNew, displayPrev } = useMemo(() => {
    const dropped = (id: string): boolean => dismissed.has(id) && earlierIds.has(id);
    // Resurfaced keeps the pin's order: that group is the worker's pin, not a reading order, and a
    // `u` on a resurfaced row leaves it exactly where the pin put it.
    /**
     * The pin claims a row out of the session orders — the display half of the selector's dedup. The selector
     * never shows one message twice; the session orders could: a "Resurface now" on a row sitting in New put
     * its id into `resurfacedOrder` while `newOrder` kept holding it, and the message rendered twice until a
     * reload. Each upper order is pruned to agree with the SELECTOR about which section owns the id:
     * `newOrder` never holds a pinned id; `resurfacedOrder` holds a pinned id OR one re-filed under "Earlier"
     * — the slide's lease, kept for `SETTLE_MS`. An id in neither (a rolled-back pin on an unread row) is
     * released to New immediately. Pruning the ORDERS, not the display lists, keeps `upper` honest too; what
     * is lost is only the row's old position across an unpin.
     */
    const pinnedIds = new Set(resurfaced.map((m) => m.id));
    resurfacedOrder.current = reconcile(resurfacedOrder.current, resurfaced, byId, dropped).filter(
      (id) => pinnedIds.has(id) || earlierIds.has(id),
    );
    newOrder.current = reconcile(newOrder.current, newForYou, byId, dropped).filter(
      (id) => !pinnedIds.has(id),
    );

    // The three groups as DISPLAYED: session order for the two upper ones, and "Earlier" with the
    // pinned upper ids removed so a row read this session is never shown twice.
    const upper = new Set([...resurfacedOrder.current, ...newOrder.current]);
    const displayResurfaced = resurfacedOrder.current
      .map((id) => byId.get(id))
      .filter((m): m is EngineMessage => m != null);
    const displayNew = newOrder.current
      .map((id) => byId.get(id))
      .filter((m): m is EngineMessage => m != null);
    const displayPrev = previouslySeen.filter((m) => !upper.has(m.id));
    return { displayResurfaced, displayNew, displayPrev };
  }, [resurfaced, newForYou, previouslySeen, byId, dismissed, earlierIds]);
  return {
    settling,
    setSettling,
    setDismissed,
    slideTimers,
    unreadHold,
    returnToNew,
    byId,
    earlierIds,
    resurfacedOrder,
    newOrder,
    displayResurfaced,
    displayNew,
    displayPrev,
  };
}
