/**
 * The visit: entering a conversation, the cursor moved by the person, the open, and the departures that end a visit
 * (the selection taken away, the view gone, the reader sheet closed).
 */
import { useCallback, useEffect, useRef } from "react";
import { isOwnSent } from "@ohmail/client-engine";
import type { EngineMessage, OhboxRow as OhboxRowGroup } from "@ohmail/client-engine";
import { recordIn, type Hold } from "./hold.js";
import type { Suspended } from "./undo.js";
import type { OhboxListInput } from "./types.js";

/** Entering a conversation, and the rule's reads while it is open. */
export interface Enter {
  enter: (m: EngineMessage) => void;
  readByRule: (ids: string[]) => void;
}

export function useEnter(
  navRows: OhboxRowGroup[],
  rowIndexOf: (id: string | null) => number,
  { visit, setEntered, heldRead, hold, markSeenRef }: Hold,
): Enter {
  /**
   * ENTER THE CONVERSATION — ↵, a click or tap on its row or on a search hit (`enterId`), → into the
   * column, or a press, a hand scroll or a square inside it. A row still waiting (an unread message,
   * or an unread letter anywhere in its conversation: it opens on its newest, read or not) takes its hold at once and
   * nothing is written: what turns read is the rule's (`reader-seen.ts`). A read conversation holds
   * nothing, as before. A preview (j/k, the after-verb advance, a URL landing, an Undo) reads nothing,
   * except that a landing by j/k, the advance or an Undo comes through here once rested on (`landedOn`).
   */
  const waitingRef = useRef((_m: EngineMessage): boolean => false);
  waitingRef.current = (x) =>
    navRows[rowIndexOf(x.id)]?.members.some((y) => y.unread && !isOwnSent(y)) ?? false;
  const enter = useCallback(
    (m: EngineMessage) => {
      const record = recordIn(visit, m);
      const was = record.entered;
      record.enter(Date.now());
      if (!was) setEntered((n) => n + 1);
      if (heldRead.current !== m.id && (m.unread || waitingRef.current(m))) hold(m.id);
    },
    [visit, setEntered, heldRead, hold],
  );

  /**
   * THE RULE'S READS — one glance per look, written as each message's top completes its dwell, so
   * the read is on the durable outbox while the message is open. A glance spends no resurface pin.
   */
  const readByRule = useCallback(
    (ids: string[]) => {
      void markSeenRef.current(ids, false, "glance");
    },
    [markSeenRef],
  );
  return { enter, readByRule };
}

/** The cursor moved by the person, and the open. */
export interface Visit {
  selectByUser: (id: string, extend?: boolean) => void;
  open: (m: EngineMessage) => void;
  engage: (m: EngineMessage) => void;
}

export function useVisit(
  input: OhboxListInput,
  { heldRead, visit, keptForPick, leaveRead, landedOn, setLandedOn }: Hold,
  picked: Set<string>,
  selected: EngineMessage | null,
  enter: (m: EngineMessage) => void,
  suspended: Suspended["suspended"],
): Visit {
  const { selectedId, onSelect, onEnterReader, enterId = null, onEntered } = input;
  useEffect(() => {
    if (landedOn !== null && selectedId !== null && selectedId !== landedOn) setLandedOn(null);
  }, [selectedId, landedOn, setLandedOn]);

  /**
   * Move the cursor because the USER moved it — j, k, and the first click on a row (which enters it
   * too). Landing on a different message is leaving the one before it: its place is let go and its
   * visit ends. A move onto the SAME id releases nothing. While a pick is being built (`extend`, or a
   * live set) the held row keeps its place until the pick ends: a re-file under a range moves its ends.
   */
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const selectByUser = useCallback(
    (id: string, extend = false) => {
      if (heldRead.current !== id) {
        if ((extend || pickedRef.current.size > 0) && heldRead.current !== null) {
          visit.current.clear();
          keptForPick.current = heldRead.current;
        } else leaveRead();
      }
      onSelect(id);
    },
    [onSelect, leaveRead, heldRead, visit, keptForPick],
  );
  /* The pick ended: the place kept for it is let go, unless the cursor came back to the row. */
  const picking = picked.size > 0;
  useEffect(() => {
    const kept = keptForPick.current;
    if (picking || kept === null) return;
    keptForPick.current = null;
    if (heldRead.current === kept && selectedId !== kept) leaveRead();
  }, [picking, selectedId, leaveRead, keptForPick, heldRead]);

  /**
   * Opening a message — Enter, a second click on the selected row, a tap where there is no column.
   * `onEnterReader` is a statement of intent: the shell answers with the reader only where the
   * reading column is hidden. It also pins the selection via `onSelect`, so `open` is a complete
   * statement on its own. It enters the conversation; the rule reads what is on screen.
   */
  const open = useCallback(
    (m: EngineMessage) => {
      onSelect(m.id);
      enter(m);
      onEnterReader(m.id);
    },
    [onSelect, onEnterReader, enter],
  );

  /**
   * Stepping into the pane with → is entering it — `open` minus the reader raise. Where the column
   * is hidden the zone hook calls `open` instead (`onHiddenEnter`).
   */
  const engage = useCallback(
    (m: EngineMessage) => {
      enter(m);
    },
    [enter],
  );

  /* A hit's open enters once its row is shown; a selection that moved on first drops it. Only
     `enter`: the row was not pressed, so its Forward target and Move seed stay the landing's. */
  const onEnteredRef = useRef(onEntered);
  onEnteredRef.current = onEntered;
  const enterSel = selected?.id === enterId ? selected : null;
  /* Keyed on the hit's id, the message read when it fires: the same hit redrawn (its flags moved) is not a second
     open, so a ref carries the message and the id is the key. */
  const enterSelRef = useRef(enterSel);
  enterSelRef.current = enterSel;
  const enterSelId = enterSel?.id;
  useEffect(() => {
    const enterSel = enterSelRef.current;
    if (enterId == null) return;
    if (enterSel) enter(enterSel);
    else if (selectedId === enterId) return; // the row is not shown yet
    onEnteredRef.current?.();
  }, [enterId, enterSelId, selectedId, enter]);

  /**
   * The selection taken away from outside is a departure. The URL carries the open message, so
   * Back on `#/ohbox/m/A` clears the SHELL's selection while this view stays mounted — a way of
   * leaving A none of the other departures sees. So the cursor prop going null releases the held
   * place and ends the visit.
   */
  const prevSelectedId = useRef(selectedId);
  useEffect(() => {
    const prev = prevSelectedId.current;
    prevSelectedId.current = selectedId;
    // A TRANSITION to null, not the resting state: only a selection that existed and was taken
    // away is a departure.
    if (selectedId !== null || prev === null) return;
    /* A VERB TOOK THE ROW: its hold stays until Undo or a move decides, so Undo finds its place. */
    if (suspended.current?.id === prev) return;
    if (heldRead.current === null && visit.current.size === 0) return;
    leaveRead();
  }, [selectedId, leaveRead, suspended, heldRead, visit]);
  return { selectByUser, open, engage };
}

export function useDepartures(
  input: OhboxListInput,
  leaveRead: () => void,
  suspended: Suspended["suspended"],
): void {
  const { readerId, columnHidden } = input;
  /**
   * ═══ DEPARTURES #2, #3 AND #4 ═════════════════════════════════════════════════════════════
   *
   * #1 is the cursor moving, and it lives in `selectByUser` because that is where a cursor move
   * happens. The other three are things that happen TO this view rather than in it, so they are
   * effects.
   */

  /**
   * #2 — the view goes away. Switching views unmounts this component, and
   * leaving the Ohbox is leaving the message open in it: the hold ends, so
   * the shell's sheet stops presenting it as held. The cleanup is the whole
   * effect, which only works because {@link leaveRead} has a stable identity.
   */
  useEffect(() => leaveRead, [leaveRead]);

  /**
   * #3 — the reader sheet closes, and only where the sheet WAS the reading. Below 700px there
   * is no reading column: dismissing the sheet is leaving the message, and on a phone it is
   * usually the only departure. At a split width the column goes on showing the same message,
   * so releasing its place there would slide the row away while it is being read. The width is
   * asked at the moment the sheet closes: a rotated device is judged by where the reading ended.
   */
  const prevReaderId = useRef<string | null>(readerId);
  /**
   * THE CURSOR STAYS ON THE ROW READ. Leaving files the held row under Earlier and the cursor goes
   * with it, as at a split width: a verb pressed next acts on the letter just read, never a neighbour.
   */
  useEffect(() => {
    const was = prevReaderId.current;
    const closed = was !== null && readerId === null;
    prevReaderId.current = readerId;
    if (!closed) return;
    if (suspended.current?.id === was) {
      suspended.current.reader = true;
      suspended.current.reader0 = null;
      return;
    }
    if (typeof globalThis.matchMedia !== "function") return;
    if (!columnHidden()) return;
    leaveRead();
    // The width is asked when the sheet closes; a change of the asker alone closes nothing (`closed` is false).
  }, [readerId, leaveRead, suspended, columnHidden]);

  /**
   * #4 — the tab goes away, and it OWES NOTHING: the read was saved at the arm, so a reload, a
   * close or a phone discarding a hidden tab finds it on the outbox already. A `pagehide` write
   * used to be the only one for a message left open, and it never survived the unload.
   */
}
