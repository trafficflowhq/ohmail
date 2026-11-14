/**
 * WHAT STANDS ABOVE THE SCREENER'S PANES, and the only place it is stood: the frame's one model, what the shell
 * hands beside it, the sender open in each section, and the commit of every waiting decision once the list leaves
 * its place or its section.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ScreenerState } from "@ohmail/app-logic/screener";
import {
  ScreenerAboveContext,
  type ScreenerAboveValue,
  type ScreenerBeside,
  type ScreenerPicked,
  viewCell,
} from "./contract.js";

type Selected = Readonly<Record<ScreenerPicked, string | null>>;
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
  const select = useCallback((segment: ScreenerPicked, id: string | null) => {
    setSelected((was) => (was[segment] === id ? was : { ...was, [segment]: id }));
  }, []);
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
    () => ({ model, beside, selected: (segment) => selected[segment], select, standing, cell }),
    [model, beside, selected, select, standing, cell],
  );
  return <ScreenerAboveContext.Provider value={value}>{children}</ScreenerAboveContext.Provider>;
}
