import { connectFaultKeyOf, type CalendarWay } from "@ohmail/app-logic/calendar/setup";

/** Refused credentials need guidance for the connection the person chose. */
export function setupFaultKeyOf(fault: string, way: CalendarWay): string {
  if (fault === "sign_in_refused") {
    if (way === "caldav") return "fault.signInRefusedCaldav";
    if (way === "ics") return "fault.signInRefusedIcs";
    if (way !== "icloud") return "fault.signInAgain";
  }
  return connectFaultKeyOf(fault);
}
