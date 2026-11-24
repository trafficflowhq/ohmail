"use client";

/**
 * THE COLUMN'S VISIT OF THE SHOWN LETTER: the list's own where the list that opened it handed one, else the
 * column's. Never both: while a list's visit stands, the column's own is given nothing to show, so one record exists
 * per open letter and one dwell reads it once.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useReaderVisit, type ReaderMarkSeen, type ThreadReadWiring } from "../reading/reader-seen.js";

export interface ColumnVisit {
  readonly wiring: ThreadReadWiring | null;
  /** The visit is entered (an open, a press into the column). */
  readonly enter: () => void;
  /** The column's own Mark unread of `id`: held for the visit. */
  readonly holdUnread: (id: string) => void;
  /** Whose visit runs: the list's, or the column's own. */
  readonly owner: "list" | "column";
}

export function useColumnVisit(
  shown: EngineMessage | null,
  handed: ThreadReadWiring | null,
  markSeen: ReaderMarkSeen,
): ColumnVisit {
  const own = useReaderVisit({ shown: handed === null ? shown : null, markSeen });
  if (handed !== null) {
    return {
      wiring: handed,
      enter: () => handed.onEnter(),
      holdUnread: (id) => handed.hold?.add([id]),
      owner: "list",
    };
  }
  const id = shown?.id ?? null;
  return {
    wiring: own.wiring,
    enter: () => {
      if (id !== null) own.enter(id);
    },
    holdUnread: own.holdUnread,
    owner: "column",
  };
}
