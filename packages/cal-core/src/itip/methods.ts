/**
 * The methods calendars exchange (iTIP, RFC 5546 section 3.2) and what each asks of an event in a
 * message, as data. Nothing here decides what to do with a message; it says what the message is and
 * where it departs from the standard, and the reader of the report decides.
 */
import type { CalObject } from "../ical/calendar.js";

export const ITIP_METHODS = ["PUBLISH", "REQUEST", "REPLY", "ADD", "CANCEL", "REFRESH", "COUNTER", "DECLINECOUNTER"] as const;
export type ItipMethod = (typeof ITIP_METHODS)[number];

/** The calendar's method when it is one of the eight, else `null` (no METHOD line: a stored object, not a message). */
export function methodOf(calendar: CalObject): ItipMethod | null {
  return (ITIP_METHODS as readonly string[]).includes(calendar.method ?? "") ? (calendar.method as ItipMethod) : null;
}

/** How often a property stands in one event of a message: exactly once, at least once, any number, at most once, never. */
export type Presence = "1" | "1+" | "0+" | "0-1" | "0";

/**
 * RFC 5546 sections 3.2.1 to 3.2.8, the rows that carry an event's identity, its order and its
 * people. A property not listed for a method is not checked. Beside the table the standard says:
 * a REPLY's one ATTENDEE "MUST be the address of the Attendee replying" and its SEQUENCE, "if
 * non-zero, MUST be the sequence number of the original REQUEST"; ADD's SEQUENCE "MUST be greater
 * than 0"; COUNTER and DECLINECOUNTER "MUST echo the original SEQUENCE number".
 */
export const EVENT_PRESENCE: Readonly<Record<ItipMethod, Readonly<Record<string, Presence>>>> = {
  PUBLISH: { ATTENDEE: "0", DTSTAMP: "1", DTSTART: "1", ORGANIZER: "1", SEQUENCE: "0-1", SUMMARY: "1", UID: "1", "RECURRENCE-ID": "0-1", "REQUEST-STATUS": "0" },
  REQUEST: { ATTENDEE: "1+", DTSTAMP: "1", DTSTART: "1", ORGANIZER: "1", SEQUENCE: "0-1", SUMMARY: "1", UID: "1", "RECURRENCE-ID": "0-1", "REQUEST-STATUS": "0" },
  REPLY: { ATTENDEE: "1", DTSTAMP: "1", DTSTART: "0-1", ORGANIZER: "1", SEQUENCE: "0-1", SUMMARY: "0-1", UID: "1", "RECURRENCE-ID": "0-1", "REQUEST-STATUS": "0+" },
  ADD: { ATTENDEE: "0+", DTSTAMP: "1", DTSTART: "1", ORGANIZER: "1", SEQUENCE: "1", SUMMARY: "1", UID: "1", "RECURRENCE-ID": "0", "REQUEST-STATUS": "0" },
  CANCEL: { ATTENDEE: "0+", DTSTAMP: "1", DTSTART: "0-1", ORGANIZER: "1", SEQUENCE: "1", SUMMARY: "0-1", UID: "1", "RECURRENCE-ID": "0-1", "REQUEST-STATUS": "0" },
  REFRESH: { ATTENDEE: "1", DTSTAMP: "1", DTSTART: "0", ORGANIZER: "1", SEQUENCE: "0", SUMMARY: "0", UID: "1", "RECURRENCE-ID": "0-1", "REQUEST-STATUS": "0" },
  COUNTER: { ATTENDEE: "0+", DTSTAMP: "1", DTSTART: "1", ORGANIZER: "1", SEQUENCE: "1", SUMMARY: "1", UID: "1", "RECURRENCE-ID": "0-1", "REQUEST-STATUS": "0+" },
  DECLINECOUNTER: { ATTENDEE: "1+", DTSTAMP: "1", DTSTART: "0-1", ORGANIZER: "1", SEQUENCE: "1", UID: "1" },
};

/** Methods whose message holds exactly one event; the others hold one or more. */
const ONE_EVENT: readonly ItipMethod[] = ["ADD", "REFRESH", "COUNTER"];

export interface MessageFault {
  /** The event's UID, or `null` for a fault of the message itself. */
  readonly uid: string | null;
  /** The property, or `VEVENT` for the number of events. */
  readonly property: string;
  readonly fault: "missing" | "forbidden" | "repeated";
}

/**
 * Where a message departs from what its method asks, event by event. `null` when the calendar has
 * no method of the eight. An empty list is a message in order. Real writers depart from the table
 * (a published feed that lists invitees is common), so this is a report and not a refusal.
 */
export function messageFaults(calendar: CalObject): MessageFault[] | null {
  const method = methodOf(calendar);
  if (method === null) return null;
  const faults: MessageFault[] = [];
  if (calendar.events.length === 0) faults.push({ uid: null, property: "VEVENT", fault: "missing" });
  else if (calendar.events.length > 1 && ONE_EVENT.includes(method)) faults.push({ uid: null, property: "VEVENT", fault: "repeated" });
  const table = Object.entries(EVENT_PRESENCE[method]);
  for (const event of calendar.events) {
    // How often each property the table names stands in the event: its lines are gone through once for all of them.
    const counts = new Map<string, number>(table.map(([property]) => [property, 0]));
    for (const p of event.component.properties) {
      const name = p.name.toUpperCase();
      const count = counts.get(name);
      if (count !== undefined) counts.set(name, count + 1);
    }
    for (const [property, presence] of table) {
      const count = counts.get(property)!;
      if (count === 0 && (presence === "1" || presence === "1+")) faults.push({ uid: event.uid, property, fault: "missing" });
      else if (count > 0 && presence === "0") faults.push({ uid: event.uid, property, fault: "forbidden" });
      else if (count > 1 && (presence === "1" || presence === "0-1")) faults.push({ uid: event.uid, property, fault: "repeated" });
    }
  }
  return faults;
}
