/**
 * THE PLACES A SHELL HANDS THE FRAME. A seated place is its own entry: the Ohbox, with what today's composition feeds
 * it standing above its two columns (`TodaysOhboxAbove`). Every other place is still one of today's views: one shared
 * body, "today", drawn in the wide pane by the one adapter. That body is kept: the frame mounts it once and hides it
 * while a seated place is on screen, so the view switch and the piles it keeps stay as they are. What the views and the
 * seated places run on (the old shell's composition) stands above every pane, not in a body (`TodaysAbove`, handed by
 * `todays-supplies.ts`). A place seated after the Ohbox reads the mail ground and is named once in the mail entry's
 * own list (`mailPlaces()`), which takes its id out of today's on every host; when the last goes, so does this file.
 */
import { PLACE_IDS, type FramePlaces, type PlaceEntry } from "@ohmail/app/frame";
import { mailPlaces } from "@ohmail/app/mail";
import { ohboxPlace } from "@ohmail/app/ohbox";
import { TodaysViews } from "./AppShell";
import { TodaysOhboxAbove } from "./TodaysOhboxAbove";

/** The body every view of today's shares. */
const TODAY = "today";

/**
 * THE SEATED OHBOX: the Ohbox's own place, fed from today's composition. It registers no rail entry yet: the rail is
 * today's fed model, with today's number, until the rail is drawn from the places' registrations; and the
 * registration's own count reads the Ohbox's model, which stands only with its columns, while the frame draws the
 * registered entries in the commit before a rail is fed.
 */
const OHBOX: PlaceEntry = { ...ohboxPlace, rail: null, panes: seatedPanes(ohboxPlace) };

/** A columns place's panes with what the composition feeds it standing above both. */
function seatedPanes(place: PlaceEntry): PlaceEntry["panes"] {
  if (place.panes.kind !== "columns") throw new Error(`the place "${place.id}" does not draw columns`);
  return { ...place.panes, Above: TodaysOhboxAbove };
}

/**
 * The seated places by id: the mail product's own list (`mailPlaces()`: a place that reads the mail ground and
 * nothing of this shell is named there once, for every host), and over it the one place this shell still feeds
 * itself, the Ohbox, until its own seat reads the ground.
 */
const SEATED: Partial<Record<(typeof PLACE_IDS)[number], PlaceEntry>> = { ...mailPlaces(), ohbox: OHBOX };

export function todaysPlaces(): FramePlaces {
  return Object.fromEntries(
    PLACE_IDS.map((id): [string, PlaceEntry] => [
      id,
      SEATED[id] ?? { id, body: TODAY, rail: null, panes: { kind: "wide", Wide: TodaysViews, kept: true } },
    ]),
  ) as unknown as FramePlaces;
}

/** Is this place still one of today's views? A seated place, and a place a host hands none of, are not. */
export function isTodays(entry: FramePlaces[keyof FramePlaces]): boolean {
  return entry !== "none" && entry.body === TODAY;
}
