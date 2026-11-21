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
  readonly recordId: string;
  readonly people: readonly string[];
  readonly notes: string | null;
}

export interface FaceWords {
  readonly busy: () => string;
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
  // A single override keeps its stored key even when this device reads its zone differently.
  const key = o.occurrence.source === "override" && !o.record.thisAndFuture ? o.record.recurrenceId : o.key;
  const id = key === null ? o.record.id : `${event}@${key}`;
  const time = {
    id,
    recordId: o.record.id,
    start: o.occurrence.start,
    end: o.occurrence.end,
    tone: hueOf(o.calendar.color),
    ref: { event, occurrence: key, day: o.day },
  };
  if (o.calendar.access === "busy") {
    return {
      ...time,
      title: words.busy(),
      state: "plain",
      repeats: null,
      viewOnly: true,
      waits: false,
      status: null,
      second: null,
      people: [],
      notes: null,
    };
  }
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
    ...time,
    title: o.record.title,
    state: stateOf(o),
    repeats: o.occurrence.source === "override" ? "apart" : o.occurrence.source === "rule" ? "series" : null,
    viewOnly: viewOnlyOf(o.calendar, connections.get(o.calendar.connectionId)),
    waits: o.record.myAnswer === "none",
    status,
    second: o.record.place,
    people,
    notes: o.record.notes,
  };
}
