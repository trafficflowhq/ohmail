/** The picks: the Ohbox's multi-select, view-local, the verbs over it, and the keyboard's range. */
import type { EngineMessage } from "@ohmail/wire";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { OhboxRow as OhboxRowGroup } from "@ohmail/client-engine";
import type { BulkAction } from "../press/actions.js";
import type { OhboxListInput, OhboxListModel, PickPanel } from "./types.js";

/** The pick set, its range's anchor, and the bar's open sub-row. */
export interface PickSet {
  picked: Set<string>;
  setPicked: Dispatch<SetStateAction<Set<string>>>;
  anchor: MutableRefObject<string | null>;
  pickPanel: PickPanel | null;
  setPickPanel: Dispatch<SetStateAction<PickPanel | null>>;
  clearPicked: () => void;
  togglePick: (id: string) => void;
  pickRangeTo: (id: string) => void;
}

export function usePickSet(
  navRows: readonly { readonly members: readonly { readonly id: string }[] }[],
  rowIndexOf: (id: string | null) => number,
): PickSet {
  /* ── multi-select: VIEW-LOCAL, deliberately ──────────────────────────────
     It is a selection, not a document: it means nothing after you leave the
     Ohbox, and persisting it would resurrect a stale set on the next visit.
     `anchor` is the range origin for shift-click, kept in a ref so changing it
     never costs a render. */
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  /** The bulk bar's open sub-row. Same union shape as the reader bar's. */
  const [pickPanel, setPickPanel] = useState<PickPanel | null>(null);

  const clearPicked = useCallback(() => {
    if (picked.size > 0) setPicked(new Set());
    setPickPanel(null);
    anchor.current = null;
  }, [picked.size]);

  /**
   * A PICK IS A PICK OF THE ROW — and a row can be a conversation now. Toggling a grouped row
   * toggles every message it stands for: the row says "⤷ 5", so a verb run on the pick must
   * act on five messages, not on the one that happens to lead the fold. (Representative-only
   * picking was the alternative, and it made "Move" on a five-unread conversation move one
   * message and leave the row standing — a verb that visibly does not do what the row shows.)
   * A message in no row is its own pick, and leaves with the next prune: the list does not show it.
   */
  const togglePick = useCallback(
    (id: string) => {
      const row = navRows[rowIndexOf(id)];
      const ids = row ? row.members.map((m) => m.id) : [id];
      setPicked((prev) => {
        const next = new Set(prev);
        const allIn = ids.every((i) => next.has(i));
        for (const i of ids) {
          if (allIn) next.delete(i);
          else next.add(i);
        }
        return next;
      });
      anchor.current = id;
      // Keyed on the rows as drawn and the finder over them: they change together, with the groups.
    },
    [navRows, rowIndexOf],
  );

  /** Shift-click: add the inclusive ROW range from the anchor to `id`, in list order. */
  const pickRangeTo = useCallback(
    (id: string) => {
      const from = anchor.current ? rowIndexOf(anchor.current) : -1;
      const to = rowIndexOf(id);
      if (from < 0 || to < 0) {
        togglePick(id);
        return;
      }
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      setPicked((prev) => {
        const next = new Set(prev);
        for (let i = lo; i <= hi; i++) for (const m of navRows[i]!.members) next.add(m.id);
        return next;
      });
    },
    [navRows, rowIndexOf, togglePick],
  );
  return { picked, setPicked, anchor, pickPanel, setPickPanel, clearPicked, togglePick, pickRangeTo };
}

/** The model's fields the verbs over the picks answer. */
export type PickVerbs = Pick<
  OhboxListModel,
  "pickedIds" | "pickedRowCount" | "runBulk" | "markPicked" | "deletePicked" | "pickState"
>;

export function usePickVerbs(
  input: OhboxListInput,
  { picked, setPicked, setPickPanel, clearPicked }: PickSet,
  shown: EngineMessage[],
  navRows: OhboxRowGroup[],
  returnToNew: (ids: readonly string[]) => void,
  verbTook: MutableRefObject<{ id: string; at: number } | null>,
): PickVerbs {
  const { selectedId, lastActed, bulk } = input;
  /**
   * The selection IN LIST ORDER, which is the order every verb acts in.
   *
   * A `Set`'s iteration order is insertion order, so a range built upwards and one built
   * downwards would dispatch in different orders for the same visible selection. Deriving it
   * from `shown` means the mutations follow what is on screen.
   */
  const pickedIds = useMemo(() => shown.filter((m) => picked.has(m.id)).map((m) => m.id), [shown, picked]);
  const pickedRowCount = navRows.filter((g) => g.members.some((m) => picked.has(m.id))).length;

  /**
   * Run a bulk verb and drop the selection.
   *
   * Clearing afterwards is the rule `markPicked` has always had: the verb has been applied
   * to exactly these messages, so a set that survived would invite a second application of
   * a verb that has already happened — and after a move or a screening the rows are not
   * even in this list any more.
   */
  const runBulk = useCallback(
    (action: BulkAction) => {
      // The selection's `unread` direction is the same explicit act `u` is, over more rows, so it
      // returns them to New the same way — see `returnToNew`. Only the direction, never the toggle:
      // `read` has nothing to return and `move`/the horizons take the rows out of this list.
      if (action === "unread") returnToNew(pickedIds);
      /* A set holding the open row takes it from under the cursor like a single verb does. */
      if (selectedId != null && pickedIds.includes(selectedId)) {
        verbTook.current = { id: selectedId, at: Date.now() };
        // …and the cursor moves on as it does after a single verb, never left on a row the set took.
        if (lastActed) lastActed.current = { id: selectedId, at: Date.now() };
      }
      /* A REFUSAL KEEPS THE SELECTION. Clearing afterwards is right for a verb that HAPPENED —
         the rows have been dealt with, and a set that survived would invite a second
         application of it. A reader's Move, Screening or Delete does not happen: `run` answers
         `false` at the press, nothing was dispatched, and throwing the set away would make the
         person rebuild it before trying a verb that works. */
      const conversationIds = action.startsWith("move:")
        ? new Set(
            navRows.flatMap(({ members }) =>
              members.length > 1 && members.every(({ id }) => picked.has(id))
                ? members.map(({ id }) => id)
                : [],
            ),
          )
        : undefined;
      if (bulk.run(action, pickedIds, { conversationIds })) clearPicked();
      else setPickPanel(null);
    },
    [
      bulk,
      picked,
      pickedIds,
      navRows,
      clearPicked,
      returnToNew,
      selectedId,
      lastActed,
      setPickPanel,
      verbTook,
    ],
  );

  /**
   * Mark everything picked read, in ONE mutation — one request, one transaction, one intent.
   *
   * `⇧U` and the bar's Read button are THE SAME CALL, which is the action bar's own rule
   * about the read switch applied to the selection: two paths to one verb is how a button and its key drift
   * into meaning different things. It used to call `onMarkSeen` directly, so the key marked
   * mail read and said nothing while every other bulk verb reported what it had done.
   */
  const markPicked = useCallback(() => runBulk("read"), [runBulk]);

  // Ids that vanished from the list (moved, filed, deleted) leave with it — a count that
  // outlives its rows is a count that acts on nothing. Keyed on the picks too: a hold fired on a
  // row that left meanwhile picks after the list's last change.
  useEffect(() => {
    setPicked((prev) => {
      if (prev.size === 0) return prev;
      // `shown`: what the list draws is what a pick may stand on.
      const live = new Set(shown.map((m) => m.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [shown, picked, setPicked]);

  /**
   * DELETE THE SELECTION — one press, one window, one toast, one Undo for the whole set. It goes through
   * `BulkAction`'s `delete` arm, which hands the ids to the SAME `delete-undo.ts` window a single ⌫ opens. Nothing is
   * dispatched here and nothing is dispatched by the shell's arm either: the window holds the ids and sends one
   * `message_delete` per id only when it closes, so Undo inside it cancels a delete that never happened. That is the
   * only undo this wire can honour — there is no un-delete on it. The pick clears on the press, like every verb that
   * ran: the rows leave every pile at once (`hideMessages` over the held ids), so a set that survived would be
   * pointing at rows that are not on screen.
   */
  const deletePicked = useCallback(() => runBulk("delete"), [runBulk]);

  /**
   * WHAT THE ROW PUBLISHES AS ITS SELECTION, and it is not always the pick.
   *
   * The Ohbox is the one multi-selectable list, and a multi-selectable listbox's `aria-selected`
   * is set MEMBERSHIP — so while the set is empty the reader's cursor had nothing to be published
   * as. `undefined` hands the row back to its cursor (`MessageRow`'s selection block) and changes
   * nothing that is drawn: the `picked` class is off for `false` and `undefined` alike.
   */
  const pickState = (on: boolean): boolean | undefined => (picked.size > 0 ? on : undefined);
  return { pickedIds, pickedRowCount, runBulk, markPicked, deletePicked, pickState };
}

/** What the keyboard's range reads: the walk, the cursor, and the cursor's move. */
export interface ExtendParts {
  order: string[];
  at: number;
  selectedId: string | null;
  anchor: MutableRefObject<string | null>;
  selectByUser: (id: string, extend?: boolean) => void;
  pickRangeTo: (id: string) => void;
}

/**
 * ⇧↓ / ⇧↑ — move the cursor and drag the selection with it. The keyboard twin of a shift-click, and it was simply
 * missing: a range could be built with a mouse and not with the keys, on a product whose list is keyboard-first.
 * ADDITIVE, never subtractive — the one real decision: shrink-on-reverse (⇧↑ un-picking what ⇧↓ picked) is what a
 * text field does, and it needs a second piece of state beside the set — a live range with a direction — because
 * the set alone cannot say which members came from THIS gesture; worse, it would remove rows picked by other means
 * (⌘-click four rows, then ⇧↓ ⇧↑, and two are gone). So the range only ever adds, exactly as ⇧-click does; removal
 * is the way you added — `x`, ⌘-click, or Escape. Each press adds the row you are on and the row you land on — the
 * pair the gesture visibly spans — and the row read before it keeps its place until the pick ends (`selectByUser`).
 */

export function useExtendPick({
  order,
  at,
  selectedId,
  anchor,
  selectByUser,
  pickRangeTo,
}: ExtendParts): (dir: 1 | -1) => void {
  /**
   * Key repeat is allowed, unlike `⌫`: a held ⇧↓ walking a range down the list is the gesture, and each repeat adds
   * one row to a set not yet acted on — a held `⌫` would walk a pile into Trash one window at a time, which is why
   * item 10 guards that one.
   */
  const extendPick = useCallback(
    (dir: 1 | -1) => {
      if (order.length === 0) return;
      // Range from the cursor's row, never an older anchor whose row may have moved since.
      if (at >= 0) anchor.current = order[at]!;
      else if (anchor.current === null && selectedId) anchor.current = selectedId;
      const next = at < 0 ? order[dir === 1 ? 0 : order.length - 1] : order[at + dir];
      if (!next) return;
      selectByUser(next, true);
      pickRangeTo(next);
      anchor.current = next;
      // Keyed on the walk and the cursor as drawn: the walk is kept per the rows it is made of.
    },
    [order, at, selectedId, selectByUser, pickRangeTo, anchor],
  );
  return extendPick;
}
