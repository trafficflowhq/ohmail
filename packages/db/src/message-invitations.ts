import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { InvitationAnswer, InvitationMethod, InvitationProposal, InvitationProposalTimes, MessageInvitationDTO } from "@ohmail/wire";
import { mailboxes, messageInvitations, messages } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/**
 * THE ONE DOOR TO `message_invitations` (mail 0204): the identity of the invitation a letter
 * carries, written at ingest, by the pass over stored mail and by the desktop's copy of a Cloud
 * account, and the answer recorded on it.
 *
 * Every value is held to its column's domain BEFORE any statement: on Postgres a failed statement
 * spoils the letter's whole transaction, so a value past a bound means no row, never a cut value
 * and never a refused statement. The UID and the occurrence are the sender's text and are bounded
 * in bytes (a btree keys on them); an address is bounded as a stored address is.
 *
 * Addresses are compared here, never in SQL (the two stores lower case differently), and with the
 * ASCII letters folded alone: no Unicode case mapping, no normalisation, no dot or plus rule. A
 * mailbox whose address is empty or not ASCII matches nothing.
 */

/** cal-store's bound on an event's UID: a longer one keeps no row. */
export const INVITATION_UID_MAX_BYTES = 1_024;
/** The occurrence's key (`ics.ts`'s canonical form, a zone's name inside it). */
export const INVITATION_RECURRENCE_ID_MAX_BYTES = 320;
/** RFC 5321's 254, as a stored address is bounded. */
export const INVITATION_ADDRESS_MAX_CHARS = 254;
const SEQUENCE_MAX = 2 ** 31 - 1;
const METHODS: ReadonlySet<string> = new Set<InvitationMethod>(["REQUEST", "REPLY", "CANCEL", "COUNTER", "DECLINECOUNTER"]);
const ANSWERS: ReadonlySet<string> = new Set<InvitationAnswer>(["accepted", "tentative", "declined"]);
const START_SHAPE = /^\d{8}(?:T\d{6}Z?)?$/;

/** What the ingest read off one letter's calendar part (core's `LetterInvitation`), and whose it is. */
export interface InvitationWrite {
  accountId: string;
  messageId: string;
  method: InvitationMethod;
  uid: string;
  recurrenceId: string;
  sequence: number;
  startRaw: string | null;
  startsAt: Date | null;
  organizer: string | null;
  attendees: readonly string[];
  /** DTSTAMP: orders one revision's letters. */
  stampedAt: Date | null;
  reply: { answer: InvitationAnswer; at: Date | null } | null;
  proposal?: InvitationProposalTimes;
  /** The letter was read out of this mailbox's own Sent folder: the person wrote it. */
  own: boolean;
}

/** The row's own values, before they reach a statement. */
interface RowValues {
  method: string;
  uid: string;
  recurrenceId: string;
  sequence: number;
  startRaw: string | null;
  startsAt: Date | null;
  organizer: string | null;
  invitedAddress: string | null;
  proposal?: InvitationProposal | null;
  answer: string | null;
  answeredAt: Date | null;
  stampedAt: Date | null;
}

/** Controls (U+0000 to U+001F, U+007F to U+009F) and the two Unicode line breaks: never in a kept string. */
function holdsControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

const addressInDomain = (a: string | null): boolean =>
  a === null || (a.length > 0 && a.length <= INVITATION_ADDRESS_MAX_CHARS && a.includes("@") && !holdsControl(a));
const instantInDomain = (d: Date | null): boolean => d === null || (d instanceof Date && Number.isFinite(d.getTime()));

function proposalInDomain(p: InvitationProposal): boolean {
  const shape = (value: unknown) => {
    if (value === null || typeof value !== "object") return false;
    const time = value as InvitationProposalTimes["start"];
    return typeof time.value === "string" && (
      (time.kind === "date" && /^\d{8}$/.test(time.value)) ||
      (time.kind === "instant" && /^\d{8}T\d{6}Z$/.test(time.value)) ||
      (time.kind === "floating" && /^\d{8}T\d{6}$/.test(time.value))
    );
  };
  return typeof p.attendee === "string" && addressInDomain(p.attendee) && shape(p.start) && shape(p.end)
    && p.start.kind === p.end.kind && p.start.value < p.end.value;
}

/** Every column of a row in its domain, or no row. */
function inDomain(row: RowValues): boolean {
  if (row.uid.length === 0 || holdsControl(row.uid)) return false;
  if (Buffer.byteLength(row.uid, "utf8") > INVITATION_UID_MAX_BYTES) return false;
  if (holdsControl(row.recurrenceId)) return false;
  if (Buffer.byteLength(row.recurrenceId, "utf8") > INVITATION_RECURRENCE_ID_MAX_BYTES) return false;
  if (!METHODS.has(row.method)) return false;
  if (!Number.isInteger(row.sequence) || row.sequence < 0 || row.sequence > SEQUENCE_MAX) return false;
  if (row.startRaw !== null && !START_SHAPE.test(row.startRaw)) return false;
  if (row.answer !== null && !ANSWERS.has(row.answer)) return false;
  if (row.proposal && !proposalInDomain(row.proposal)) return false;
  return addressInDomain(row.organizer) && addressInDomain(row.invitedAddress)
    && instantInDomain(row.startsAt) && instantInDomain(row.answeredAt) && instantInDomain(row.stampedAt);
}

/** The ASCII letters folded, nothing else. */
function foldAscii(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

/**
 * ONE ADDRESS, as an invitation and a mailbox may spell it: equal but for the case of the ASCII
 * letters. An empty address, or one with a character outside ASCII, equals nothing.
 */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || /[^ -~]/.test(a) || /[^ -~]/.test(b)) return false;
  return foldAscii(a) === foldAscii(b);
}

/**
 * Which of the mailbox's addresses the invitation names, as the invitation spelled it, or null. A
 * REPLY names the replier first, and only the person's own reply (read from Sent) names them; any
 * other letter names the mailbox among its invitees, unless the mailbox is its organizer.
 */
function invitedAddressOf(w: InvitationWrite, mailboxAddress: string | null): string | null {
  if (w.method === "REPLY") {
    const first = w.attendees[0];
    return w.own && sameAddress(first, mailboxAddress) ? first! : null;
  }
  if (sameAddress(w.organizer, mailboxAddress)) return null;
  return w.attendees.find((a) => sameAddress(a, mailboxAddress)) ?? null;
}

/**
 * WRITE THE INVITATION ONE LETTER CARRIES, in the caller's transaction: the row, and on the
 * person's own REPLY the answer it records on the REQUEST it answers. `written` says whether a row
 * was made; `touched` names the OTHER letters whose row changed, each owed a message change by the
 * caller. Values past a bound, a letter not this account's, a row already there: nothing written.
 */
export async function writeInvitation(tx: Tx, w: InvitationWrite): Promise<{ written: boolean; touched: string[] }> {
  const none = { written: false, touched: [] };
  const [letter] = await tx.select({
    mailboxId: messages.mailboxId, date: messages.date, createdAt: messages.createdAt, address: mailboxes.address, from: messages.fromAddress,
  }).from(messages)
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(and(eq(messages.id, w.messageId), eq(messages.accountId, w.accountId)))
    .limit(1);
  if (letter === undefined) return none;
  // A proposal's named sender has to be an attendee. A refusal has to come from the organizer.
  const attendee = w.method === "COUNTER"
    ? w.attendees.find((a) => sameAddress(a, letter.from))
    : w.method === "DECLINECOUNTER" && sameAddress(letter.from, w.organizer)
      ? w.attendees[0]
      : undefined;
  const invitedAddress = w.method === "DECLINECOUNTER" ? attendee ?? null : invitedAddressOf(w, letter.address);
  let answer: InvitationAnswer | null = null;
  let answeredAt: Date | null = null;
  if (w.method === "REPLY" && w.reply !== null) {
    answer = w.reply.answer;
    // DTSTAMP orders a person's answers; a reply that wrote none is dated by its letter.
    answeredAt = w.reply.at ?? letter.date ?? letter.createdAt;
  }
  const row: RowValues = {
    method: w.method, uid: w.uid, recurrenceId: w.recurrenceId, sequence: w.sequence, startRaw: w.startRaw,
    startsAt: w.startsAt, organizer: w.organizer, invitedAddress, answer, answeredAt, stampedAt: w.stampedAt ?? null,
    ...(w.proposal && attendee ? { proposal: { ...w.proposal, attendee } } : {}),
  };
  if (!inDomain(row)) return none;
  if (w.method === "REQUEST" && row.organizer !== null) {
    // An answer the person sent this organizer before this letter arrived (its Sent copy stored
    // first) is on record. Another organizer's letter for the same UID is another invitation.
    const given = (await tx.select({
      answer: messageInvitations.answer, answeredAt: messageInvitations.answeredAt, organizer: messageInvitations.organizer,
    })
      .from(messageInvitations)
      .where(and(
        eq(messageInvitations.accountId, w.accountId), eq(messageInvitations.mailboxId, letter.mailboxId),
        eq(messageInvitations.uid, row.uid), eq(messageInvitations.recurrenceId, row.recurrenceId),
        eq(messageInvitations.sequence, row.sequence), eq(messageInvitations.method, "REPLY"),
        sql`${messageInvitations.invitedAddress} is not null`, sql`${messageInvitations.answer} is not null`,
      ))
      .orderBy(desc(messageInvitations.answeredAt)))
      .find((r) => sameAddress(r.organizer, row.organizer));
    if (given !== undefined && ANSWERS.has(given.answer ?? "")) {
      row.answer = given.answer;
      row.answeredAt = given.answeredAt;
    }
  }
  const made = await tx.insert(messageInvitations).values({
    accountId: w.accountId, messageId: w.messageId, mailboxId: letter.mailboxId, ...row,
  }).onConflictDoNothing().returning({ messageId: messageInvitations.messageId });
  if (made.length === 0) return none;
  const touched = w.method === "REPLY" && invitedAddress !== null && answer !== null && answeredAt !== null
    ? await recordInvitationAnswer(tx, {
      accountId: w.accountId, mailboxId: letter.mailboxId, uid: row.uid, recurrenceId: row.recurrenceId,
      sequence: row.sequence, organizer: row.organizer, answer, at: answeredAt,
    })
    : [];
  return { written: true, touched };
}

/** The answer a mailbox gave an invitation, to whom, and when. */
export interface InvitationAnswerRecord {
  accountId: string;
  mailboxId: string;
  uid: string;
  recurrenceId: string;
  sequence: number;
  /** The organizer the answer went to: only that organizer's invitations take it. */
  organizer: string | null;
  answer: InvitationAnswer;
  at: Date;
}

/**
 * RECORD AN ANSWER on the REQUEST rows it answers: this mailbox's living letters from the same
 * organizer asking for the same event, occurrence and revision, where no answer is on record or an
 * older one is. Another organizer's letter for the same UID is another invitation, and an answer
 * naming no organizer answers nobody. Returns their message ids, each owed a message change by the
 * caller. The ingest of the person's own REPLY calls it, and the answer route once its letter was
 * sent: an answer is recorded only once it left.
 */
export async function recordInvitationAnswer(tx: Tx, a: InvitationAnswerRecord): Promise<string[]> {
  if (!ANSWERS.has(a.answer) || !instantInDomain(a.at) || a.organizer === null) return [];
  const older = or(isNull(messageInvitations.answeredAt), lt(messageInvitations.answeredAt, a.at));
  const asked = await tx.select({ messageId: messageInvitations.messageId, organizer: messageInvitations.organizer })
    .from(messageInvitations)
    .where(and(
      eq(messageInvitations.accountId, a.accountId), eq(messageInvitations.mailboxId, a.mailboxId),
      eq(messageInvitations.uid, a.uid), eq(messageInvitations.recurrenceId, a.recurrenceId),
      eq(messageInvitations.sequence, a.sequence), eq(messageInvitations.method, "REQUEST"), older,
      sql`exists (select 1 from ${messages} where ${messages.id} = ${messageInvitations.messageId}
        and ${messages.accountId} = ${a.accountId} and ${messages.deletedAt} is null)`,
    ));
  // Addresses are compared here, never in SQL (see the module's header).
  const ids = asked.filter((r) => sameAddress(r.organizer, a.organizer)).map((r) => r.messageId);
  if (ids.length === 0) return [];
  const changed = await tx.update(messageInvitations).set({ answer: a.answer, answeredAt: a.at })
    .where(and(eq(messageInvitations.accountId, a.accountId), inArray(messageInvitations.messageId, ids), older))
    .returning({ messageId: messageInvitations.messageId });
  return changed.map((r) => r.messageId);
}

/** The invitation whose standing is asked: the stored row of the letter being answered. */
export interface InvitationStandingAsk {
  accountId: string;
  mailboxId: string;
  uid: string;
  recurrenceId: string;
  sequence: number;
  organizer: string | null;
  stampedAt: Date | null;
}

/**
 * Is a cancellation at `cancel` the later letter than the invitation at `ask`? The calendar standard
 * orders an event's letters by SEQUENCE, and one SEQUENCE by DTSTAMP. One revision that cannot be
 * ordered (a stamp missing, or the same stamp) leaves the cancellation standing.
 */
function cancelsAfter(
  cancel: { sequence: number; stampedAt: Date | null }, ask: { sequence: number; stampedAt: Date | null },
): boolean {
  if (cancel.sequence !== ask.sequence) return cancel.sequence > ask.sequence;
  return cancel.stampedAt == null || ask.stampedAt == null || cancel.stampedAt.getTime() >= ask.stampedAt.getTime();
}

/**
 * WHAT STANDS OF AN INVITATION in this mailbox, from the same organizer: `cancelled` when a living
 * letter cancels the event or this occurrence after this invitation was written (a later revision,
 * or the same one stamped later: a person removed and invited again answers the new invitation);
 * `replacedBy` names the living letter asking for the same occurrence at the highest later
 * revision. The same revision sent again replaces nothing.
 */
export async function invitationStanding(
  tx: Tx, ask: InvitationStandingAsk,
): Promise<{ cancelled: boolean; replacedBy: string | null }> {
  if (ask.organizer === null) return { cancelled: false, replacedBy: null };
  const rows = await tx.select({
    messageId: messageInvitations.messageId, method: messageInvitations.method, recurrenceId: messageInvitations.recurrenceId,
    sequence: messageInvitations.sequence, organizer: messageInvitations.organizer, stampedAt: messageInvitations.stampedAt,
  }).from(messageInvitations)
    .innerJoin(messages, and(eq(messages.id, messageInvitations.messageId), eq(messages.accountId, messageInvitations.accountId)))
    .where(and(
      eq(messageInvitations.accountId, ask.accountId), eq(messageInvitations.mailboxId, ask.mailboxId),
      eq(messageInvitations.uid, ask.uid), inArray(messageInvitations.method, ["CANCEL", "REQUEST"]),
      isNull(messages.deletedAt),
    ));
  let cancelled = false;
  let replacedBy: { messageId: string; sequence: number } | null = null;
  for (const r of rows) {
    if (!sameAddress(r.organizer, ask.organizer)) continue;
    if (r.method === "CANCEL" && (r.recurrenceId === "" || r.recurrenceId === ask.recurrenceId) && cancelsAfter(r, ask)) {
      cancelled = true;
    } else if (r.method === "REQUEST" && r.recurrenceId === ask.recurrenceId && r.sequence > ask.sequence
      && (replacedBy === null || r.sequence > replacedBy.sequence)) {
      replacedBy = { messageId: r.messageId, sequence: r.sequence };
    }
  }
  return { cancelled, replacedBy: replacedBy?.messageId ?? null };
}

/** Whose letter a copied row belongs to. */
export interface InvitationCopyOf {
  accountId: string;
  messageId: string;
  mailboxId: string;
}

/**
 * THE DESKTOP'S COPY OF A CLOUD ACCOUNT: the row as the message record carried it
 * (`MessageDTO.invitation`), or none when the record carried no field. A field past a bound is no
 * row here either.
 */
export async function putInvitationCopy(tx: Tx, of: InvitationCopyOf, field: MessageInvitationDTO | null | undefined): Promise<void> {
  const mine = and(eq(messageInvitations.accountId, of.accountId), eq(messageInvitations.messageId, of.messageId));
  const instant = (iso: string | null | undefined): Date | null => (typeof iso === "string" ? new Date(iso) : null);
  // The record carries no stamp: a copy's row is drawn, never answered from (the answer is the
  // Cloud's, through the relayed route).
  const row: RowValues | null = field == null ? null : {
    method: field.method, uid: field.uid, recurrenceId: field.recurrenceId ?? "", sequence: field.sequence,
    startRaw: field.start ?? null, startsAt: instant(field.startsAt), organizer: field.organizer ?? null,
    invitedAddress: field.invitedAddress ?? null, answer: field.answer ?? null, answeredAt: instant(field.answeredAt),
    stampedAt: null, proposal: field.proposal ?? null,
  };
  if (row === null || typeof row.uid !== "string" || typeof row.recurrenceId !== "string" || !inDomain(row)) {
    await tx.delete(messageInvitations).where(mine);
    return;
  }
  await tx.insert(messageInvitations).values({ accountId: of.accountId, messageId: of.messageId, mailboxId: of.mailboxId, ...row })
    .onConflictDoUpdate({ target: [messageInvitations.accountId, messageInvitations.messageId], set: { mailboxId: of.mailboxId, ...row } });
}

/** The wire's field from a stored row: the row's own values, the instants as ISO text. */
/** One personal calendar copy across revisions from the same organizer to the same mailbox. */
export function invitationCalendarId(row: Pick<typeof messageInvitations.$inferSelect,
  "accountId" | "mailboxId" | "uid" | "recurrenceId" | "organizer">): string {
  const hex = createHash("sha256").update(JSON.stringify([
    row.accountId, row.mailboxId, row.uid, row.recurrenceId, row.organizer?.toLowerCase(),
  ])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function invitationFieldOf(row: typeof messageInvitations.$inferSelect): MessageInvitationDTO | undefined {
  if (!METHODS.has(row.method)) return undefined;
  return {
    method: row.method as InvitationMethod,
    ...((row.method === "REQUEST" || row.method === "CANCEL") && { calendarEventId: invitationCalendarId(row) }),
    ...(row.proposal ? { proposal: row.proposal } : {}),
    uid: row.uid,
    recurrenceId: row.recurrenceId,
    sequence: row.sequence,
    start: row.startRaw,
    startsAt: row.startsAt === null ? null : row.startsAt.toISOString(),
    organizer: row.organizer,
    invitedAddress: row.invitedAddress,
    answer: row.answer !== null && ANSWERS.has(row.answer) ? (row.answer as InvitationAnswer) : null,
    answeredAt: row.answeredAt === null ? null : row.answeredAt.toISOString(),
  };
}
