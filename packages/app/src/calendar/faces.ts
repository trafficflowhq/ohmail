/**
 * AN OCCURRENCE'S FACE: what a view draws of it, made from its record, its calendar, its connection and what waits
 * for it. Pure; the words come in from the `event` namespace, so the face says them in the reader's language.
 */
import {
  hueOf,
  viewOnlyOf,
  type CalendarConnectionRecord,
  type ShownOccurrence,
} from "@ohmail/app-logic/calendar";
import type { CalendarEventView } from "./view.js";

/** An event as every view takes it: the time grid's face, and the words Search finds it by. */
export interface CalendarEventFace extends CalendarEventView {
  readonly people: readonly string[];
  readonly notes: string | null;
}

export interface FaceWords {
  readonly waitingDevice: string;
  readonly waitingProvider: string;
  readonly notSaved: string;
}

function stateOf(o: ShownOccurrence): CalendarEventView["state"] {
  if (o.record.status === "cancelled") return "off";
  if (o.record.myAnswer === "none") return "to-answer";
  if (o.record.status === "tentative" || o.record.myAnswer === "tentative") return "maybe";
  return "plain";
}

export function faceOf(
  o: ShownOccurrence,
  connections: ReadonlyMap<string, CalendarConnectionRecord>,
  words: FaceWords,
): CalendarEventFace {
  const event = (o.series ?? o.record).id;
  /* A changed day is named by the key our server stored, never by one worked out again here. */
  const key = o.occurrence.source === "override" ? o.record.recurrenceId : o.key;
  const id = key === null ? o.record.id : `${event}@${key}`;
  const { waiting, refusal } = o.writes;
  const status =
    refusal !== null
      ? { text: words.notSaved, failed: true }
      : waiting === "device"
        ? { text: words.waitingDevice, failed: false }
        : waiting === "provider"
          ? { text: words.waitingProvider, failed: false }
          : null;
  const people = [
    ...(o.record.organizer ? [o.record.organizer.name ?? o.record.organizer.address] : []),
    ...o.record.invitees.map((i) => i.name ?? i.address),
  ];
  return {
    id,
    start: o.occurrence.start,
    end: o.occurrence.end,
    title: o.record.title,
    tone: hueOf(o.calendar.color),
    state: stateOf(o),
    repeats: o.occurrence.source === "override" ? "apart" : o.occurrence.source === "rule" ? "series" : null,
    viewOnly: viewOnlyOf(o.calendar, connections.get(o.calendar.connectionId)),
    waits: o.record.myAnswer === "none",
    status,
    second: o.record.place,
    ref: { event, occurrence: key, day: o.day },
    people,
    notes: o.record.notes,
  };
}
