import type { CalendarPort } from "@ohmail/app-logic/calendar";
import { calendarNoticeFragment, fragmentOf } from "@ohmail/app/frame";
import type { FrameSupplies } from "@ohmail/app/host";

/** Open an event that the calendar still serves to this window. */
export function openCalendarNotice(
  address: FrameSupplies["address"], port: CalendarPort, id: string, zone: string,
): boolean {
  const destination = calendarNoticeFragment(port, id, zone);
  if (destination === null) return false;
  address.write(destination, "push");
  return true;
}

export function openMailNotice(
  address: FrameSupplies["address"], letter: string | undefined, hasLetter: (id: string) => boolean,
): boolean {
  const open = letter && /^[\w-]{1,128}$/.test(letter) && hasLetter(letter) ? letter : null;
  address.write(fragmentOf({ place: "ohbox", sub: null, open, words: {}, stage: null }), "push");
  return true;
}
