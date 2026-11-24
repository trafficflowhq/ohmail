/**
 * WHAT NAMES ONE CALENDAR OF A CONNECTION, whichever of its provider's hosts lists it.
 *
 * A calendar's id is the provider's own: for most a name that never changes, for CalDAV the
 * address of the collection. A CalDAV server may serve one person's calendars from more than one
 * host beside the typed one, and move them between those hosts: one large provider lists the same
 * calendar under another numbered host from one day to the next. Within one connection a
 * collection is therefore known by its scheme, port and path, its host aside, so that a listing
 * that names it at a new host finds the calendar it already keeps. That is the same place the
 * reader asks at today's host; another port or another scheme is another calendar.
 */
import { placeKey } from "./caldav/ask.js";
import type { ProviderWord } from "./port.js";

export function calendarKey(provider: ProviderWord, id: string): string {
  return provider === "caldav" ? placeKey(id) : id;
}
