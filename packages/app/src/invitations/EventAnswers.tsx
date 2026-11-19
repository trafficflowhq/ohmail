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

export function EventAnswers({ port, recordId }: { readonly port: CalendarPort; readonly recordId: string }) {
  const { host } = useFrame();
  const addresses = useKnownOwnAddresses();
  const own = useMemo(() => addresses && new Set(addresses.map((a) => a.trim().toLowerCase())), [addresses]);
  const report = useReport();
  const e = useText("event");
  const pending = useRef<symbol | null>(null);
  useLayoutEffect(
    () => () => {
      pending.current = null;
    },
    [port, recordId, host.engine],
  );

  const invitation = () => {
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
  const answer = async (value: InvitationAnswer) => {
    const current = invitation();
    if (pending.current !== null || !current || current.myAnswer === value) return;
    const request = Symbol();
    pending.current = request;
    try {
      const outcome = await pressAnswer(port, { recordId }, value);
      if (pending.current === request && outcome.pressed && outcome.say !== null) report(e(outcome.say));
    } catch {
      if (pending.current === request) report(e("refusal.unknown"));
    } finally {
      if (pending.current === request) pending.current = null;
    }
  };
  const record = invitation();
  return record?.myAnswer ? <AnswerChoices on="sheet" answer={record.myAnswer} onAnswer={answer} /> : null;
}
