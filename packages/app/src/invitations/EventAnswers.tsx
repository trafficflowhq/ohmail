import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  viewOnlyOf,
  pressAndHear,
  type CalendarConnectionRecord,
  type CalendarPort,
  type CalendarRecord,
} from "@ohmail/app-logic/calendar";
import { invitedByOthers, pressAnswer, type InvitationAnswer } from "@ohmail/app-logic/calendar/invitations";
import { useFrame, useReport } from "../frame/commands.js";
import { useKnownOwnAddresses } from "../frame/room.js";
import { useText } from "../text/index.js";
import type { CalendarEventFace } from "../calendar/faces.js";
import { CalendarRecordScope } from "../calendar/EventActionQuestion.js";
import type { AnswerSwitchProps } from "@ohmail/ui/calendar";
import { AnswerChoices } from "./AnswerChoices.js";

export function useInvitationAnswer(port: CalendarPort) {
  const { host } = useFrame();
  const addresses = useKnownOwnAddresses();
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
    if (own === null) return null;
    const record = port.events().find((item) => item.record.id === recordId)?.record;
    if (!record || record.heldBack || record.status === "cancelled" || !invitedByOthers(record, own))
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
    reviewed?: { base: string; seriesBase?: string; occurrence: string | null },
  ) => {
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
  const t = useText("calendar");
  const report = useReport();
  const e = useText("event");
  const [question, setQuestion] = useState<{
    anchor: HTMLElement;
    answer: InvitationAnswer;
    base: string;
    seriesBase: string;
  } | null>(null);
  const record = reply.invitation(event.recordId);
  if (!record?.myAnswer) return null;
  const series = event.ref.occurrence !== null ? reply.invitation(event.ref.event) : null;
  return (
    <>
      <AnswerChoices
        on="sheet"
        answer={record.myAnswer}
        propose={propose}
        onAnswer={(value, anchor) => {
          if (series)
            setQuestion({ anchor, answer: value, base: record.updatedAt, seriesBase: series.updatedAt });
          else if (!event.ref.occurrence) void reply.answer(event.recordId, value);
        }}
      />
      {question && series && (
        <CalendarRecordScope
          anchor={question.anchor}
          question={t("actions.answerScope", { title: event.title })}
          occurrence={!record.thisAndFuture}
          onClose={() => setQuestion(null)}
          onChoose={(scope) => {
            setQuestion(null);
            if (question.base !== record.updatedAt) {
              report(e("refusal.changed"));
              return;
            }
            if (series.updatedAt !== question.seriesBase) {
              report(e("refusal.changed"));
              return;
            }
            const changed = scope === "occurrence" && record.id !== series.id;
            void reply.answer(changed ? record.id : series.id, question.answer, {
              base: changed ? question.base : question.seriesBase,
              seriesBase: changed ? question.seriesBase : undefined,
              occurrence: scope === "record" ? null : event.ref.occurrence,
            });
          }}
        />
      )}
    </>
  );
}
