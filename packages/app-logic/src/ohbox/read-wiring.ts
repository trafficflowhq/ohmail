/** The visit's wiring for the open message: what the reading column's pane and the shell's sheet are handed. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EngineMessage } from "@ohmail/client-engine";
import { LANDING_REST_MS, type ThreadReadWiring, type UnreadHold } from "../reading/reader-seen.js";
import { createThreadWalkChannel } from "../reading/thread-walk-channel.js";
import { recordIn, recordOf, type Hold } from "./hold.js";
import type { OhboxListInput, OhboxListModel } from "./types.js";

/** What the wiring reads beyond the hold. */
export interface WiringParts {
  shown: EngineMessage[];
  selected: EngineMessage | null;
  enter: (m: EngineMessage) => void;
  readByRule: (ids: string[]) => void;
  open: (m: EngineMessage) => void;
  selectByUser: (id: string) => void;
  markUnread: (m: EngineMessage) => void;
  returnToNew: (ids: readonly string[]) => void;
  unreadHold: UnreadHold;
}

export function useReadWiring(
  input: OhboxListInput,
  { selectedIdRef, allRef, markSeenRef, visit, landedOn, stayedOn, setStayedOn }: Hold,
  {
    shown,
    selected,
    enter,
    readByRule,
    open,
    selectByUser,
    markUnread,
    returnToNew,
    unreadHold,
  }: WiringParts,
): Pick<OhboxListModel, "wiring" | "walk" | "stripOpen"> {
  const { selectedId, onThreadRead } = input;
  /**
   * THE VISIT'S WIRING for the open message — the record of its conversation and the report-ups,
   * handed to the reading column's pane here and to the shell's sheet (`onThreadRead`). The
   * callbacks are stable; the record changes only with the conversation.
   */
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const enterSelected = useCallback(() => {
    const id = selectedIdRef.current;
    const m = id === null ? undefined : shownRef.current.find((x) => x.id === id);
    if (m) enter(m);
  }, [enter, selectedIdRef]);
  const markPanelUnread = useCallback(
    (id: string) => {
      const m = allRef.current.find((x) => x.id === id);
      if (m) {
        markUnread(m);
        return;
      }
      recordOf(
        visit,
        shownRef.current.find((x) => x.id === selectedIdRef.current),
      )?.keepUnread(id);
      returnToNew([id]);
      markSeenRef.current([id], true);
    },
    [markUnread, returnToNew, allRef, markSeenRef, selectedIdRef, visit],
  );
  const record = selected ? recordIn(visit, selected) : null;
  /**
   * THE CONVERSATION'S PLACE, shared by the reader's squares and its list row's strip
   * (`thread-walk-channel.ts`). One for the view's life; the reader (column or sheet) publishes to
   * it. It outlives the reader — closed, the row keeps its ring where the person stopped — and is
   * cleared once another conversation is chosen.
   */
  const [walk] = useState(createThreadWalkChannel);
  useEffect(() => {
    const s = walk.get();
    if (selectedId !== null && s !== null && !s.messages.some((m) => m.id === selectedId)) walk.clear();
  }, [selectedId, walk]);
  /** A press on the strip with no reader on screen: the row's own open (its target), the press then pending. */
  const stripOpen = (target: EngineMessage): void => {
    if (input.columnHidden()) {
      open(target);
    } else {
      selectByUser(target.id);
      enter(target);
    }
  };
  const landed = selected != null && landedOn === selected.id;
  /* A key landed on another letter and the selection has not followed yet (a seated list's selection is the address,
     named a commit after the key): this letter is being left. Unless it was entered it stays the preview it was, so
     nothing of a letter only passed is read or asked for in that commit. */
  const leaving = selected != null && landedOn !== null && landedOn !== selected.id;
  const entered = record?.entered ?? false;
  const wiring = useMemo<ThreadReadWiring | null>(
    () =>
      record
        ? {
            look: "tint",
            record,
            onRead: readByRule,
            onEnter: enterSelected,
            onMarkUnread: markPanelUnread,
            walk,
            hold: unreadHold,
            restMs: landed ? LANDING_REST_MS : undefined,
            previewing: (landed && stayedOn !== record && !entered) || (leaving && !entered),
            onStay: () => setStayedOn(record),
          }
        : null,
    [
      record,
      readByRule,
      enterSelected,
      markPanelUnread,
      walk,
      unreadHold,
      landed,
      leaving,
      entered,
      stayedOn,
      setStayedOn,
    ],
  );
  const onThreadReadRef = useRef(onThreadRead);
  onThreadReadRef.current = onThreadRead;
  useEffect(() => {
    onThreadReadRef.current?.(wiring);
  }, [wiring]);
  useEffect(() => () => onThreadReadRef.current?.(null), []);
  return { wiring, walk, stripOpen };
}
