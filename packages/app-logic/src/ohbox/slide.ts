/** The slide: how a row leaves the Ohbox's upper groups, and the settled reply that reads the row it answered. */
import type { EngineMessage } from "@ohmail/wire";
import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { OhboxListInput, OhboxReplyDone } from "./types.js";

/**
 * How long a row slides before it re-files under "Earlier": long enough to
 * read as a deliberate move, short enough that the row is gone from "New
 * for you" by the time attention returns. Matches the `.row.settling`
 * transition in `row.css`; reduced-motion devices get no transition and the
 * row simply moves on the render this timer schedules. One constant for
 * every departure from "New for you" — a settled reply, an in-app read, a
 * `\Seen` from another client: one gesture, three causes, one mechanism
 * (`slideOut`).
 */
const SETTLE_MS = 280;

/** What the slide reads and writes of the session placement. */
export interface SlideParts {
  slideTimers: MutableRefObject<Map<string, ReturnType<typeof setTimeout>>>;
  setSettling: Dispatch<SetStateAction<Set<string>>>;
  setDismissed: Dispatch<SetStateAction<Set<string>>>;
  earlierIds: Set<string>;
  resurfacedOrder: MutableRefObject<string[]>;
  newOrder: MutableRefObject<string[]>;
}

export function useSlide({
  slideTimers,
  setSettling,
  setDismissed,
  earlierIds,
  resurfacedOrder,
  newOrder,
}: SlideParts): void {
  /**
   * {@link earlierIds}, READABLE FROM INSIDE THE SLIDE TIMER, and held the same way and for the
   * same reason as `allRef` above: the slide has to re-judge its own premise at the moment it
   * completes, against the list as it is THEN, not as it was 280 ms earlier when the row started
   * moving. Assigned in render so a slide that fires between two renders reads the newer answer.
   */
  const earlierRef = useRef(earlierIds);
  earlierRef.current = earlierIds;

  /**
   * The slide: a row leaves the upper groups by MOVING, not disappearing. The only writer of `settling`
   * and `dismissed`, so there is exactly one answer to "how does a row leave New for you". Two steps and
   * a gap: the class goes on first and the row keeps its slot for {@link SETTLE_MS} (what `row.css`
   * transitions over); only then is the id dropped and the row redrawn under "Earlier" — same-tick
   * dropping is a teleport. It re-judges its premise when it lands (a fire-time re-read, like the arm's):
   * 280 ms is long enough for `u`, another client, or a filing to change the answer, so completion asks
   * `earlierRef` again and abandons the move if "Earlier" is no longer where the row belongs; `returnToNew`
   * cancels the timer outright for the explicit case.
   */
  const slideOut = useCallback(
    (id: string) => {
      if (slideTimers.current.has(id)) return;
      setSettling((s) => new Set(s).add(id));
      const timer = setTimeout(() => {
        slideTimers.current.delete(id);
        if (earlierRef.current.has(id)) setDismissed((d) => new Set(d).add(id));
        setSettling((s) => {
          if (!s.has(id)) return s;
          const next = new Set(s);
          next.delete(id);
          return next;
        });
      }, SETTLE_MS);
      slideTimers.current.set(id, timer);
    },
    [slideTimers, setSettling, setDismissed],
  );

  /**
   * What starts a slide: the selector re-filing a row this view is still holding up. One
   * observation against the session orders: an id held in an upper group that `ohboxView` now
   * files under "Earlier". An in-app read (the optimistic overlay flips the row), a settled
   * reply, and a `\Seen` adopted from another client all arrive as the same delta — one
   * mechanism, because they are one event with different causes; per-cause hooks were how
   * external reads came to move nothing until a reload. Keyed on `earlierIds` and nothing else
   * — a memo over `previouslySeen`, so it re-runs exactly on changes that can add work.
   * `slideOut` is idempotent on an id already in flight.
   */
  useEffect(() => {
    // The row being read never reaches `earlierIds` while it is read: the SELECTOR keeps it in New
    // (`ohboxView`'s `openHeld`, held by the engine from the enter) until it is left or answered.
    for (const id of resurfacedOrder.current) if (earlierIds.has(id)) slideOut(id);
    for (const id of newOrder.current) if (earlierIds.has(id)) slideOut(id);
  }, [earlierIds, slideOut, resurfacedOrder, newOrder]);

  /** Nothing may fire into an unmounted view — the whole map, once, on the way out. */
  useEffect(() => {
    const timers = slideTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [slideTimers]);
}

export function useReplyDoneRead(
  replyDone: OhboxReplyDone | null | undefined,
  newOrder: MutableRefObject<string[]>,
  allRef: MutableRefObject<EngineMessage[]>,
  markSeenRef: MutableRefObject<OhboxListInput["onMarkSeen"]>,
): void {
  /**
   * A settled reply marks the message it answered read. Answering is being done with it. A
   * pinned row is never in the New order, so a plain reply leaves a resurface standing: only
   * Done, Send + Done or a deliberate read release it (owner 2026-10-22). The shell hands the settled reply down as {@link replyDone},
   * keyed on the settle instant so a value already acted on is ignored. The move is NOT written
   * here any more: reads move rows now, and a second copy of the gesture would be two
   * mechanisms racing over one row — the write is the whole of this effect, the slide follows
   * through `slideOut`. It acts only on a row currently in the New session order: a reply to
   * something in "Earlier" is answering read mail, a no-op.
   */
  const replyDoneStamp = useRef<string | null>(null);
  useEffect(() => {
    const rd = replyDone ?? null;
    if (!rd) return;
    const stamp = `${rd.messageId}|${rd.at}`;
    if (replyDoneStamp.current === stamp) return;
    replyDoneStamp.current = stamp;
    if (!newOrder.current.includes(rd.messageId)) return;
    if (allRef.current.find((m) => m.id === rd.messageId)?.unread) {
      markSeenRef.current([rd.messageId], false);
    }
    // Keyed on `replyDone`: the refs it reaches are stable, and re-running on any other change would replay a
    // settle the stamp guard has already spent.
  }, [replyDone, newOrder, allRef, markSeenRef]);
}
