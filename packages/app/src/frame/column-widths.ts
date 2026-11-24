/**
 * THE PERSON'S COLUMN WIDTHS, through the one store every reader of them shares (`column-store`): the same
 * key, version and shape as the pre-paint stamp reads, so the first frame already stands at the stored
 * widths. A drag writes the two properties live, on the root of the document the columns were drawn in, and keeps
 * the width once the drag rests.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  LIST,
  RAIL,
  applyColumnVars,
  readColumns,
  writeColumns,
  type ColumnState,
} from "@ohmail/app-logic/lists/column-store";

export const KEEP_AFTER_MS = 300;

export interface ColumnWidths {
  readonly rail: number;
  readonly list: number;
  readonly limits: { readonly rail: typeof RAIL; readonly list: typeof LIST };
  set(column: "rail" | "list", width: number | undefined): void;
}

export function useColumnWidths(columns: RefObject<HTMLElement | null>): ColumnWidths {
  const [state, setState] = useState<ColumnState>(() => readColumns());
  const keep = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (keep.current) clearTimeout(keep.current);
    },
    [],
  );
  const set = useCallback(
    (column: "rail" | "list", width: number | undefined) => {
      setState((was) => {
        const next = { ...was, [column]: width };
        if (width === undefined) delete next[column];
        const root = columns.current?.ownerDocument.documentElement;
        if (root) applyColumnVars(root, next);
        if (keep.current) clearTimeout(keep.current);
        keep.current = setTimeout(() => writeColumns(next), width === undefined ? 0 : KEEP_AFTER_MS);
        return next;
      });
    },
    [columns],
  );
  return {
    rail: state.rail ?? RAIL.dflt,
    list: state.list ?? LIST.dflt,
    limits: { rail: RAIL, list: LIST },
    set,
  };
}
