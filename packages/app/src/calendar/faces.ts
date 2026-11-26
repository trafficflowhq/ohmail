/**
 * AN OCCURRENCE'S FACE: what a view draws of it, made from its record, its calendar, its connection and what waits
 * for it. Pure; the words come in from the `event` namespace, so the face says them in the reader's language.
 */
import { viewOnlyOf, type CalendarConnectionRecord, type ShownOccurrence } from "@ohmail/app-logic/calendar";
import { canEditRecord, canProposeRecord } from "./editable-event.js";
import type { CalendarEventView } from "./view.js";

/** An event as every view takes it: the time grid's face, and the words Search finds it by. */
export interface CalendarEventFace extends CalendarEventView {
  readonly recordId: string;
  readonly people: readonly string[];
  readonly notes: string | null;
  readonly conflict?: boolean;
  readonly replyUnconfirmed?: boolean;
  readonly retryWriteId?: string;
  readonly failedCreate?: NonNullable<ShownOccurrence["writes"]["refusal"]>;
  readonly invitation?: import("../reader/InvitationLetterCard.js").InvitationLetterProps;
  /** The account's own answer to this day, where it gave one; `apart`: a day of a series answered otherwise than the series. */
  readonly said?: { readonly answer: "accepted" | "tentative" | "declined"; readonly apart: boolean };
}

export interface FaceWords {
  readonly busy: () => string;
  readonly waitingDevice: string;
  readonly waitingProvider: string;
  readonly notSaved: string;
  readonly replyUnconfirmed: string;
}

function stateOf(
  o: ShownOccurrence,
  answer: ShownOccurrence["record"]["myAnswer"],
): CalendarEventView["state"] {
  if (o.record.status === "cancelled") return "off";
  if (o.record.myAnswer === "none") return "to-answer";
  if (o.record.status === "tentative" || o.record.myAnswer === "tentative" || answer === "tentative")
    return "maybe";
  return "plain";
}

function saidOf(
  o: ShownOccurrence,
  answer: ShownOccurrence["record"]["myAnswer"],
): Pick<CalendarEventFace, "said"> {
  if (answer !== "accepted" && answer !== "tentative" && answer !== "declined") return {};
  return {
    said: {
      answer,
      apart: o.series !== null && o.key !== null && (o.series.mailAnswer ?? o.series.myAnswer) !== answer,
    },
  };
}

export function faceOf(
  o: ShownOccurrence,
  connections: ReadonlyMap<string, CalendarConnectionRecord>,
  words: FaceWords,
  tone: CalendarEventView["tone"],
  own: readonly string[] | null,
  proposals: boolean,
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
    tone,
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
  const connection = connections.get(o.calendar.connectionId);
  const viewOnly = viewOnlyOf(o.calendar, connection);
  const { waiting, refusal, refusedWriteId } = o.writes;
  const conflict = refusal === "version_stale";
  const replyUnconfirmed = refusal === "answer_unconfirmed";
  const checkingReply = o.writes.replyUnconfirmed === true;
  const answer =
    checkingReply || replyUnconfirmed ? o.record.myAnswer : (o.record.mailAnswer ?? o.record.myAnswer);
  const failedCreate =
    connection?.provider === "caldav" && (!o.record.uid || o.record.uid.startsWith("pending:"))
      ? refusal
      : null;
  const status =
    replyUnconfirmed || checkingReply
      ? { text: words.replyUnconfirmed, failed: false }
      : refusal !== null
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
    state: stateOf(o, answer),
    repeats: o.occurrence.source === "override" ? "apart" : o.occurrence.source === "rule" ? "series" : null,
    viewOnly,
    timeEditable:
      !viewOnly &&
      !failedCreate &&
      o.record.end !== null &&
      (canEditRecord(o.record, connection, own, o.calendar.access, o.series) ||
        (proposals && canProposeRecord(o.record, own))),
    waits: o.record.myAnswer === "none",
    ...saidOf(o, answer),
    status,
    ...(replyUnconfirmed && { replyUnconfirmed }),
    ...(failedCreate && { failedCreate }),
    ...(!failedCreate &&
      (conflict
        ? { conflict }
        : !viewOnly && refusedWriteId && refusal !== "earlier_refused"
          ? { retryWriteId: refusedWriteId }
          : {})),
    second: o.record.place,
    people,
    notes: o.record.notes,
  };
}
