import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  viewOnlyOf,
  pressAndHear,
  type CalendarConnectionRecord,
  type CalendarPort,
  type CalendarRecord,
} from "@ohmail/app-logic/calendar";
import { invitedByOthers, pressAnswer, type InvitationAnswer } from "@ohmail/app-logic/calendar/invitations";
import { NONE } from "../host/index.js";
import { useFrame, useReport } from "../frame/commands.js";
import { useCalendarOwnAddresses } from "../calendar/own-addresses.js";
import { useText } from "../text/index.js";
import type { CalendarEventFace } from "../calendar/faces.js";
import { CalendarRecordScope } from "../calendar/EventActionQuestion.js";
import type { AnswerSwitchProps } from "@ohmail/ui/calendar";
import { AnswerChoices } from "./AnswerChoices.js";

const NO_OWN_ADDRESSES: ReadonlySet<string> = new Set();

export function useInvitationAnswer(port: CalendarPort | typeof NONE) {
  const { host } = useFrame();
  const addresses = useCalendarOwnAddresses();
  const calendarOnly = host.capabilities.products === "calendar";
  const own = useMemo(() => addresses && new Set(addresses.map((a) => a.trim().toLowerCase())), [addresses]);
  const report = useReport();
  const e = useText("event");
  const t = useText("invitations");
  const pending = useRef(new Map<string, symbol>());
  useLayoutEffect(
    () => () => {
      pending.current.clear();
    },
    [port, host.engine],
  );

  const invitation = (recordId: string) => {
    if (port === NONE || (own === null && !calendarOnly)) return null;
    const record = port.events().find((item) => item.record.id === recordId)?.record;
    if (
      !record ||
      record.heldBack ||
      record.status === "cancelled" ||
      !invitedByOthers(record, own ?? NO_OWN_ADDRESSES)
    )
      return null;
    const calendar = host.engine.store.get<CalendarRecord>("calendar", record.calendarId);
    if (!calendar?.shown) return null;
    const connection = host.engine.store.get<CalendarConnectionRecord>(
      "calendar_connection",
      calendar.connectionId,
    );
    return viewOnlyOf(calendar, connection) ? null : record;
  };
  const answer = async (
    recordId: string,
    value: InvitationAnswer,
    reviewed?: {
      base: string;
      seriesBase?: string;
      occurrence: string | null;
      copy?: { calendarId: string; attendee: string };
    },
  ) => {
    if (port === NONE) return;
    const current = invitation(recordId);
    if (pending.current.has(recordId) || !current?.myAnswer || current.myAnswer === value) return;
    if (reviewed && reviewed.base !== current.updatedAt) {
      report(e("refusal.changed"));
      return;
    }
    const request = Symbol();
    pending.current.set(recordId, request);
    try {
      const outcome = reviewed
        ? {
            pressed: true as const,
            ...(await pressAndHear(port, {
              kind: "calendar_event_answer",
              eventId: recordId,
              base: reviewed.seriesBase ? `${reviewed.base}/${reviewed.seriesBase}` : reviewed.base,
              answer: value,
              ...(reviewed.copy && { copy: reviewed.copy }),
              scope:
                reviewed.occurrence === null
                  ? { kind: "record" }
                  : { kind: "occurrence", at: reviewed.occurrence },
            })),
          }
        : await pressAnswer(port, { recordId }, value);
      if (pending.current.get(recordId) !== request || !outcome.pressed) return;
      if (outcome.verdict?.kind === "taken") report(t(`answer.${value}`));
      else if (outcome.say !== null) report(e(outcome.say));
    } catch {
      if (pending.current.get(recordId) === request) report(e("refusal.unknown"));
    } finally {
      if (pending.current.get(recordId) === request) pending.current.delete(recordId);
    }
  };
  return { invitation, answer };
}

export type InvitationActions = ReturnType<typeof useInvitationAnswer>;

export function EventAnswers({
  reply,
  event,
  propose,
}: {
  reply: InvitationActions;
  event: CalendarEventFace;
  propose?: AnswerSwitchProps["propose"];
}) {
  const response = useEventResponse(reply, event);
  return response.answer ? (
    <>
      <AnswerChoices on="sheet" answer={response.answer} propose={propose} onAnswer={response.choose} />
      {response.question}
    </>
  ) : null;
}

export function useEventResponse(reply: InvitationActions, event: CalendarEventFace, done?: () => void) {
  const t = useText("calendar");
  const report = useReport();
  const e = useText("event");
  const [review, setReview] = useState<{
    anchor: HTMLElement;
    answer: InvitationAnswer;
    base: string;
    seriesBase: string;
    copy?: { calendarId: string; attendee: string };
  } | null>(null);
  const words = useText("invitations");
  const record = reply.invitation(event.recordId);
  const series = event.ref.occurrence !== null ? reply.invitation(event.ref.event) : null;
  const answer = record?.myAnswer ? (event.said?.answer ?? record.myAnswer) : null;
  const close = () => {
    setReview(null);
    done?.();
  };
  const choose = (value: InvitationAnswer, anchor: HTMLElement) => {
    if (!record?.myAnswer) return;
    if (series) {
      setReview({
        anchor,
        answer: value,
        base: record.updatedAt,
        seriesBase: series.updatedAt,
        copy: series.hideAttendee
          ? { calendarId: series.calendarId, attendee: series.hideAttendee }
          : undefined,
      });
    } else {
      done?.();
      if (event.ref.occurrence === null) void reply.answer(event.recordId, value);
    }
  };
  const question = review && record && series && (
    <CalendarRecordScope
      anchor={review.anchor}
      question={
        answer === "none"
          ? t("actions.answerScope", { title: event.title })
          : t("actions.changeAnswer", { answer: words(`answer.${review.answer}`) })
      }
      occurrence={!record.thisAndFuture && record.id === series.id}
      onClose={close}
      onChoose={(scope) => {
        close();
        if (review.base !== record.updatedAt || series.updatedAt !== review.seriesBase) {
          report(e("refusal.changed"));
          return;
        }
        void reply.answer(series.id, review.answer, {
          base: review.seriesBase,
          occurrence: scope === "record" ? null : event.ref.occurrence,
          copy: review.copy,
        });
      }}
    />
  );
  return { answer, choose, question, reviewing: review !== null };
}
