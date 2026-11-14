/** A move into a folder, in the folder place's own words: the seat hands these to the move's press. */
import { useMemo } from "react";
import type { FolderMoveWords } from "@ohmail/app-logic/folder";
import { useText, type Text } from "../text/index.js";

export function folderMoveWordsOf(t: Text): FolderMoveWords {
  return {
    moved: (name) => t("move.moved", { name }),
    outdated: (by) => t("move.outdated", { by }),
    outdatedUnknown: () => t("move.outdatedUnknown"),
    nobody: () => t("move.nobody"),
    elsewhere: (by) => t("move.elsewhere", { by }),
    elsewhereUnknown: () => t("move.elsewhereUnknown"),
    gone: (name) => t("gone", { name }),
    busy: (name) => t("move.busy", { name }),
    cannot: (name) => t("move.cannot", { name }),
    refused: () => t("move.refused"),
    queued: (by) => (by ? t("move.queued", { by }) : t("move.queuedUnknown")),
    waitingGone: (name) => t("move.waitingGone", { name }),
    waitingLetterGone: () => t("move.waitingLetterGone"),
    waitingUnreadable: () => t("move.waitingUnreadable"),
  };
}

/** {@link folderMoveWordsOf} for the folder's own namespace. */
export function useFolderMoveWords(): FolderMoveWords {
  const t = useText("folder");
  return useMemo(() => folderMoveWordsOf(t), [t]);
}
