/**
 * A LIST PLACE BESIDE THE READER: History, a tag, a folder, an address. Its rows in the order the place gives them,
 * the letter open among them, and what the list hands the reading column: the open letter's visit (the read rule's
 * record, the read set, its verbs through the seat's path, the two steps) or, with nothing open, what it holds.
 * A row press opens; a step lands, and the rest enters it. What turns read is the reader's rule, written through
 * the seat's `markSeen`, never here. The steps' names and the blank are the drawing's, in its words.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useCallback, useMemo } from "react";
import type { MessageAction } from "../press/actions.js";
import type { ListStep, ListVisit } from "../reading/list-meeting.js";
import { useReaderVisit, type ReaderMarkSeen } from "../reading/reader-seen.js";

/** Newest first by when it arrived; a letter with no date last; equal instants by id, so the order never wavers. */
export function newestFirst(a: EngineMessage, b: EngineMessage): number {
  const at = (m: EngineMessage): number =>
    m.date === null ? Number.NEGATIVE_INFINITY : Date.parse(m.date) || 0;
  return at(b) - at(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export interface PlaceListInput {
  /** The rows, in the place's order. */
  readonly rows: readonly EngineMessage[];
  /** The letter open in the place (the route's), or none. */
  readonly openId: string | null;
  /** Opens a letter in the place, or closes it: the frame's command. */
  readonly open: (id: string | null) => void;
  /** The seat's mark, through its one press seam. */
  readonly markSeen: ReaderMarkSeen;
  /** A verb on a letter, through the seat's path. */
  readonly act: (action: MessageAction, m: EngineMessage) => void;
}

export interface PlaceList {
  readonly rows: readonly EngineMessage[];
  readonly openId: string | null;
  /** A press on a row: the letter opens and its visit is entered. */
  readonly press: (id: string) => void;
  /** The open letter's visit, for the reading column; its steps are unnamed until the drawing names them. */
  readonly visit: ListVisit | null;
}

export function usePlaceList(input: PlaceListInput): PlaceList {
  const { rows, openId, open, markSeen, act } = input;
  const shown = openId === null ? null : (rows.find((m) => m.id === openId) ?? null);
  const at = shown === null ? -1 : rows.indexOf(shown);
  const { wiring, enter, land } = useReaderVisit({ shown, markSeen });

  const press = useCallback(
    (id: string) => {
      open(id);
      enter(id);
    },
    [open, enter],
  );
  const stepTo = useCallback(
    (to: number) => {
      const next = rows[to];
      if (!next) return;
      open(next.id);
      land(next.id);
    },
    [rows, open, land],
  );

  const visit = useMemo<ListVisit | null>(() => {
    if (shown === null || wiring === null) return null;
    const step = (to: number): ListStep => ({
      disabled: rows[to] === undefined,
      run: () => stepTo(to),
      label: "",
    });
    return {
      openId: shown.id,
      unread: shown.unread,
      wiring,
      readSet: shown.unread ? [shown.id] : [],
      act: (action) => {
        if (action === "unread") {
          if (shown.unread) void markSeen([shown.id], false);
          else wiring.onMarkUnread(shown.id);
          return;
        }
        act(action, shown);
      },
      step: { up: step(at - 1), down: step(at + 1) },
    };
  }, [shown, wiring, rows, at, stepTo, markSeen, act]);
  return { rows, openId: shown?.id ?? null, press, visit };
}
