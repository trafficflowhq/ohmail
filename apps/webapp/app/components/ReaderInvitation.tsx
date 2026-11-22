import { InvitationLetterCard, type ReaderInvitationProps } from "@ohmail/app/reader";
import type { DistinctCalendarEvent } from "@ohmail/client-engine";
import { useDoors } from "@ohmail/app-logic/reader/doors";
import type { CalendarTime, InvitationAnswerResult, MessageInvitationDTO } from "@ohmail/wire";
import type { IcsEventPreview, IcsTime } from "@trafficflow/core/ics";
import { useFrame } from "@ohmail/app/frame";
import { api } from "../api-client";
import { formatWhen, IcsEventCards } from "./IcsEventCard";
import { InvitationNote } from "./InvitationNote";

const sameAddress = (a: string | null | undefined, b: string | null) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

function matches(event: IcsEventPreview, invitation: MessageInvitationDTO) {
  return (invitation.method === "REQUEST" && (event.method === "REQUEST" || event.method === null) && !event.cancelled ||
    invitation.method === "CANCEL" && (event.cancelled || event.method === null)) &&
    event.uid === invitation.uid && (event.recurrenceId ?? "") === invitation.recurrenceId &&
    (event.sequence === null || event.sequence === invitation.sequence) &&
    sameAddress(event.organizer?.email, invitation.organizer);
}

export function invitationPart(
  message: NonNullable<ReaderInvitationProps["message"]>,
  events: readonly DistinctCalendarEvent[],
) {
  const invitation = message.invitation;
  return invitation ? events.find(({ event }) => matches(event, invitation)) : undefined;
}

const pad = (value: number, digits = 2) => String(value).padStart(digits, "0");

function storedTime(time: IcsTime): CalendarTime {
  const { year, month, day, hour, minute } = time.wall;
  const date = pad(year, 4) + pad(month) + pad(day);
  if (time.allDay) return { kind: "date", value: date };
  const value = date + "T" + pad(hour) + pad(minute) + pad(time.epochMs === null ? 0 : new Date(time.epochMs).getUTCSeconds());
  if (time.tzid) return { kind: "zoned", zone: time.tzid, value };
  return time.utc ? { kind: "instant", value: value + "Z" } : { kind: "floating", value };
}

function dayEnd(time: IcsTime): CalendarTime | null {
  if (!time.allDay || time.epochMs === null) return null;
  const next = new Date(time.epochMs + 86_400_000);
  return { kind: "date", value: next.toISOString().slice(0, 10).replaceAll("-", "") };
}

function retainedStart(invitation: MessageInvitationDTO): CalendarTime | null {
  const start = invitation.start;
  if (start && /^\d{8}$/.test(start)) return { kind: "date", value: start };
  if (invitation.startsAt)
    return { kind: "instant", value: invitation.startsAt.slice(0, 19).replace(/[-:]/g, "") + "Z" };
  return start && /^\d{8}T\d{6}$/.test(start) ? { kind: "floating", value: start } : null;
}

/** The Reader's file strip already holds this letter's list on the same scoped door. */
export function ReaderInvitation({ messageId, message, invitationWithoutEvent, text, full }: ReaderInvitationProps) {
  const { files } = useDoors();
  const { host } = useFrame();
  const events = files?.eventsOf(messageId) ?? [];
  const invitation = message?.invitation;
  const activeInvitation = invitation && (invitation.method === "REQUEST" || invitation.method === "CANCEL");
  const action = message && invitationPart(message, events);
  return (
    <>
      <InvitationNote message={{ invitationWithoutEvent }} text={text} full={full} className="rd-invitation-note" />
      {message && invitation && activeInvitation && <InvitationLetterCard key={messageId}
        message={message} invitation={invitation} title={action?.event.summary || message.subject}
        when={action ? formatWhen(action.event.start, action.event.end) : null} place={action?.event.location ?? null}
        from={action?.event.organizer?.name || (sameAddress(message.from.address, invitation.organizer) && message.from.name) ||
          invitation.organizer}
        start={action ? storedTime(action.event.start) : retainedStart(invitation)}
        end={action ? (action.event.end ? storedTime(action.event.end) : dayEnd(action.event.start)) : null}
        repeat={action?.event.rule ?? null} copyable={!!action && !action.event.extraDates}
        reply={(body, key) => api<InvitationAnswerResult>(`/messages/${encodeURIComponent(messageId)}/invitation/answer`, {
          method: "POST", body, headers: { "Idempotency-Key": key }, expectedOwner: host.session.scope,
        })}
      />}
      <IcsEventCards events={action ? events.filter((row) => row !== action) : events} />
    </>
  );
}
