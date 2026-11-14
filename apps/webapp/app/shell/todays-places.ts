/**
 * TODAY'S VIEWS AS PLACES: every place is one shared body, "today", drawn in the wide pane by the one adapter. The
 * body is kept: the frame mounts it once and hides it while a place of another body is on screen, so the view switch
 * and the piles it keeps stay as they are. What the views run on (the old shell's composition) stands above every
 * pane, not in this body (`TodaysAbove`, handed by `todays-supplies.ts`). A screen task registers its own place and
 * takes its id out of here; when the last goes, so does this file.
 */
import { PLACE_IDS, type FramePlaces, type PlaceEntry } from "@ohmail/app/frame";
import { TodaysViews } from "./AppShell";

export function todaysPlaces(): FramePlaces {
  return Object.fromEntries(
    PLACE_IDS.map((id): [string, PlaceEntry] => [id, { id, body: "today", rail: null, panes: { kind: "wide", Wide: TodaysViews, kept: true } }]),
  ) as unknown as FramePlaces;
}
