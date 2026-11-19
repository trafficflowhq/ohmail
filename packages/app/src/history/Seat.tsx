/**
 * HISTORY'S SEAT: what stands above its two columns, and the value of its registration's `Above`. It hands the frame's
 * side and what only this package can read to the place's live hook (`useHistoryLive`, called here once), and stands
 * the model and the reading column's meeting (`HistoryAbove`). Mounted with the place's columns and unmounted with
 * them; it reads the ground through the live hook's readers and mounts no piece of it.
 */
import type { ReactNode } from "react";
import { useHistoryLive } from "@ohmail/app-logic/history";
import { usePlaceLiveArgs } from "../frame/place-live.js";
import { usePlaceListOwn } from "../place-list/own.js";
import { HistoryAbove } from "./HistoryAbove.js";

export function HistorySeat({ children }: { readonly children: ReactNode }): ReactNode {
  const model = useHistoryLive(usePlaceLiveArgs(), usePlaceListOwn());
  return <HistoryAbove model={model}>{children}</HistoryAbove>;
}
