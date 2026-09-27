"use client";

/**
 * A COLUMN VIEW'S OPEN, IN THE ADDRESS — History, Answer Later, Trash, a folder and a tag read in a
 * column of their own, so the open is the view's state and the shell cannot see it. The view
 * reports the row somebody picked while the column shows it (`reportPick`), which the bar claims;
 * the URL's open message comes back as `locateId`, which selects its row, and a claim dropped in
 * place (Back) drops the pick. The first-row fallback is a display, never a claim.
 */
import { useEffect, useRef } from "react";

export function useColumnPick(o: {
  /** The row somebody picked, or `null` while the column shows its fallback. */
  picked: string | null;
  /** The row the column shows. */
  shown: string | null;
  /** The URL's open message on this view. */
  locateId: string | null | undefined;
  /** Does the list hold `locateId`? The select waits for the row to arrive. */
  located: boolean;
  select: (id: string | null) => void;
  onPick?: (id: string | null) => void;
}): void {
  const { picked, shown, locateId = null, located, select, onPick } = o;
  const lastLocate = useRef<string | null>(locateId);
  useEffect(() => {
    const was = lastLocate.current;
    lastLocate.current = locateId;
    if (locateId !== null && located) {
      if (picked !== locateId) select(locateId);
      return;
    }
    if (locateId === null && was !== null && picked === was) select(null);
    // Only the claim and its arrival: a pick made since is the person's, not the URL's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locateId, located]);
  const claim = picked !== null && shown === picked ? picked : null;
  useEffect(() => {
    onPick?.(claim);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claim]);
}
