/**
 * Undo's answer: the row a verb took from under the cursor, as it stood, until the person moves on; and the link the
 * shell asks before it sends a reversal.
 */
import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import type { UndoLink } from "../press/shell-dispatch.js";
import type { Hold } from "./hold.js";
import type { OhboxListInput } from "./types.js";

/** The record of the row a verb took, as it stood: its hold and the sheet. */
export interface SuspendedRow {
  id: string;
  held: boolean;
  reader: boolean;
  sel: string | null;
  reader0: string | null;
  held0: string | null;
}

/** The record, how a verb starts it and how moving on spends it, and the row moved on from. */
export interface Suspended {
  suspended: MutableRefObject<SuspendedRow | null>;
  suspend: (id: string) => void;
  spendSuspended: () => void;
  leftFrom: MutableRefObject<string | null>;
  onSelectRef: MutableRefObject<OhboxListInput["onSelect"]>;
  onEnterReaderRef: MutableRefObject<OhboxListInput["onEnterReader"]>;
  onRestoreHoldRef: MutableRefObject<OhboxListInput["onRestoreHold"]>;
}

export function useSuspended(input: OhboxListInput, { heldRead, leaveRead }: Hold): Suspended {
  const { selectedId, readerId, onSelect, onEnterReader, onRestoreHold } = input;
  /**
   * THE ROW A VERB TOOK FROM UNDER THE CURSOR, as it stood: its read hold and the sheet. `sel`,
   * `reader0` and `held0` are the selection, sheet and hold the verb itself left; ANY later change
   * of one of them, by any door, is moving on and spends the record.
   */
  const suspended = useRef<{
    id: string;
    held: boolean;
    reader: boolean;
    sel: string | null;
    reader0: string | null;
    held0: string | null;
  } | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onEnterReaderRef = useRef(onEnterReader);
  onEnterReaderRef.current = onEnterReader;
  const onRestoreHoldRef = useRef(onRestoreHold);
  onRestoreHoldRef.current = onRestoreHold;

  /**
   * MOVING ON, ONCE: the selection, the sheet or the hold changing after the verb, by any door (a
   * key, a click, →, a URL, a search, Back, Escape) — the verb's own advance excepted. It spends
   * the record and lets go of the row's hold, so nothing stays in New nobody is on.
   */
  /* Two callbacks, so the landing and Undo's effects key on them: the record is spent the same way for the
     hook's life, and a verb's record is taken with this render's selection and sheet. */
  const spendSuspended = useCallback((): void => {
    const s = suspended.current;
    suspended.current = null;
    if (s && heldRead.current === s.id) leaveRead();
  }, [heldRead, leaveRead]);
  const suspend = useCallback(
    (id: string): void => {
      spendSuspended();
      suspended.current = {
        id,
        held: heldRead.current === id,
        reader: false,
        sel: selectedId,
        reader0: readerId,
        held0: heldRead.current,
      };
    },
    [spendSuspended, heldRead, selectedId, readerId],
  );
  /* THE ROW MOVED ON FROM, kept past its record: an Undo of it says it was not deleted, never
     that it is where it was — it files under Earlier, as any row read and left does. */
  const leftFrom = useRef<string | null>(null);
  return { suspended, suspend, spendSuspended, leftFrom, onSelectRef, onEnterReaderRef, onRestoreHoldRef };
}

export function useUndoAnswer(
  input: OhboxListInput,
  { heldRow, hold, setLandedOn }: Hold,
  { suspended, spendSuspended, leftFrom, onSelectRef, onEnterReaderRef, onRestoreHoldRef }: Suspended,
  verbAdvance: MutableRefObject<string | null>,
): void {
  const { selectedId, readerId, undoLink } = input;
  useEffect(() => {
    const s = suspended.current;
    if (!s || (selectedId === s.sel && readerId === s.reader0 && heldRow === s.held0)) return;
    // Delete clears the selection; Park and Later leave it on the acted row.
    if (
      (s.sel === null || s.sel === s.id) &&
      selectedId !== null &&
      selectedId === verbAdvance.current &&
      readerId === s.reader0 &&
      heldRow === s.held0
    ) {
      s.sel = selectedId;
      verbAdvance.current = null;
      return;
    }
    leftFrom.current = s.id;
    spendSuspended();
    // The refs and `spendSuspended` keep their identity: it runs when the selection, the sheet or the hold change.
  }, [selectedId, readerId, heldRow, suspended, verbAdvance, leftFrom, spendSuspended]);

  /**
   * UNDO PUTS IT BACK AS IT STOOD AT THE PRESS — asked by the shell before the reversal is sent.
   * `ask` re-takes the hold, so the row lands in New; `settle` restores the cursor and the sheet
   * only when THAT row's reversal took, and lets the hold go when it did not. The restore is a
   * landing: nothing is read by it unless the cursor rests there.
   */
  useEffect(() => {
    if (!undoLink) return;
    const link: UndoLink = {
      ask: (ids) => {
        const s = suspended.current;
        if (!s || !ids.includes(s.id)) return null;
        if (s.held && !onRestoreHoldRef.current?.(s.id)) {
          spendSuspended();
          return null;
        }
        return s.id;
      },
      settle: (id, applied) => {
        const s = suspended.current;
        if (!s || s.id !== id) return;
        if (!applied) {
          spendSuspended();
          return;
        }
        suspended.current = null;
        if (s.held) hold(s.id);
        onSelectRef.current(s.id);
        setLandedOn(s.id);
        if (s.reader) onEnterReaderRef.current(s.id);
      },
      left: (ids) => {
        const id = leftFrom.current;
        if (id === null || !ids.includes(id)) return false;
        leftFrom.current = null;
        return true;
      },
    };
    undoLink.current = link;
    return () => {
      if (undoLink.current === link) undoLink.current = null;
    };
    // Every one keeps its identity for the hook's life: the link is written once per Undo door.
  }, [
    undoLink,
    hold,
    setLandedOn,
    suspended,
    spendSuspended,
    leftFrom,
    onSelectRef,
    onEnterReaderRef,
    onRestoreHoldRef,
  ]);
}
