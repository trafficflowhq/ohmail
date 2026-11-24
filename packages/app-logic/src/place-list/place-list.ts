/**
 * A LIST PLACE BESIDE THE READER: History, a tag, a folder, an address. Its rows in the order the place gives them,
 * the letter open among them, the cursor's row (the list's walk, `walk.ts`), and what the list hands the reading
 * column: the open letter's visit (the read rule's record, the read set, its verbs through the seat's path, the two
 * steps) or, with nothing open, what it holds.
 * A row press opens and enters; a step lands, and the rest enters it; a hit opened into the place as entered is
 * entered once it is shown; the first letter stands open on arrival where the place says so. What turns read is the
 * reader's rule, written through the seat's `markSeen`, never here. The steps' names and the blank are the
 * drawing's, in its words.
 */
import { useEffect, useMemo, useRef } from "react";
import type { ListVerbs } from "../press/list-verbs.js";
import type { EngineMessage } from "@ohmail/wire";
import type { PlaceLiveArgs } from "../lists/place-live.js";
import type { MessageAction } from "../press/actions.js";
import { useStableCallback } from "../press/stable-callback.js";
import type { ListVisit } from "../reading/list-meeting.js";
import { useReaderVisit, type ReaderMarkSeen } from "../reading/reader-seen.js";
import { useTakeEntered } from "./entered.js";
import { useListWalk, type ListArrival, type ListWalk, type ListWalkSeat } from "./walk.js";

/** Newest first by when it arrived; a letter with no date last; equal instants by id, so the order never wavers. */
export function newestFirst(a: EngineMessage, b: EngineMessage): number {
  const at = (m: EngineMessage): number =>
    m.date === null ? Number.NEGATIVE_INFINITY : Date.parse(m.date) || 0;
  return at(b) - at(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export interface PlaceListInput {
  readonly verbs?: ListVerbs;
  /** The rows, in the place's order. */
  readonly rows: readonly EngineMessage[];
  /** The letter open in the place (the route's), or none. */
  readonly openId: string | null;
  /** A directly addressed message whose conversation row represents it. */
  readonly openMessage?: EngineMessage;
  readonly openRowId?: string;
  /** Opens a letter in the place, or closes it: the frame's command. */
  readonly open: (id: string | null) => void;
  /** The seat's mark, through its one press seam. */
  readonly markSeen: ReaderMarkSeen;
  /** A verb on a letter, through the seat's path. */
  readonly act: (action: MessageAction, m: EngineMessage) => void;
  /** The letter another place opened INTO this one as entered (the frame's one-shot), taken once it is shown. */
  readonly entered: PlaceLiveArgs["entered"];
  /** What the list's walk reads of the window and the address, and says in the key sheet. */
  readonly walk: ListWalkSeat;
  /** Whether the first letter stands open on arrival where two columns stand: the place's own word. */
  readonly arrival: ListArrival;
}

export interface PlaceList {
  readonly verbs?: ListVerbs;
  readonly rows: readonly EngineMessage[];
  /** The letter open in the place, where the list holds it. */
  readonly openId: string | null;
  /** The cursor's row: the open letter where two columns stand, the list's own row where one does. */
  readonly cursor: string | null;
  /** A press on a row: the cursor goes there, the letter opens and its visit is entered. */
  readonly press: (id: string) => void;
  /** The open letter's visit, for the reading column; its steps are named by the drawing. */
  readonly visit: ListVisit | null;
  /** The list's walk, for the place's live hook to bind its keys once. */
  readonly walk: ListWalk;
}

export function usePlaceList(input: PlaceListInput): PlaceList {
  const { rows, openId, open, markSeen, act } = input;
  const shown = openId === null ? null : (input.openMessage ?? rows.find((m) => m.id === openId) ?? null);
  const { wiring, enter, land, keyScroll } = useReaderVisit({ shown, markSeen });
  /* A hit a person chose elsewhere and opened here: its row is entered once the list shows it, as a press enters. */
  useTakeEntered(input.entered, (id) => shown !== null && shown.id === id, enter);
  /* A press enters the letter it opens. The address names that letter a commit later on the web, and the visit
     drops an enter for a letter its commit does not show: the press waits for its letter to be shown, and is dropped
     where the address moves to another letter first. */
  const pressed = useRef<{ readonly id: string; readonly from: string | null } | null>(null);
  const shownId = shown?.id ?? null;
  const enterShown = useStableCallback((id: string) => {
    pressed.current = id === shownId ? null : { id, from: shownId };
    if (id === shownId) enter(id);
  });
  useEffect(() => {
    const held = pressed.current;
    if (held === null || shownId === held.from) return;
    pressed.current = null;
    if (shownId === held.id) enter(held.id);
  });
  const order = useMemo(() => [...new Set(rows.map((m) => m.id))], [rows]);
  const walk = useListWalk({
    ...input.walk,
    order,
    openId: input.openRowId ?? openId,
    open,
    arrival: input.arrival,
    enter: enterShown,
    land,
    scrolled: keyScroll,
  });
  const { up, down } = walk;

  const visit = useMemo<ListVisit | null>(() => {
    if (shown === null || wiring === null) return null;
    return {
      openId: shown.id,
      row: shown,
      unread: shown.unread,
      wiring,
      readSet: shown.unread ? [shown.id] : [],
      act: (action) => {
        if (action === "unread") {
          /* Off the Ohbox a Mark read names the letter as the row read: in ohmail, an open read. */
          if (shown.unread) void markSeen([shown.id], false, undefined, shown.id);
          else wiring.onMarkUnread(shown.id);
          return;
        }
        act(action, shown);
      },
      step: { up, down },
    };
  }, [shown, wiring, up, down, markSeen, act]);
  return {
    rows,
    verbs: input.verbs,
    openId: shown?.id ?? null,
    cursor: walk.cursor,
    press: walk.press,
    visit,
    walk,
  };
}
