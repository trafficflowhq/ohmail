/**
 * AN ANSWER TO AN INVITATION, through the calendar's one press seam and nothing else. The record is read again by its
 * id at the press: an invitation gone or cancelled since its row was drawn is not answered. Whether the calendar takes
 * an answer for a repeating event is the door's to say, and its word is said as it stands.
 */
import type { CalendarEventAct, CalendarEventRecord } from "@ohmail/wire";
import type { CalendarPort } from "../port.js";
import { pressAndHear, type Heard } from "../press.js";
import type { InvitationRow } from "./contract.js";

export type InvitationAnswer = "accepted" | "tentative" | "declined";

export function answerOf(
  row: Pick<InvitationRow, "recordId">,
  answer: InvitationAnswer,
  record: CalendarEventRecord,
): Extract<CalendarEventAct, { kind: "calendar_event_answer" }> {
  return {
    kind: "calendar_event_answer",
    eventId: row.recordId,
    base: record.updatedAt,
    scope: record.recurrenceId === "" ? { kind: "record" } : { kind: "occurrence", at: record.recurrenceId },
    answer,
  };
}

export type AnswerOutcome = { readonly pressed: false } | ({ readonly pressed: true } & Heard);

export async function pressAnswer(
  port: Pick<CalendarPort, "events" | "press" | "flush" | "verdict">,
  row: Pick<InvitationRow, "recordId">,
  answer: InvitationAnswer,
): Promise<AnswerOutcome> {
  const record = port.events().find((e) => e.record.id === row.recordId)?.record;
  if (record === undefined || record.status === "cancelled") return { pressed: false };
  return { pressed: true, ...(await pressAndHear(port, answerOf(row, answer, record))) };
}
