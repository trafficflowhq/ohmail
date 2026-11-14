/** ADD: an event found in a letter, made on a calendar by the calendar's one press seam, under one key per press. */
import type { CalendarPort } from "../port.js";
import { pressAndHear, type Heard } from "../press.js";
import type { FoundRow } from "./contract.js";

export function addFound(
  port: Pick<CalendarPort, "newId" | "press" | "flush" | "verdict">,
  row: Pick<FoundRow, "fields">,
  calendarId: string,
): Promise<Heard> {
  return pressAndHear(port, {
    kind: "calendar_event_create",
    eventId: port.newId(),
    calendarId,
    event: row.fields,
  });
}
