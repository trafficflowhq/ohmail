/**
 * A RESULT OPENED FROM SEARCH, live: where the letter is presented (`openTargetOf`), asked at the press of the mirror
 * as the ground presents it, and sent there through the frame's own commands, as entered: the place that lists it
 * enters its row once. A place this host does not hand cannot show it: the letter then opens in Search's own reading
 * column, as a letter no pile holds does. Nothing here runs per keystroke: every pile is read at the press.
 */
import {
  feedPartition,
  ohboxView,
  parkedMessageIds,
  receiptsByDay,
  resurfacedThreads,
  type EntityReader,
  type OhmailEngine,
  type SearchHit,
} from "@ohmail/client-engine";
import type { EngineMessage, FolderEntity } from "@ohmail/wire";
import type { PlaceLiveArgs, PlaceLiveTarget, PlaceName } from "../lists/place-live.js";
import { useStableCallback } from "../press/stable-callback.js";
import { ohboxSurfaceMessages } from "../reading/ohbox-surface.js";
import {
  openTargetOf,
  type SearchOpenFacts,
  type SearchOpenTarget,
  type SearchScreenerSegment,
} from "./open-target.js";

/** A Screener row as the Screener's model lists it: its id, and whose letters it speaks for. */
export interface SearchScreenerRow {
  readonly id: string;
  readonly held: readonly { readonly id: string }[];
}

/** What only Search's seat can answer about the open. */
export interface SearchOpenOwn {
  /** The Screener's rows of a segment, as its one model lists them now. */
  readonly screenerRows: (segment: SearchScreenerSegment) => readonly SearchScreenerRow[];
  /** Whether this host hands a place: one it does not hand cannot show the letter. */
  readonly handed: (place: PlaceName) => boolean;
}

/** What the open reads of the ground and the account, as they stand in this render. */
export interface SearchOpenGround {
  readonly engine: OhmailEngine;
  readonly presented: EntityReader;
  /** Where the consent cutline presents each letter; null where no partition stands. */
  readonly placeOf: NonNullable<SearchOpenFacts["placeOf"]> | null;
  readonly foldersEnabled: boolean;
  /** The day clock's now, which the Receipts pile is read at. */
  readonly now: Date;
}

/** Whether a pile's own list holds the letter now. The Ohbox's older pages are its own: a row there is not counted. */
function holdsOf(ground: SearchOpenGround): NonNullable<SearchOpenFacts["holds"]> {
  const { engine, presented, now } = ground;
  return (view, id) => {
    if (view === "ohbox") {
      const shown = ohboxView(presented, engine.openRowHeld());
      return ohboxSurfaceMessages(resurfacedThreads(presented), shown, []).some((m) => m.id === id);
    }
    if (view === "receipts")
      return receiptsByDay(presented, now).some((day) => day.items.some((m) => m.id === id));
    const reads = feedPartition(presented, "reads");
    return reads.fresh.some((m) => m.id === id) || reads.seen.some((m) => m.id === id);
  };
}

/** The folder entity whose view lists the letter, mailbox-scoped, only where the presented mirror holds it there. */
function folderOf(ground: SearchOpenGround): NonNullable<SearchOpenFacts["folderTargetFor"]> {
  const { presented, foldersEnabled } = ground;
  return (m, folder) => {
    if (!foldersEnabled) return null;
    const f = presented
      .list<FolderEntity>("folder")
      .find((x) => x.mailboxId === m.mailboxId && x.name === folder);
    if (!f) return null;
    return presented.get<EngineMessage>("message", m.id)?.folder === folder ? f.id : null;
  };
}

/** The place an open goes to, by the frame's names; null opens in Search's own column. */
function frameTargetOf(target: SearchOpenTarget): PlaceLiveTarget | null {
  switch (target.kind) {
    case "ohbox":
      return { place: "ohbox", open: target.id };
    case "stream":
      return { place: target.view === "reads" ? "news" : "receipts", open: target.id };
    case "screener":
      return {
        place: "screener",
        sub: target.segment === "waiting" ? null : target.segment,
        open: target.letter ?? target.row,
      };
    case "folder":
      return { place: "folder", sub: target.folderId, open: target.id };
    case "reader":
      return null;
  }
}

/** The open act Search's model is handed: one function for the hook's life, reading the newest of everything. */
export function useSearchOpen(
  args: PlaceLiveArgs,
  ground: SearchOpenGround,
  own: SearchOpenOwn,
  carry: (message: EngineMessage) => void,
): (hit: SearchHit) => void {
  return useStableCallback((hit: SearchHit) => {
    const m = hit.message;
    const target = openTargetOf(m, {
      rowFor: (letter, segment) => {
        return (
          own
            .screenerRows(segment)
            .find((row) => row.id === letter.id || row.held.some((member) => member.id === letter.id))?.id ??
          null
        );
      },
      ...(ground.placeOf ? { placeOf: ground.placeOf } : {}),
      parked: parkedMessageIds(ground.presented),
      holds: holdsOf(ground),
      folderTargetFor: folderOf(ground),
    });
    const there = frameTargetOf(target);
    if (there !== null && own.handed(there.place)) args.commands.go(there, { entered: true });
    else {
      carry(m);
      args.commands.go({ ...args.route, open: m.id }, { entered: true });
    }
  });
}
