/**
 * A FOLDER'S SEAT: what stands above its two columns, and the value of its registration's `Above`. It hands the frame's
 * side and what only this package can read to the place's live hook (`useFolderLive`, called here once), and stands
 * the model and the reading column's meeting (`FolderAbove`). Mounted with the place's columns and unmounted with
 * them; it reads the ground through the live hook's readers and mounts no piece of it.
 */
import { useSwitchEnded } from "@ohmail/app-logic/session/ui-vitals";
import type { ReactNode } from "react";
import { useFolderLive } from "@ohmail/app-logic/folder";
import { usePlaceLiveArgs } from "../frame/place-live.js";
import { usePlaceListOwn } from "../place-list/own.js";
import { FolderAbove } from "./FolderAbove.js";
import { useFolderMoveWords } from "./move-words.js";

export function FolderSeat({ children }: { readonly children: ReactNode }): ReactNode {
  const args = usePlaceLiveArgs();
  const model = useFolderLive(args, { ...usePlaceListOwn(), moveWords: useFolderMoveWords() });
  useSwitchEnded(args.route, model.list.rows.length > 0 || model.empty);
  return <FolderAbove model={model}>{children}</FolderAbove>;
}
