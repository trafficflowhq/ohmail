import { connectFaultKeyOf, type CalendarWay } from "@ohmail/app-logic/calendar/setup";

/** Refused credentials need guidance for the connection the person chose. A server that sends the sign-in to a host it may not is refused, and nothing tries again. */
export function setupFaultKeyOf(fault: string, way: CalendarWay): string {
  if (fault === "host_changed") return "fault.addressRefused";
  if (fault === "sign_in_refused") {
    if (way === "caldav") return "fault.signInRefusedCaldav";
    if (way === "ics") return "fault.signInRefusedIcs";
    if (way !== "icloud") return "fault.signInAgain";
  }
  return connectFaultKeyOf(fault);
}
