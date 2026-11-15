/**
 * WHAT ANOTHER PARTY'S TEXT MAY WEIGH WHERE THE CALENDAR STORES IT, IN BYTES. An event's UID, the
 * occurrence it names, an invitee's address and a provider's id are written by an organizer, a
 * calendar server or a provider; each is a key of an index, so a row past these would refuse the
 * index's own ceiling and wedge every page that carries it. Every door that stores one asks here.
 */
export const CALENDAR_UID_MAX_BYTES = 1_024;
export const CALENDAR_OCCURRENCE_KEY_MAX_BYTES = 256;
export const CALENDAR_ADDRESS_MAX_BYTES = 320;
export const CALENDAR_PROVIDER_ID_MAX_BYTES = 2_048;

/** Does `value` fit `max` bytes of UTF-8? */
export function fitsCalendarBytes(value: string, max: number): boolean {
  return Buffer.byteLength(value, "utf8") <= max;
}
