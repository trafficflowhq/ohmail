import { and, desc, eq, isNull, like, ne, sql } from "drizzle-orm";
import {
  accountSettings, calAttendees, calCalendars, calConnections, calEvents, invitationStanding, mailboxes,
  drafts, messageInvitations, messages, outboundSends, sameAddress,
} from "@trafficflow/db";
import { ownOrganizerAddresses } from "@trafficflow/db/calendar";
import { invitationCounterText } from "@trafficflow/core/mail";
import { intlZones } from "@ohmail/cal-core/time/zones";
import type { CalendarAnswer, CalendarProposalAct, CalendarTime } from "@ohmail/wire";
import { bridgeTx, type ServiceContext } from "../context.js";
import { draftsService } from "../drafts-service.js";
import { ServiceError } from "../errors.js";
import { requireUuid } from "../ids.js";
import { invitationProposalKey, INVITATION_PROPOSAL_MARK } from "../invitation-answer-draft.js";
import { cancelled, notAnswerable, readInvitation, refuseWithdrawnKey, type InvitationAnswerDeps } from "../invitation-answer-service.js";
import { sendService, type SendResult } from "../send-service.js";
import { storedOccurrence } from "./event-range.js";
import { requireCalendarOn } from "./settings-service.js";
import { DAY_MS, eventTimeOf, isExactMoment, momentOrUtc, storedTimeOf } from "./time.js";

const proposalZones = intlZones();

function proposalTime(raw: unknown): CalendarTime | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { kind, value, zone } = raw as Partial<CalendarTime>;
  if (typeof value !== "string" || value.length > 16) return null;
  if (kind !== "date" && kind !== "instant" && kind !== "zoned" && kind !== "floating") return null;
  if (kind === "zoned" && (typeof zone !== "string" || zone.length > 128)) return null;
  const time = eventTimeOf({ kind, value, zone });
  if (!time) return null;
  if (time.kind !== "zoned") return storedTimeOf(time);
  if (!isExactMoment(time, proposalZones)) return null;
  return storedTimeOf({ kind: "instant", epochMs: momentOrUtc(time, proposalZones) });
}

type ProposalEvent = typeof calEvents.$inferSelect;

async function hasProposalOccurrence(ctx: ServiceContext, event: ProposalEvent, occurrence: string) {
  if (event.recurrenceId === "" && occurrence) {
    const [exception] = await bridgeTx(ctx.db).select({ id: calEvents.id }).from(calEvents).where(and(
      eq(calEvents.accountId, ctx.accountId), eq(calEvents.calendarId, event.calendarId), eq(calEvents.uid, event.uid),
      eq(calEvents.recurrenceId, occurrence),
    )).limit(1);
    if (exception) return false;
  }
  return storedOccurrence(event, occurrence);
}

async function proposalEvent(ctx: ServiceContext, act: CalendarProposalAct) {
  const db = bridgeTx(ctx.db);
  const [held] = await db.select({ event: calEvents, calendar: calCalendars, connection: calConnections }).from(calEvents)
    .innerJoin(calCalendars, and(eq(calCalendars.id, calEvents.calendarId), eq(calCalendars.accountId, calEvents.accountId)))
    .innerJoin(calConnections, and(eq(calConnections.id, calCalendars.connectionId), eq(calConnections.accountId, calCalendars.accountId)))
    .where(and(eq(calEvents.accountId, ctx.accountId), eq(calEvents.id, requireUuid(act.recordId, "recordId")))).limit(1);
  if (!held) throw new ServiceError("not_found", 404, "The event was not found.");
  const { event, calendar, connection } = held;
  if (!event.organizer || event.partial || event.heldBack || event.thisAndFuture || event.status === "cancelled" ||
    !calendar.shown || calendar.access === "reader" || calendar.access === "busy" || connection.provider === "ics") {
    throw notAnswerable("This event cannot take a proposal.");
  }
  if (act.base !== event.updatedAt.toISOString() || typeof act.occurrence !== "string" ||
    act.occurrence.length > 256 || !await hasProposalOccurrence(ctx, event, act.occurrence)) {
    throw new ServiceError("conflict", 409, "The event changed. Open it again.");
  }
  const own = await ownOrganizerAddresses(db, ctx.accountId, connection.principal, connection.organizerAddresses);
  const attendees = await db.select({ address: calAttendees.address, answer: calAttendees.answer }).from(calAttendees)
    .where(and(eq(calAttendees.eventId, event.id), eq(calAttendees.accountId, ctx.accountId)));
  return { event, connection, organizer: event.organizer, owned: own.has(event.organizer.toLowerCase()), attendees };
}

type ProposalTarget = {
  mailboxId: string;
  attendee: string;
  organizer: string;
  parent: { messageId: string; threadId: string | null } | null;
  answer: CalendarAnswer;
  start: CalendarTime | null;
  end: CalendarTime | null;
};

async function counterTarget(
  ctx: ServiceContext, act: Extract<CalendarProposalAct, { kind: "calendar_event_propose" }>,
  { event, connection, organizer, owned, attendees }: Awaited<ReturnType<typeof proposalEvent>>,
): Promise<ProposalTarget> {
  if (owned || event.myAnswer === null) throw notAnswerable("Only an invitee can propose a time.");
  const db = bridgeTx(ctx.db);
  const boxes = await db.select({ id: mailboxes.id, address: mailboxes.address }).from(mailboxes)
    .where(and(eq(mailboxes.accountId, ctx.accountId), ne(mailboxes.status, "disabled")));
  const choices = boxes.filter((box) => attendees.some((a) => sameAddress(a.address, box.address)));
  const principal = connection.principal?.replace(/^mailto:/i, "");
  const sender = choices.find((box) => box.id === connection.mailboxId)
    ?? choices.find((box) => sameAddress(box.address, principal))
    ?? (choices.length === 1 ? choices[0] : undefined);
  if (!sender) throw notAnswerable("The invited mailbox could not be identified.");

  const [letter] = await db.select({ row: messageInvitations, threadId: messages.threadId }).from(messageInvitations)
    .innerJoin(messages, and(eq(messages.id, messageInvitations.messageId), eq(messages.accountId, messageInvitations.accountId)))
    .where(and(
      eq(messageInvitations.accountId, ctx.accountId), eq(messageInvitations.mailboxId, sender.id),
      eq(messageInvitations.uid, event.uid), eq(messageInvitations.sequence, event.sequence),
      eq(messageInvitations.method, "REQUEST"), isNull(messages.deletedAt),
      sql`lower(${messageInvitations.organizer}) = ${organizer.toLowerCase()}`,
      sql`lower(${messageInvitations.invitedAddress}) = ${sender.address.toLowerCase()}`,
      act.occurrence === "" ? eq(messageInvitations.recurrenceId, "") :
        sql`${messageInvitations.recurrenceId} in ('', ${act.occurrence})`,
    )).orderBy(desc(messageInvitations.recurrenceId), desc(messageInvitations.stampedAt)).limit(1);
  const standing = await invitationStanding(db, {
    accountId: ctx.accountId, mailboxId: sender.id, uid: event.uid, recurrenceId: act.occurrence,
    sequence: event.sequence, organizer, stampedAt: letter?.row.stampedAt ?? null,
  });
  if (standing.cancelled) throw cancelled();
  if (standing.replacedBy) throw notAnswerable("A newer invitation replaced this one.");
  return {
    mailboxId: sender.id, attendee: sender.address, organizer,
    parent: letter ? { messageId: letter.row.messageId, threadId: letter.threadId } : null,
    answer: (attendees.find((a) => sameAddress(a.address, sender.address))?.answer ?? event.myAnswer) as CalendarAnswer,
    start: proposalTime(act.start), end: proposalTime(act.end),
  };
}

async function keepTarget(
  ctx: ServiceContext, act: Extract<CalendarProposalAct, { kind: "calendar_proposal_keep" }>,
  { event, organizer, owned, attendees }: Awaited<ReturnType<typeof proposalEvent>>,
): Promise<ProposalTarget> {
  const { row, mailbox, threadId, from } = await readInvitation(ctx, requireUuid(act.messageId, "messageId"));
  const proposal = row.proposal;
  if (!owned || row.method !== "COUNTER" || !proposal || row.uid !== event.uid ||
    row.recurrenceId !== act.occurrence || row.sequence !== event.sequence ||
    !sameAddress(row.organizer, organizer) || !sameAddress(mailbox?.address, organizer) ||
    mailbox?.status === "disabled" || !sameAddress(from, proposal.attendee) ||
    sameAddress(organizer, proposal.attendee) || !attendees.some((a) => sameAddress(a.address, proposal.attendee))) {
    throw notAnswerable("This proposal no longer matches the event or its invitee.");
  }
  return {
    mailboxId: row.mailboxId, attendee: proposal.attendee, organizer,
    parent: { messageId: row.messageId, threadId }, answer: "none", start: proposal.start, end: proposal.end,
  };
}

function proposalWords(start: CalendarTime, end: CalendarTime, keep: boolean, locale: string) {
  const formatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium", ...(start.kind === "date" ? {} : { timeStyle: "short" }), timeZone: "UTC",
  });
  const show = (time: CalendarTime) => new Date(momentOrUtc(eventTimeOf(time)!, proposalZones));
  const last = show(end);
  if (start.kind === "date") last.setTime(last.getTime() - DAY_MS);
  const interval = formatter.formatRange(show(start), last);
  const when = start.kind === "instant" ? `${interval} UTC` : interval;
  const subject = locale === "de" ? (keep ? "Termin bleibt unverändert" : "Neuer Terminvorschlag")
    : keep ? "Keeping the scheduled time" : "Proposed new time";
  const body = locale === "de" ? (keep ? `Der Termin bleibt unverändert. Vorgeschlagen: ${when}` : `Vorgeschlagene Zeit: ${when}`)
    : keep ? `The scheduled time stays. Proposed: ${when}` : `Proposed time: ${when}`;
  return { subject, body };
}

/** A proposal is mail only. It cannot create or queue a provider write. */
export async function sendInvitationProposal(
  ctx: ServiceContext, raw: unknown, key: string, deps: InvitationAnswerDeps, options: { recovering?: boolean } = {},
): Promise<Pick<SendResult, "status" | "seq">> {
  if (typeof raw !== "object" || raw === null) throw notAnswerable("This is not a proposal.");
  const act = raw as CalendarProposalAct;
  if (act.kind !== "calendar_event_propose" && act.kind !== "calendar_proposal_keep") {
    throw notAnswerable("This is not a proposal.");
  }
  if (options.recovering && act.kind === "calendar_event_propose") {
    // An answered send can predate a changed or now-missing calendar event. Resolve it first.
    const [prior] = await bridgeTx(ctx.db).select({ status: outboundSends.status }).from(outboundSends)
      .innerJoin(drafts, and(eq(drafts.id, outboundSends.draftId), eq(drafts.accountId, outboundSends.accountId)))
      .where(and(eq(outboundSends.accountId, ctx.accountId), eq(outboundSends.idempotencyKey, key),
        like(drafts.workflowDedupKey, INVITATION_PROPOSAL_MARK + "%"))).limit(1);
    if (prior?.status === "sent") return { status: "sent", seq: null };
  }
  await requireCalendarOn(ctx);
  await refuseWithdrawnKey(ctx, key);
  const held = await proposalEvent(ctx, act);
  const keep = act.kind === "calendar_proposal_keep";
  const target = keep ? await keepTarget(ctx, act, held) : await counterTarget(ctx, act, held);
  const { event } = held;
  const { start, end, parent, organizer, attendee, mailboxId, answer } = target;
  if (!start || !end || (event.startKind === "date") !== (start.kind === "date") ||
    !eventTimeOf(start) || !eventTimeOf(end)) throw notAnswerable("The proposed interval is invalid.");
  const method = keep ? "DECLINECOUNTER" : "COUNTER";
  const part = (stamp: Date) => invitationCounterText({
    method, uid: event.uid, sequence: event.sequence, recurrenceId: act.occurrence,
    startRaw: event.startLocal, startsAt: event.startsAt, organizer, invitedAddress: attendee,
    answer, stamp, start: start.value, end: end.value,
  });
  if (!part(ctx.now())) throw notAnswerable("The proposed interval cannot be written.");
  const [settings] = await bridgeTx(ctx.db).select({ locale: accountSettings.locale }).from(accountSettings)
    .where(eq(accountSettings.accountId, ctx.accountId)).limit(1);
  const to = keep ? attendee : organizer;
  const from = keep ? organizer : attendee;
  const draft = await (deps.drafts ?? draftsService).createOnce(ctx, {
    mailboxId, threadId: parent?.threadId ?? null, inReplyToMessageId: parent?.messageId ?? null,
    forwardOfMessageId: null, ...proposalWords(start, end, keep, settings?.locale === "de" ? "de" : "en"),
    to: [{ name: null, address: to }],
  }, invitationProposalKey(ctx.accountId, key, [
    act.recordId, act.base, act.occurrence, method, parent?.messageId ?? null, start.kind, start.value, end.value,
  ]));
  const sent = await (deps.sends ?? sendService).send(ctx, draft.id, key, deps.send, {
    calendar: { method, text: part(draft.createdAt)!, messageId: parent?.messageId ?? null, mailboxId, to, from },
  });
  if (sent.draftId !== draft.id) throw new ServiceError("conflict", 409, "This key belongs to another letter.");
  return { status: sent.status, seq: sent.seq };
}
