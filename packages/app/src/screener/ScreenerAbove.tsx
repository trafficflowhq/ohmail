/**
 * WHAT STANDS ABOVE THE SCREENER'S PANES, and the only place it is stood: the frame's one model, what the shell
 * hands beside it, the sender open in each section, and the commit of every waiting decision once the list leaves
 * its place or its section.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { screenerSenderKey, type ScreenerState } from "@ohmail/app-logic/screener";
import {
  ScreenerAboveContext,
  type ScreenerAboveValue,
  type ScreenerBeside,
  type ScreenerPicked,
  viewCell,
} from "./contract.js";

interface Cursor {
  readonly id: string;
  readonly senderKey: string | undefined;
  readonly hasDuplicate: boolean;
}

type Selected = Readonly<Record<ScreenerPicked, Cursor | null>>;
const NOTHING: Selected = { waiting: null, screened: null, spam: null, junk: null };

export function ScreenerAbove({
  model,
  beside,
  children,
}: {
  model: ScreenerState;
  beside: ScreenerBeside;
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<Selected>(NOTHING);
  const [cell] = useState(viewCell);
  const waiting = model.waiting;
  const select = useCallback(
    (segment: ScreenerPicked, id: string | null) => {
      const row =
        segment === "waiting" && id !== null ? waiting.find((sender) => sender.id === id) : undefined;
      const senderKey = row === undefined ? undefined : screenerSenderKey(row);
      const hasDuplicate =
        senderKey !== undefined &&
        waiting.some((sender) => sender.id !== id && screenerSenderKey(sender) === senderKey);
      const next = id === null ? null : { id, senderKey, hasDuplicate };
      setSelected((was) =>
        was[segment]?.id === next?.id &&
        was[segment]?.senderKey === next?.senderKey &&
        was[segment]?.hasDuplicate === next?.hasDuplicate
          ? was
          : { ...was, [segment]: next },
      );
    },
    [waiting],
  );
  const cursor = selected.waiting;
  const resolved = useMemo(() => {
    if (cursor?.senderKey === undefined) return cursor;
    const matches = waiting.filter((row) => screenerSenderKey(row) === cursor.senderKey);
    if (matches.some((row) => row.id === cursor.id)) {
      const hasDuplicate = matches.length > 1;
      return hasDuplicate === cursor.hasDuplicate ? cursor : { ...cursor, hasDuplicate };
    }
    // A current match can replace the pick only if it was also the sender's only row before the refresh.
    if (!cursor.hasDuplicate && matches.length === 1) return { ...cursor, id: matches[0]!.id };
    // Leave the missing ID for the view's ordinary fallback and stop tracking its sender.
    return { id: cursor.id, senderKey: undefined, hasDuplicate: false };
  }, [cursor, waiting]);
  useLayoutEffect(() => {
    if (cursor === resolved) return;
    setSelected((was) => (was.waiting === cursor ? { ...was, waiting: resolved } : was));
  }, [cursor, resolved]);
  const waitingId = resolved?.id ?? null;
  /* The latest model's flush, read at the moment the list moves: a press made since must not be left behind. */
  const flush = useRef(model.flush);
  flush.current = model.flush;
  const where = useRef<string | null>(null);
  const standing = useCallback((now: string | null) => {
    if (where.current !== null && now !== where.current) flush.current();
    where.current = now;
  }, []);
  /* Taken down with the frame: nothing in its window is left uncommitted. */
  useEffect(() => () => flush.current(), []);
  const value: ScreenerAboveValue = useMemo(
    () => ({
      model,
      beside,
      selected: (segment) => (segment === "waiting" ? waitingId : (selected[segment]?.id ?? null)),
      select,
      standing,
      cell,
    }),
    [model, beside, selected, waitingId, select, standing, cell],
  );
  return <ScreenerAboveContext.Provider value={value}>{children}</ScreenerAboveContext.Provider>;
}
