/**
 * THE CURSOR: an index into the RENDERED slots that stays on its hit as they re-derive, reset when the question
 * changes. Only a moved cursor holds a hit: an untouched one stays on the top row while the device's paint gives way
 * to the store's answer, whose top can be another letter.
 */
import { useEffect, useState } from "react";

export interface SearchCursor {
  /** The cursor's slot, -1 on an empty list. */
  readonly at: number;
  /** Move the cursor to a slot, holding the hit on it. */
  stepTo(i: number): void;
}

export function useSearchCursor(
  asked: string,
  count: number,
  idAt: (i: number) => string | null,
): SearchCursor {
  const [pos, setPos] = useState<{ asked: string; i: number; id: string | null }>({ asked, i: 0, id: null });
  const held = pos.asked === asked ? pos : { asked, i: 0, id: null };
  /* THE CURSOR STAYS ON ITS HIT: a hit listed above it later moves the hit's slot, never the cursor. */
  const at = (() => {
    if (count === 0) return -1;
    const i = Math.min(held.i, count - 1);
    if (held.id === null || idAt(i) === held.id) return i;
    for (let k = 0; k < count; k++) if (idAt(k) === held.id) return k;
    return i;
  })();
  const atId = at < 0 ? null : (idAt(at) ?? held.id);
  const atSlot = Math.max(at, 0);
  useEffect(() => {
    if (pos.asked !== asked) setPos({ asked, i: 0, id: null });
    else if (pos.i !== atSlot || (pos.id !== null && pos.id !== atId)) {
      setPos({ asked, i: atSlot, id: pos.id === null ? null : atId });
    }
  }, [pos.asked, pos.i, pos.id, asked, atSlot, atId]);
  return { at, stepTo: (i) => setPos({ asked, i, id: idAt(i) }) };
}
