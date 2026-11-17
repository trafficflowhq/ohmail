/**
 * THE PRODUCT A ROUTE STANDS IN: mail or the calendar. Pure, and shared by the frame, the address doors and the
 * calendar's root, so each tells the two apart the same way.
 */
import {
  CALENDAR_PLACE_IDS,
  type AnyPlaceId,
  type CalendarPlaceId,
  type EventRef,
  type PlaceId,
  type Product,
} from "./contract.js";

const CALENDAR_PLACES: ReadonlySet<string> = new Set(CALENDAR_PLACE_IDS);

export function isCalendarPlace(place: AnyPlaceId): place is CalendarPlaceId {
  return CALENDAR_PLACES.has(place);
}

export function productOf(place: AnyPlaceId): Product {
  return isCalendarPlace(place) ? "cal" : "mail";
}

/** Where each side starts when nothing is remembered. */
export const MAIL_HOME: PlaceId = "ohbox";
export const CALENDAR_HOME: CalendarPlaceId = "week";

/** The keys that cross to the other side, declared once: the switch shows them, each side's key table binds them. */
export const SWITCH_CHORDS: Readonly<Record<Product, string>> = { mail: "g m", cal: "g c" };

/** The route's `open` for an event: its id, or `id@occurrenceKey` for one day of a series. */
export function eventRefString(ref: Pick<EventRef, "event" | "occurrence">): string {
  return ref.occurrence === null ? ref.event : `${ref.event}@${ref.occurrence}`;
}

/**
 * The event a route's `open` names, on the day the route stands at. An event's id never carries `@`, while an
 * occurrence key may (a zone's name is a stranger's text), so the first one divides; an empty part is no event.
 */
export function eventRefOf(open: string | null, day: string): EventRef | null {
  if (open === null || open === "") return null;
  const at = open.indexOf("@");
  if (at === -1) return { event: open, occurrence: null, day };
  const event = open.slice(0, at);
  const occurrence = open.slice(at + 1);
  return event === "" || occurrence === "" ? null : { event, occurrence, day };
}
