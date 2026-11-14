import { useEffect, useRef } from "react";
import { folderLeafOf } from "./folders.js";

/**
 * A FOLDER THAT LEAVES WHILE IT IS OPEN SAYS SO. The folder list follows the mail server, so a
 * folder deleted there drops out of the mirror at the next sync, and the route falls back to the
 * Ohbox; without a sentence that reads as a navigation nobody made. Only the folder that WAS on
 * screen, under this route, with folders on — a link to an unknown id stays silent.
 */
export function useFolderGoneSays(
  openFolder: { id: string; name: string } | null | undefined,
  routedFolderId: string | null,
  foldersEnabled: boolean,
  say: (name: string) => void,
): void {
  const seenRef = useRef<{ id: string; name: string } | null>(null);
  useEffect(() => {
    if (openFolder) { seenRef.current = { id: openFolder.id, name: folderLeafOf(openFolder.name) }; return; }
    const seen = seenRef.current;
    seenRef.current = null;
    if (seen !== null && seen.id === routedFolderId && foldersEnabled) say(seen.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFolder?.id, routedFolderId]);
}
