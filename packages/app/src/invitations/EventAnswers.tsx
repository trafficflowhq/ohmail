import { useLayoutEffect, useMemo, useRef } from "react";
import {
  viewOnlyOf,
  type CalendarConnectionRecord,
  type CalendarPort,
  type CalendarRecord,
} from "@ohmail/app-logic/calendar";
import { invitedByOthers, pressAnswer, type InvitationAnswer } from "@ohmail/app-logic/calendar/invitations";
import { useFrame, useReport } from "../frame/commands.js";
import { useKnownOwnAddresses } from "../frame/room.js";
import { useText } from "../text/index.js";
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
  const answer = async (recordId: string, value: InvitationAnswer) => {
    const current = invitation(recordId);
    if (pending.current.has(recordId) || !current?.myAnswer || current.myAnswer === value) return;
    const request = Symbol();
    pending.current.set(recordId, request);
    try {
      const outcome = await pressAnswer(port, { recordId }, value);
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

export function EventAnswers({ reply, recordId }: { reply: InvitationActions; recordId: string }) {
  const record = reply.invitation(recordId);
  return record?.myAnswer ? (
    <AnswerChoices
      on="sheet"
      answer={record.myAnswer}
      onAnswer={(value) => void reply.answer(recordId, value)}
    />
  ) : null;
}
