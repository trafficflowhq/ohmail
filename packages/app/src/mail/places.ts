/**
 * THE MAIL PLACES, ONE LIST FOR EVERY HOST: the registration of each place that is seated on the ground, by its id.
 * A shell that shows mail takes its places from here and adds none of its own for an id this list names.
 */
import type { PlaceEntry, PlaceId } from "../frame/contract.js";

/**
 * The seated places by id. An id that is absent is not seated yet: a host answers it with what it mounted before, or
 * with `none`.
 *
 * A seat adds ONE line to the list below, `<id>: <the entry its place.ts exports>`, and that line seats the place on
 * every host at once. The entry's columns name the place's own seat as `Above`, and the seat reads the ground.
 *
 * An entry here MAY NEVER: share a body with a view of the old shell; count for the rail (`rail.useCount`) off the
 * place's own model, which stands only while the place is on screen (a count is drawn for the frame's life, in the
 * rail, the dock and the More sheet, so it reads the ground alone); or differ by host (a host picks entries by id,
 * it never changes one).
 */
export type MailPlaces = Readonly<Partial<Record<PlaceId, PlaceEntry>>>;

const SEATED: MailPlaces = {};

/** The seated mail places: the same record at every call. */
export function mailPlaces(): MailPlaces {
  return SEATED;
}
