import { useState } from "react";
import {
  boundariesOf,
  daySpanOf,
  eventTimeOf,
  readerZones,
  storedTimeOf,
  type CalendarEventRecord,
  type CalendarPort,
} from "@ohmail/app-logic/calendar";
import { newEventsCalendarOf } from "@ohmail/app-logic/calendar/setup";
import { senderCheckFact } from "@ohmail/app-logic/screener";
import type { CalendarTime } from "@ohmail/wire";
import type { NONE } from "../host/index.js";
import { useLocale, useText, useTimeZone } from "../text/index.js";
import { useFaces, useSettings, useSources } from "../calendar/where.js";
import { draftCalendars } from "../calendar/event-draft.js";
import { calendarInterval, eventWhen } from "../calendar/event-words.js";
import type { CalendarEventFace } from "../calendar/faces.js";
import type { InvitationLetterProps } from "./InvitationLetterCard.js";

const zones = readerZones();
const folded = (address: string | undefined | null) => address?.trim().toLowerCase() ?? "";
export const sameTime = (a: CalendarTime, b: CalendarTime) =>
  a.kind === b.kind && a.value === b.value && a.zone === b.zone;

function mirrorInvitation(props: InvitationLetterProps, sources: ReturnType<typeof useSources>) {
  const i = props.invitation;
  return sources.events
    .map(({ record }) => record)
    .filter((record) => {
      const calendar = sources.calendars.find(({ id }) => id === record.calendarId);
      if (
        !calendar?.shown ||
        calendar.access === "busy" ||
        record.heldBack ||
        record.removedOccurrences?.includes("")
      )
        return false;
      if (record.id === i.calendarEventId) return true;
      const mailbox = sources.connections.get(calendar.connectionId)?.grantMailboxId;
      if (
        mailbox
          ? mailbox !== props.message.mailboxId
          : !record.invitees.some(({ address }) => folded(address) === folded(i.invitedAddress))
      )
        return false;
      return (
        i.organizer &&
        record.uid === i.uid &&
        record.recurrenceId === i.recurrenceId &&
        folded(i.organizer) === folded(record.organizer?.address) &&
        record.myAnswer !== null
      );
    })
    .sort(
      (a, b) =>
        Number(a.id === i.calendarEventId) - Number(b.id === i.calendarEventId) || b.sequence - a.sequence,
    )[0];
}

function earlierStart(
  props: InvitationLetterProps,
  record: CalendarEventRecord | undefined,
): CalendarTime | undefined {
  const current = props.invitation;
  if (record && record.sequence < current.sequence && (!props.start || !sameTime(record.start, props.start)))
    return record.start;
  const old = current.previous;
  if (old?.start && /^\d{8}$/.test(old.start)) return { kind: "date", value: old.start };
  if (old?.startsAt) return { kind: "instant", value: old.startsAt.slice(0, 19).replace(/[-:]/g, "") + "Z" };
  if (old?.start && /^\d{8}T\d{6}$/.test(old.start)) return { kind: "floating", value: old.start };
}

export function useLetterView(props: InvitationLetterProps & { port: CalendarPort | typeof NONE }) {
  const { invitation, port } = props;
  const text = useText("readerInvitation");
  const calendarText = useText("calendar");
  const locale = useLocale();
  const zone = useTimeZone();
  const sources = useSources(port);
  const settings = useSettings(port);
  const calendars = draftCalendars(sources.calendars, sources.connections);
  const [choice, choose] = useState<string | null>(props.chosenCalendarId ?? null);
  const record = mirrorInvitation(props, sources);
  const start = props.start ?? record?.start;
  const end = props.end ?? record?.end;
  const personal = !!record && record.id === invitation.calendarEventId;
  const current =
    !!record &&
    (personal
      ? !!start && sameTime(record.start, start) && !!record.end && !!end && sameTime(record.end, end)
      : record.sequence === invitation.sequence);
  const calendar = sources.calendars.find(({ id }) => id === record?.calendarId);
  const target =
    calendars.find(({ id }) => id === choice) ??
    newEventsCalendarOf(settings.newEventsCalendarId ?? null, calendars);
  const startTime = start && eventTimeOf(start);
  const endTime = end && eventTimeOf(end);
  const span = startTime && daySpanOf({ start: startTime, end: endTime || startTime }, zone, zones);
  const day = span?.first ?? null;
  const faces =
    useFaces(port, sources, day ? { first: day, last: span?.last ?? day } : null, day, zone, zones)?.events ??
    [];
  const placed =
    current &&
    faces.find(
      (face) =>
        face.recordId === record.id &&
        (record.recurrenceId === "" || face.ref.occurrence === record.recurrenceId),
    );
  const cancelled = invitation.method === "CANCEL" || record?.status === "cancelled";
  const face = day && startTime ? pendingFace(props, day, startTime, endTime || startTime) : null;
  const conflicts =
    face && !cancelled ? overlapping(face, faces, record?.id, zone, locale, text("overlaps")) : [];
  const prior = earlierStart(props, record);
  const previousText = prior && eventWhen({ start: prior }, zone, zones, locale);
  const previous =
    previousText && previousText !== eventWhen({ start }, zone, zones, locale) ? previousText : null;
  const answer =
    (!personal && current && record.myAnswer !== "none" ? record.myAnswer : null) ?? invitation.answer;
  const mailAnswer =
    senderCheckFact(props.message)?.reason !== "failed" &&
    !!invitation.organizer &&
    !!invitation.invitedAddress;

  return {
    when:
      face && endTime && day
        ? calendarInterval(face, zone, zones, day, locale, calendarText)
        : (props.when ?? eventWhen({ start, end }, zone, zones, locale)),
    calendars,
    choose,
    sources,
    current,
    personal,
    record,
    calendar,
    target,
    placed,
    face,
    cancelled,
    conflicts,
    previous,
    answer,
    mailAnswer,
    text,
    locale,
  };
}

export type LetterView = ReturnType<typeof useLetterView>;

function pendingFace(
  props: InvitationLetterProps,
  day: string,
  start: CalendarEventFace["start"],
  end: CalendarEventFace["end"],
): CalendarEventFace {
  const id = `invitation-${props.message.id}`;
  const cancelled = props.invitation.method === "CANCEL";
  return {
    id,
    recordId: id,
    ref: { event: id, occurrence: null, day },
    title: props.title,
    start,
    end,
    state: cancelled ? "off" : "to-answer",
    waits: !cancelled,
    second: props.place,
    tone: null,
    repeats: null,
    viewOnly: false,
    status: null,
    people: props.from ? [props.from] : [],
    notes: null,
  };
}

function overlapping(
  face: CalendarEventFace,
  faces: readonly CalendarEventFace[],
  exclude: string | undefined,
  zone: string,
  locale: string,
  tag: string,
) {
  const at = boundariesOf(face, zone, zones);
  if (!at) return [];
  return faces
    .flatMap((other) => {
      if (other.recordId === exclude || other.state === "off") return [];
      const span = boundariesOf(other, zone, zones);
      if (!span || !(at.first < span.last && span.first < at.last)) return [];
      const when = eventWhen(
        { start: storedTimeOf(other.start), end: storedTimeOf(other.end) },
        zone,
        zones,
        locale,
        true,
      );
      return [{ tone: other.tone, tag, text: [when, other.title].filter(Boolean).join(" ") }];
    })
    .slice(0, 2);
}
