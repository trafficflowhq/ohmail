/**
 * TRASH'S MODEL. Above: what ohmail deleted, newest deletion first, read through the one paged window
 * (`lists/trash-page`), each row saying when it was deleted and where Restore puts it. Restore is the press seam's
 * held window, by the row's id: the server resolves the folder, never this side. Below: the mail server's own Trash,
 * read-only, through the host's wire or withheld.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { TrashRowWire } from "@ohmail/client-engine";
import { useEngine } from "../engine/context.js";
import { useTrashPage, type TrashPage } from "../lists/trash-page.js";
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
  readonly restore: (target: DeleteTarget) => boolean;
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
}

export interface TrashModel {
  readonly page: TrashPage;
  readonly live: TrashWindowControl & { readonly state: TrashLiveState; readonly shown: boolean };
  /** The deleted letter open, if the open id names one. */
  readonly openRow: TrashRowWire | null;
  /** The live row open, if the open id names one. */
  readonly openLive: TrashWindowItemWire | null;
  readonly openId: string | null;
  readonly open: (id: string | null) => void;
  /** Restore the row: where it goes is the server's record. */
  readonly restore: (row: TrashRowWire) => void;
  /** Whether the row reads as unread: its own state, or the read slot's last press on it this visit. */
  readonly unreadOf: (row: TrashRowWire) => boolean;
  /** The read slot: the row turns unread when it reads as read, and read when it reads as unread. */
  readonly flipRead: (row: TrashRowWire) => void;
  readonly stamp: (iso: string) => string;
  readonly placeOf: (folder: string) => string;
}

export function useTrashList(input: TrashInput): TrashModel {
  const engine = useEngine();
  const page = useTrashPage(engine, true, input.held, input.landed, input.restored);
  const window = useTrashWindow(true, input.wire);
  const state = trashLiveState(window);
  const { openId, open, restore: seamRestore } = input;
  const openRow = openId === null ? null : (page.items.find((r) => r.id === openId) ?? null);
  const openLive = openId === null ? null : (window.items.find((i) => trashLiveKeyOf(i) === openId) ?? null);
  /* A live row's text is read when it is opened, once a visit. */
  const { openBody } = window;
  useEffect(() => {
    if (openLive !== null) openBody(openLive);
  }, [openLive, openBody]);
  /* One act per press: a row pressed again before the seam's window shows it held is not a second restore. It may be
     pressed again once Undo has given it back. */
  const pressed = useRef(new Set<string>());
  const { held } = input;
  useEffect(() => {
    for (const id of [...pressed.current]) if (!held.has(id)) pressed.current.delete(id);
  }, [held]);
  const restore = useCallback(
    (row: TrashRowWire) => {
      if (pressed.current.has(row.id) || held.has(row.id)) return;
      pressed.current.add(row.id);
      const acted = seamRestore({ id: row.id, mailboxId: row.mailboxId });
      if (!acted) {
        pressed.current.delete(row.id);
        return;
      }
      if (openId === row.id) open(null);
    },
    [seamRestore, held, openId, open],
  );
  /* The page is no mirror: the slot's press is what the row reads as for the visit. */
  const [flipped, setFlipped] = useState<ReadonlyMap<string, boolean>>(new Map());
  const unreadOf = useCallback((row: TrashRowWire) => flipped.get(row.id) ?? row.unread, [flipped]);
  const { markSeen } = input;
  const flipRead = useCallback(
    (row: TrashRowWire) => {
      const unread = !unreadOf(row);
      const put = (to: boolean) => setFlipped((was) => new Map(was).set(row.id, to));
      put(unread);
      void Promise.resolve(markSeen([row.id], unread)).then((acted) => {
        if (acted === false) put(!unread);
      });
    },
    [markSeen, unreadOf],
  );
  return {
    page,
    live: { ...window, state, shown: input.wire !== "none" },
    openRow,
    openLive,
    openId,
    open,
    restore,
    unreadOf,
    flipRead,
    stamp: input.stamp,
    placeOf: input.placeOf,
  };
}

export const TrashModelContext = createContext<TrashModel | null>(null);

export function useTrashModel(): TrashModel {
  const model = useContext(TrashModelContext);
  if (model === null) throw new Error("Trash was drawn with no model above it (TrashModelContext)");
  return model;
}
