/**
 * The read hold and the visit's record: the row being read keeps its place, and the visit's record says what of its
 * conversation was entered. Refs that stable callbacks read the list, the cursor and the writer through.
 */
import type { EngineMessage } from "@ohmail/wire";
import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { conversationKeyOf, createThreadRead } from "@ohmail/client-engine";
import type { ThreadRead } from "@ohmail/client-engine";
import type { OhboxListInput } from "./types.js";

/**
 * The visit's read record for `m`'s conversation, made on first ask. Keyed by conversation and
 * kept to the two latest, so a render that still shows the previous selection cannot replace the
 * visit just entered; a departure clears them all.
 */
export function recordIn(visits: MutableRefObject<Map<string, ThreadRead>>, m: EngineMessage): ThreadRead {
  const key = conversationKeyOf(m);
  let record = visits.current.get(key);
  if (!record) {
    record = createThreadRead();
    visits.current.set(key, record);
    for (const k of visits.current.keys()) {
      if (visits.current.size <= 2) break;
      visits.current.delete(k);
    }
  }
  return record;
}
export const recordOf = (
  visits: MutableRefObject<Map<string, ThreadRead>>,
  m: EngineMessage | null | undefined,
): ThreadRead | undefined => (m ? visits.current.get(conversationKeyOf(m)) : undefined);

/** The hold, the visit, the landing, and the refs the list's stable callbacks read. */
export interface Hold {
  allRef: MutableRefObject<EngineMessage[]>;
  selectedIdRef: MutableRefObject<string | null>;
  markSeenRef: MutableRefObject<OhboxListInput["onMarkSeen"]>;
  readSetForRef: MutableRefObject<OhboxListInput["readSetFor"]>;
  heldRead: MutableRefObject<string | null>;
  heldRow: string | null;
  keptForPick: MutableRefObject<string | null>;
  hold: (id: string | null) => void;
  visit: MutableRefObject<Map<string, ThreadRead>>;
  setEntered: Dispatch<SetStateAction<number>>;
  landedOn: string | null;
  setLandedOn: Dispatch<SetStateAction<string | null>>;
  stayedOn: ThreadRead | null;
  setStayedOn: Dispatch<SetStateAction<ThreadRead | null>>;
  leaveRead: () => void;
}

export function useHold(input: OhboxListInput, all: EngineMessage[]): Hold {
  const { selectedId, onMarkSeen, readSetFor, onHoldRow } = input;
  /* ── read-state ────────────────────────────────────────────────────────── */

  /**
   * The list, the cursor and the writer, readable from callbacks that must stay stable (the rule's
   * read report-up is handed to the pane and the sheet). Assigned in render, so a callback fired
   * between two renders reads the newer answer.
   */
  const allRef = useRef(all);
  allRef.current = all;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const markSeenRef = useRef(onMarkSeen);
  markSeenRef.current = onMarkSeen;
  const readSetForRef = useRef(readSetFor);
  readSetForRef.current = readSetFor;

  /**
   * THE ROW BEING READ HOLDS ITS PLACE. The one message whose conversation the person entered: the
   * engine holds its row in New (`holdOpenRow`, through `onHoldRow`) until it is left or answered, so
   * every read the thread-read rule makes meanwhile is an OPEN read and leaving files the row at the
   * top of Earlier. At most one. The ref is for code outside a render; the state is for the effects
   * that key on the hold (the after-verb record below).
   */
  const heldRead = useRef<string | null>(null);
  const [heldRow, setHeldRow] = useState<string | null>(null);
  const onHoldRowRef = useRef(onHoldRow);
  onHoldRowRef.current = onHoldRow;
  /** The held row a cursor move left while a pick was live: it keeps its place until the pick ends. */
  const keptForPick = useRef<string | null>(null);
  const hold = useCallback((id: string | null) => {
    keptForPick.current = null;
    heldRead.current = id;
    setHeldRow(id);
    onHoldRowRef.current?.(id);
  }, []);

  /**
   * THE VISIT'S READ RECORD (`createThreadRead`), one per open conversation: renewed only when the
   * open conversation changes (keyed by `conversationKeyOf`, so a second click on its row keeps
   * it) and ended by every departure. Nothing is read until the visit is ENTERED;
   * `entered` bumps a render so the pane looks again at once.
   */
  const visit = useRef(new Map<string, ThreadRead>());
  const [, setEntered] = useState(0);
  /** The message j/k, a verb's advance or an Undo put the cursor on: resting there enters it (`LANDING_REST_MS`). */
  const [landedOn, setLandedOn] = useState<string | null>(null);
  /** The landing the cursor stayed the rest's length on, a command or not: its pictures load. */
  const [stayedOn, setStayedOn] = useState<ThreadRead | null>(null);

  /** Leaving the held message: its place is released and the visit's record ends. Writes nothing. */
  const leaveRead = useCallback(() => {
    visit.current.clear();
    if (heldRead.current != null) hold(null);
  }, [hold]);
  return {
    allRef,
    selectedIdRef,
    markSeenRef,
    readSetForRef,
    heldRead,
    heldRow,
    keptForPick,
    hold,
    visit,
    setEntered,
    landedOn,
    setLandedOn,
    stayedOn,
    setStayedOn,
    leaveRead,
  };
}
