import { useState } from "react";
import {
  calendarRefusalSentence,
  pressAndHear,
  sentenceOf,
  type CalendarEventRecord,
  type CalendarPort,
} from "@ohmail/app-logic/calendar";
import type { CalendarAct, CalendarEventAct, InvitationAnswer } from "@ohmail/wire";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";
import type { InvitationLetterProps } from "./InvitationLetterCard.js";
import { sameTime, type LetterView } from "./invitation-letter-view.js";

export function useInvitationFiling(
  props: InvitationLetterProps,
  answer: InvitationAnswer | null,
  port: CalendarPort | typeof NONE,
  { target, copy }: LetterView,
  live: { current: boolean },
) {
  const text = useText("event");
  const [press, setPress] = useState<{ key: string; act: CalendarAct } | null>(null);
  const [saveError, setSaveError] = useState(false);
  const write = copy?.writes
    .filter(({ act, state }) => {
      if (act?.kind !== "calendar_event_create" && act?.kind !== "calendar_event_update") return false;
      if (act.invitationMessageId !== props.message.id) return false;
      const busy = act.kind === "calendar_event_create" ? act.event.busy : act.change.busy;
      // A different reply can make a refused availability change obsolete.
      return state === "pending" || answer === null || busy === (answer !== "declined");
    })
    .at(-1);
  const refused = write?.state === "refused" ? write : null;
  const verdict = port !== NONE && press ? port.verdict(press.key) : null;
  const reason = refused?.reason ?? (verdict?.kind === "refused" ? verdict.word : null);
  const retryable = reason !== "version_stale" && reason !== "earlier_refused";
  const retry = retryable ? refused : null;
  const waiting =
    write?.state === "pending" ||
    (write === undefined &&
      !!press &&
      (verdict === null || (verdict.kind === "taken" && verdict.write?.state === "pending" && !copy)));
  const refusal = refused
    ? calendarRefusalSentence(refused.reason ?? "unknown")
    : press && verdict?.kind === "refused"
      ? sentenceOf(press.act, verdict)
      : saveError
        ? "refusal.unknown"
        : null;

  const save = async (answer: InvitationAnswer, tryAgain = false) => {
    if (port === NONE || !target || waiting) return;
    const act =
      tryAgain && retry
        ? ({ kind: "calendar_write_retry", writeId: retry.id } as const)
        : filingAct(props, answer, target.id, copy);
    if (live.current) {
      setPress(null);
      setSaveError(false);
    }
    if (!act) return;
    try {
      const heard = await pressAndHear(port, act, false);
      if (live.current) setPress({ key: heard.key, act });
    } catch {
      if (live.current) setSaveError(true);
    }
  };
  const canFile =
    port !== NONE && !!target && !!props.invitation.calendarEventId && !!personalFields(props, "accepted");
  const maySave = retry ? port !== NONE && !!target : canFile && (!copy || refusal !== null);
  return {
    canFile,
    maySave: retryable && maySave,
    failed: refusal && text(refusal),
    waiting,
    save,
  };
}

function personalFields(props: InvitationLetterProps, answer: InvitationAnswer) {
  if (!props.start || !props.end || !props.copyable) return null;
  return {
    title: props.title,
    start: props.start,
    end: props.end,
    place: props.place,
    notes: null,
    callLink: null,
    private: false,
    busy: answer !== "declined",
    repeat: props.repeat,
    invitees: [],
    alarms: [],
  };
}

function filingAct(
  props: InvitationLetterProps,
  answer: InvitationAnswer,
  calendarId: string,
  record?: CalendarEventRecord,
): CalendarEventAct | null {
  const fields = personalFields(props, answer);
  const id = props.invitation.calendarEventId;
  if (!fields || !id) return null;
  if (!record)
    return {
      kind: "calendar_event_create",
      eventId: id,
      calendarId,
      event: fields,
      invitationMessageId: props.message.id,
    };
  if (
    sameTime(record.start, fields.start) &&
    record.end &&
    sameTime(record.end, fields.end) &&
    record.title === fields.title &&
    record.place === fields.place &&
    record.busy === fields.busy
  )
    return null;
  return {
    kind: "calendar_event_update",
    eventId: record.id,
    base: record.updatedAt,
    scope: { kind: "record" },
    invitationMessageId: props.message.id,
    change: {
      start: fields.start,
      end: fields.end,
      place: fields.place,
      title: fields.title,
      busy: fields.busy,
    },
  };
}
