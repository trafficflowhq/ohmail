/**
 * TODAY'S VIEWS AS PLACES: every place is one shared body, "today", drawn in the wide pane by the one adapter. A
 * screen task registers its own place and takes its id out of here; when the last goes, so does this file.
 */
import { PLACE_IDS, type FramePlaces, type PlaceEntry } from "@ohmail/app/frame";
import { TodaysViews } from "./AppShell";

export function todaysPlaces(): FramePlaces {
  return Object.fromEntries(
    PLACE_IDS.map((id): [string, PlaceEntry] => [id, { id, body: "today", rail: null, panes: { kind: "wide", Wide: TodaysViews } }]),
  ) as unknown as FramePlaces;
}
