/**
 * TRASH'S MODEL. Above: what ohmail deleted, newest deletion first, read through the one paged window
 * (`lists/trash-page`), each row saying when it was deleted and where Restore puts it. Restore is the press seam's
 * held window, by the row's id: the server resolves the folder, never this side. Below: the mail server's own Trash,
 * read-only, through the host's wire or withheld. Both are walked as one list (`../place-list/walk.ts`), which takes
 * ids and no verb.
 */
import { useStableCallback } from "../press/stable-callback.js";
import { countWhen, listSurface, saysEmpty } from "@ohmail/client-engine";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { TrashRowWire } from "@ohmail/client-engine";
import { useEngine } from "../engine/context.js";
import { useTrashPage, type TrashPage } from "../lists/trash-page.js";
import { useListWalk, type ListArrival, type ListWalk, type ListWalkSeat } from "../place-list/walk.js";
import type { DeleteTarget } from "../press/delete-undo.js";
import type { ReaderMarkSeen } from "../reading/reader-seen.js";
import {
  trashLiveKeyOf,
  trashLiveState,
  useTrashWindow,
  type TrashLiveState,
  type TrashLiveWire,
  type TrashWindowControl,
  type TrashWindowItemWire,
} from "./live-window.js";

export interface TrashInput {
  /** What the press seam's restore window holds: those rows leave the list at the press. */
  readonly held: ReadonlySet<string>;
  /** Deletes the server has confirmed so far: a rise reads page one again. */
  readonly landed: number;
  /** Restores the server has taken: each leaves the list. */
  readonly restored: readonly string[];
  /** The seam's restore: one held window for the row, by its id. False: refused at the press. */
  readonly restore: (target: DeleteTarget | readonly DeleteTarget[]) => boolean;
  /** The shell's `markSeen`: the read slot writes a deleted letter's read state through it. */
  readonly markSeen: ReaderMarkSeen;
  /** The host's live wire, or `none`: the section is withheld. */
  readonly wire: TrashLiveWire | "none";
  /** The row open in the place (the route's): a deleted letter's id, or a live row's key. */
  readonly openId: string | null;
  readonly open: (id: string | null) => void;
  readonly stamp: (iso: string) => string;
  /** The place a restore goes to, in the person's words. */
  readonly placeOf: (folder: string) => string;
  /** What the list's walk reads of the window and the address, and says in the key sheet. */
  readonly walk: ListWalkSeat;
  /** Whether the first deleted letter stands open on arrival where two columns stand: the place's own word. */
  readonly arrival: ListArrival;
}

export interface TrashModel {
  readonly page: TrashPage;
  readonly deletedEmpty: boolean;
  readonly gone: boolean;
  readonly live: TrashWindowControl & {
    readonly state: TrashLiveState;
    readonly shown: boolean;
    readonly count: number | undefined;
  };
  /** The deleted letter open, if the open id names one. */
  readonly openRow: TrashRowWire | null;
  /** The live row open, if the open id names one. */
  readonly openLive: TrashWindowItemWire | null;
  readonly openId: string | null;
  readonly open: (id: string | null) => void;
  /** Restore the row: where it goes is the server's record. */
  readonly restore: (row: TrashRowWire) => void;
  readonly restoreMany?: (rows: readonly TrashRowWire[]) => boolean;
  /** Whether the row reads as unread: its own state, or the read slot's last press on it this visit. */
  readonly unreadOf: (row: TrashRowWire) => boolean;
  /** The read slot: the row turns unread when it reads as read, and read when it reads as unread. */
  readonly flipRead: (row: TrashRowWire) => void;
  readonly stamp: (iso: string) => string;
  readonly placeOf: (folder: string) => string;
  /** The cursor's row: the letter open where two columns stand, the list's own row where one does. */
  readonly cursor: string | null;
  /** The list's walk, for the live hook to bind its keys once. */
  readonly walk: ListWalk;
}

export function useTrashList(input: TrashInput): TrashModel {
  const engine = useEngine();
  const page = useTrashPage(engine, true, input.held, input.landed, input.restored);
  /* The window is read while a wire is handed: a wire that arrives after the place stood (the account's answer that it
     uses folders) is read on its arrival, and one that goes drops the window. */
  const window = useTrashWindow(input.wire !== "none", input.wire);
  const state = trashLiveState(window);
  const deleted = listSurface({
    settled: page.available && page.exhausted && page.error === null,
    count: page.items.length,
  });
  const liveCount = countWhen(
    {
      settled: (state.state === "rows" || state.state === "empty") && window.nextCursor === null,
      count: window.items.length,
    },
    window.items.length,
  );
  const { openId, open, restore: seamRestore } = input;
  const openRow = openId === null ? null : (page.items.find((r) => r.id === openId) ?? null);
  const openLive = openId === null ? null : (window.items.find((i) => trashLiveKeyOf(i) === openId) ?? null);
  /* A live row's text is read when it is opened, once a visit. */
  const { openBody } = window;
  useEffect(() => {
    if (openLive !== null) openBody(openLive);
  }, [openLive, openBody]);
  /* THE WALK's STOPS, as the list draws them: what ohmail deleted, then the server's own Trash. Its rows join once
     ohmail's first page has answered, and the arrival stands a letter only where that page holds one: the letter
     standing open on arrival is ohmail's first deleted one whichever read lands first, never one of the server's. */
  const answered = page.items.length > 0 || page.exhausted || page.error !== null || !page.available;
  const liveRows = input.wire !== "none" && state.state === "rows";
  const order = useMemo(
    () =>
      answered ? [...page.items.map((r) => r.id), ...(liveRows ? window.items.map(trashLiveKeyOf) : [])] : [],
    [answered, page.items, liveRows, window.items],
  );
  const [cursorWhenClosed, setCursorWhenClosed] = useState<string | null>(null);
  useEffect(() => {
    if (openId !== null) setCursorWhenClosed(null);
  }, [openId]);
  const walk = useListWalk({
    ...input.walk,
    order,
    openId,
    open,
    cursorWhenClosed,
    arrival: page.items.length > 0 ? input.arrival : "rest",
  });
  /* One act per press: a row pressed again before the seam's window shows it held is not a second restore. It may be
     pressed again once Undo has given it back. */
  const pressed = useRef(new Set<string>());
  const { held } = input;
  useEffect(() => {
    for (const id of [...pressed.current]) if (!held.has(id)) pressed.current.delete(id);
  }, [held]);
  const restoreMany = useStableCallback((rows: readonly TrashRowWire[]) => {
    const targets = rows.filter(({ id }) => !pressed.current.has(id) && !held.has(id));
    if (targets.length === 0) return false;
    for (const { id } of targets) pressed.current.add(id);
    const messages = targets.map(({ id, mailboxId }) => ({ id, mailboxId }));
    const acted = seamRestore(messages.length === 1 ? messages[0]! : messages);
    if (!acted) {
      for (const { id } of targets) pressed.current.delete(id);
      return false;
    }
    if (openId !== null && targets.some(({ id }) => id === openId)) {
      const restoring = new Set(targets.map(({ id }) => id));
      const at = order.indexOf(openId);
      const next = order.slice(at + 1).find((id) => !restoring.has(id));
      const previous = order
        .slice(0, at)
        .reverse()
        .find((id) => !restoring.has(id));
      setCursorWhenClosed(next ?? previous ?? null);
      open(null);
    }
    return true;
  });
  const restore = (row: TrashRowWire) => {
    restoreMany([row]);
  };
  /* The page is no mirror: the slot's press is what the row reads as for the visit. */
  const [flipped, setFlipped] = useState<ReadonlyMap<string, boolean>>(new Map());
  const unreadOf = useStableCallback((row: TrashRowWire) => flipped.get(row.id) ?? row.unread);
  const { markSeen } = input;
  const flipRead = useStableCallback((row: TrashRowWire) => {
    const unread = !unreadOf(row);
    const put = (to: boolean) => setFlipped((was) => new Map(was).set(row.id, to));
    put(unread);
    void Promise.resolve(markSeen([row.id], unread)).then((acted) => {
      if (acted === false) put(!unread);
    });
  });
  return {
    page,
    deletedEmpty: saysEmpty(deleted),
    gone: openId !== null && page.removed.has(openId),
    live: { ...window, state, shown: input.wire !== "none", count: liveCount },
    openRow,
    openLive,
    openId,
    open,
    restore,
    restoreMany,
    unreadOf,
    flipRead,
    stamp: input.stamp,
    placeOf: input.placeOf,
    cursor: walk.cursor,
    walk,
  };
}

export const TrashModelContext = createContext<TrashModel | null>(null);

export function useTrashModel(): TrashModel {
  const model = useContext(TrashModelContext);
  if (model === null) throw new Error("Trash was drawn with no model above it (TrashModelContext)");
  return model;
}
