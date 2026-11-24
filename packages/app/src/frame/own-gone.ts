/**
 * WHAT THIS TAB TOOK AWAY ITSELF, beside the room's press seam, as a part reads it (the reading column, a place):
 * whether a letter is one the seam sent away this session (a delete once its window closed, a move to a folder),
 * read at each call. A tombstone of such a letter is this tab's own work, never another app's: the reading column
 * says "moved or deleted elsewhere" only of the others. False everywhere no room is on.
 */
import { useCallback } from "react";
import { usePressWhereOn } from "./room.js";

export function useOwnGone(): (id: string) => boolean {
  const press = usePressWhereOn();
  return useCallback((id: string) => press?.ownGone?.has(id) ?? false, [press]);
}
