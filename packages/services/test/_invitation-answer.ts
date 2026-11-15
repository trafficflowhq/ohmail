/**
 * An invitation to answer, for the answer's tests: a letter in a mailbox with its row written
 * through the table's one door (`writeInvitation`), and a send adapter that counts what leaves.
 */
import { randomUUID } from "node:crypto";
import { mailboxes, messages, threads, writeInvitation, type Tx } from "@trafficflow/db";
import { SendNotSubmitted, type OpenSendAdapter, type OutboundMessage } from "@trafficflow/core";
import type { InvitationMethod } from "@ohmail/wire";

/** The mailbox invited, and the organizer who invites it. */
export const ME = "mila@lichtgrat.example";
export const ORGANIZER = "giulia@studio.example";

/** Any of the tests' stores: PGlite, the device's SQLite, or a real Postgres handle. */
type AnyDb = unknown;
const asTx = (db: AnyDb): Tx => db as Tx;

export interface Invitation {
  method?: InvitationMethod;
  uid?: string;
  recurrenceId?: string;
  sequence?: number;
  startRaw?: string | null;
  startsAt?: Date | null;
  organizer?: string | null;
  attendees?: readonly string[];
  /** Its DTSTAMP; the letter's date by default. */
  stampedAt?: Date | null;
  /** The letter's own Message-ID and subject, as its sender wrote them. */
  header?: string;
  subject?: string;
  threadId?: string | null;
}

/** A mailbox of its own for `accountId`, at `address`. */
export async function mailboxAt(db: AnyDb, accountId: string, address = ME): Promise<string> {
  const [mb] = await asTx(db).insert(mailboxes).values({ accountId, provider: "imap", address }).returning();
  return mb!.id;
}

/** A conversation the letter belongs to. */
export async function conversation(db: AnyDb, accountId: string): Promise<string> {
  const [t] = await asTx(db).insert(threads).values({ accountId, subject: "Kickoff", rootMessageIdHeader: `root-${randomUUID()}@studio.example` }).returning();
  return t!.id;
}

/** A letter carrying an invitation, its row written by the door; the letter's id. */
export async function invitationLetter(db: AnyDb, accountId: string, mailboxId: string, i: Invitation = {}): Promise<string> {
  const [letter] = await asTx(db).insert(messages).values({
    accountId, mailboxId, messageIdHeader: i.header ?? `invite-${randomUUID()}@studio.example`, bodyHash: randomUUID(),
    dedupKey: `mid:${randomUUID()}`, subject: i.subject ?? "Invitation: Kickoff", fromAddress: ORGANIZER,
    date: new Date("2026-11-10T08:00:00Z"), nativeLocator: { folder: "INBOX", ref: `1:${Math.floor(Math.random() * 1e6)}` },
    snippet: "", unread: true, threadId: i.threadId ?? null,
  }).returning();
  const messageId = letter!.id;
  const w = await writeInvitation(asTx(db), {
    accountId, messageId, method: i.method ?? "REQUEST", uid: i.uid ?? "kickoff-17@studio.example",
    recurrenceId: i.recurrenceId ?? "", sequence: i.sequence ?? 0,
    startRaw: i.startRaw === undefined ? "20261201T100000Z" : i.startRaw,
    startsAt: i.startsAt === undefined ? new Date("2026-12-01T10:00:00Z") : i.startsAt,
    organizer: i.organizer === undefined ? ORGANIZER : i.organizer, attendees: i.attendees ?? [ME, ORGANIZER],
    stampedAt: i.stampedAt === undefined ? new Date("2026-11-10T08:00:00Z") : i.stampedAt,
    reply: null, own: false,
  });
  if (!w.written) throw new Error("the door wrote no row for this invitation");
  return messageId;
}

/** A send adapter that counts what leaves; `fail` names the presses whose submission never starts. */
export function outbox(opts: { fail?: ReadonlySet<number> } = {}) {
  const sent: OutboundMessage[] = [];
  let tries = 0;
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      tries += 1;
      if (opts.fail?.has(tries)) throw new SendNotSubmitted("connect", Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }));
      sent.push(msg);
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() { return false; },
    async close() { /* nothing to close */ },
  });
  return { sent, factory, tries: (): number => tries };
}

/** The DTSTAMP a calendar part carries, as an instant. */
export function stampOf(text: string): number {
  const m = /\r\nDTSTAMP:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\r\n/.exec(text);
  if (m === null) throw new Error("no DTSTAMP");
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}
