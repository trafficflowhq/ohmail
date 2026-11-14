"use client";

/**
 * WHAT A STREAM WRITES (News, Receipts), moved from the web shell's open state word for word: the read rule's glances
 * batched into one mutation a pause (`readsSeenBatch`, `receiptsSeenBatch`), the leave's one anchored commit
 * (`commitFeedSeen`) and Mark all read with its true Undo (`markAllRead`).
 *
 * News's glances ride `feed_mark_seen` with ids only, never an anchor: the line holds still for the whole visit and
 * moves once, on the way out. Receipts' ride `mark_seen` as a glance. The leave drains the pending glances first, so
 * a departing visit's reads are on the wire before (and never instead of) the commit, and it sends nothing where it
 * would flip nothing and leave the line where it stands.
 */
import type { FeedView, WaterlineMeta } from "@ohmail/wire";
import { useMemo } from "react";
import { feedLineUndo, waterlineIdOf, type OhmailEngine } from "@ohmail/client-engine";
import type { UndoToastFn } from "../press/undo-door.js";
import { dispatchMarkAllRead, dispatchMarkAllUndo } from "../reading/read-all.js";
import { createSeenBatcher } from "../reading/seen-batch.js";
import type { StreamLeaveCommit } from "./leave.js";

/** How long the mark-all offer stands, longer than a plain sentence: the press is usually meant. */
const MARK_ALL_UNDO_MS = 6000;

/** The sentences Mark all read says: how many it marked, and its Undo. */
export interface MarkAllWords {
  readonly done: (count: number) => string;
  readonly undo: string;
}

export interface StreamWrites {
  /** The read rule's glances: batched, one mutation a pause. */
  readonly markSeen: (ids: readonly string[]) => void;
  /** The leave's one anchored commit. */
  readonly onLeaveSeen: (commit: StreamLeaveCommit) => void;
  /** Mark all read: the unread ids with their Undo, then the line to the top of the pile. */
  readonly markAllRead: (ids: readonly string[], top: string | null) => void;
  /** Send the pending glances now (the tab going away, the place unmounting). */
  readonly flush: () => void;
}

export function useStreamWrites(
  engine: OhmailEngine,
  view: FeedView,
  undoToast: UndoToastFn,
  words: MarkAllWords,
): StreamWrites {
  const batch = useMemo(
    () =>
      createSeenBatcher((ids) => {
        void engine.mutate(
          view === "reads"
            ? { kind: "feed_mark_seen", view: "reads", messageIds: ids }
            : { kind: "mark_seen", messageIds: ids, unread: false, via: "glance" },
        );
      }),
    [engine, view],
  );
  return useMemo((): StreamWrites => {
    const onLeaveSeen = (commit: StreamLeaveCommit): void => {
      // The departing visit's pending glances go first.
      batch.flushNow();
      const held = engine.read().get<WaterlineMeta>("view_meta", waterlineIdOf(view));
      if (commit.messageIds.length === 0 && held?.newestSeenId === commit.upToId) return;
      void engine.mutate({
        kind: "feed_mark_seen",
        view,
        upToId: commit.upToId,
        messageIds: [...commit.messageIds],
      });
    };
    return {
      markSeen: (ids) => {
        for (const id of ids) batch.add(id);
      },
      onLeaveSeen,
      /* The press clears both statements the place makes: the unread ids ride the chunked `mark_seen`, and the line
         commits to the top through the leave's own writer. Its Undo flips back exactly the ids this press flipped,
         then puts the line back as it stood before the press, so mail already read before it stays read. */
      markAllRead: (ids, top) => {
        if (ids.length > 0) {
          const line = feedLineUndo(engine.read(), view);
          dispatchMarkAllRead((m) => engine.mutate(m), ids);
          undoToast(words.done(ids.length), {
            action: words.undo,
            undo: true,
            onAction: () => void dispatchMarkAllUndo((m) => engine.mutate(m), ids, line),
            duration: MARK_ALL_UNDO_MS,
          });
        }
        if (top !== null) onLeaveSeen({ upToId: top, messageIds: [] });
      },
      flush: () => batch.flushNow(),
    };
  }, [batch, engine, view, undoToast, words]);
}
