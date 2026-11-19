/**
 * TAGS' SEAT: what stands above its two columns, and the value of its registration's `Above`. It hands the frame's
 * side and what only this package can read to the place's live hook (`useTagsLive`, called here once), and stands
 * the model and the reading column's meeting (`TagsAbove`). Mounted with the place's columns and unmounted with
 * them; it reads the ground through the live hook's readers and mounts no piece of it.
 */
import type { ReactNode } from "react";
import { useTagsLive } from "@ohmail/app-logic/tags";
import { usePlaceLiveArgs } from "../frame/place-live.js";
import { usePlaceListOwn } from "../place-list/own.js";
import { TagsAbove } from "./TagsAbove.js";

export function TagsSeat({ children }: { readonly children: ReactNode }): ReactNode {
  const model = useTagsLive(usePlaceLiveArgs(), usePlaceListOwn());
  return <TagsAbove model={model}>{children}</TagsAbove>;
}
