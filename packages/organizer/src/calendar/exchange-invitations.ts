/**
 * MEETING INVITATIONS THAT CAME AS AN OUTLOOK WEB APP LINK, GIVEN THEIR CARD. Exchange sends some
 * invitations over IMAP as a link that names the event's calendar item and carries no event. Where
 * the account has a Microsoft calendar connection, its turn looks the event up in that calendar by
 * the link's item id and writes the letter's invitation row through the table's one door
 * (`writeInvitation`), with the answer Graph has on record, and a message change: every device then
 * draws the ordinary invitation card, and an answer goes through the calendar's own write path to
 * the synced event. Without such a connection nothing here runs, and the letter keeps its note.
 *
 * Bounded: letters of the last {@link EXCHANGE_INVITATION_DAYS} days with no row yet, a look at most
 * every {@link EXCHANGE_SCAN_EVERY_MS} per connection, at most {@link EXCHANGE_LOOKUPS_PER_TURN} looked up a look. The row is the letter's cache: a letter
 * with one is never asked about again. A letter whose lookup failed is asked again in a later turn,
 * at most {@link EXCHANGE_LOOKUP_TRIES} times in this process; one Graph says names nothing is not
 * asked again. Only the turn's own connection is asked, and only the letters of the mailbox it rides,
 * or the account's own mailboxes where it rides none; the link itself is never fetched.
 */
import type { CalEvent, EventTime, Wall, ZoneSource } from "@ohmail/cal-core";
import { instantOf, wallFromSeconds } from "@ohmail/cal-core";
import type { CalendarProvider, Connection } from "@ohmail/cal-providers";
import { owaInvitationItemId } from "@trafficflow/core/ics";
import type { Logger } from "@trafficflow/core";
import { and, desc, eq, gte, isNull, lte, notExists, notInArray, or, sql } from "drizzle-orm";
import {
  messageBodies,
  messageInvitations,
  messages,
  recordChanges,
  recordInvitationAnswer,
  writeInvitation,
  type InvitationWrite,
  type LedgerTx,
} from "@trafficflow/db";
import { inConnection, type ConnectionDb, type ConnectionKey } from "./connection.js";
import { remember } from "./memory.js";
import type { CalendarSyncMemory } from "./types.js";

/** How far back a letter is looked at: an invitation older than this has had its moment. */
export const EXCHANGE_INVITATION_DAYS = 30;
/** Letters read from the store per turn, newest first. */
export const EXCHANGE_CANDIDATES = 20;
/** Letters looked up at Microsoft per turn. */
export const EXCHANGE_LOOKUPS_PER_TURN = 3;
/** Turns a letter's lookup may fail in before this process stops asking about it. */
export const EXCHANGE_LOOKUP_TRIES = 3;
/** The least time between two looks of one connection at its letters. */
export const EXCHANGE_SCAN_EVERY_MS = 10 * 60_000;
/** Letters looked at for good that the store is asked to leave out, newest first. */
const EXCHANGE_SETTLED_LEFT_OUT = 500;
/** How much of a letter's text is read for its link: the item id reader's own reach. */
const HEAD_CHARS = 8192;
const DAY_MS = 86_400_000;

export interface ExchangeInvitationInput {
  readonly db: ConnectionDb;
  readonly key: ConnectionKey;
  readonly provider: CalendarProvider;
  readonly connection: Connection;
  readonly memory: CalendarSyncMemory;
  readonly zones: ZoneSource;
  readonly now: () => number;
  readonly signal: AbortSignal;
  readonly log: Logger;
}

const two = (n: number): string => String(n).padStart(2, "0");
const wallText = (w: Wall): string =>
  `${String(w.year).padStart(4, "0")}${two(w.month)}${two(w.day)}T${two(w.hour)}${two(w.minute)}${two(w.second)}`;

/** The start as an invitation row keeps it: as written (a date, a clock time, a clock time in UTC), and its moment where one can be told. */
export function startOf(
  t: EventTime,
  zones: ZoneSource,
): { readonly startRaw: string; readonly startsAt: Date | null } {
  switch (t.kind) {
    case "date":
      return { startRaw: `${String(t.year).padStart(4, "0")}${two(t.month)}${two(t.day)}`, startsAt: null };
    case "instant":
      return {
        startRaw: `${wallText(wallFromSeconds(Math.floor(t.epochMs / 1000)))}Z`,
        startsAt: new Date(t.epochMs),
      };
    case "zoned": {
      const at = instantOf(t, zones);
      return { startRaw: wallText(t.wall), startsAt: at === null ? null : new Date(at.epochMs) };
    }
    case "floating":
      return { startRaw: wallText(t.wall), startsAt: null };
  }
}

/** The letter's invitation row as the event makes it: a request, or a cancellation for a cancelled event. `null` for an event the row cannot name. */
export function invitationOf(
  accountId: string,
  messageId: string,
  event: CalEvent,
  zones: ZoneSource,
): InvitationWrite | null {
  if (event.uid === null || event.start === null || event.recurrenceId !== null) return null;
  const organizer = event.organizer?.email ?? null;
  return {
    accountId,
    messageId,
    method: event.status === "CANCELLED" ? "CANCEL" : "REQUEST",
    uid: event.uid,
    recurrenceId: "",
    sequence: event.sequence ?? 0,
    ...startOf(event.start, zones),
    organizer,
    attendees: event.attendees.flatMap((a) => (a.email === null ? [] : [a.email])),
    stampedAt: null,
    reply: null,
    own: false,
  };
}

/** The memory's key of one letter for one connection: another connection of the account may hold its event. */
const lookupKey = (key: ConnectionKey, messageId: string): string => `${key.id}:${messageId}`;
/** A letter looked at for good by this connection: never asked about again in this process. */
const settle = (memory: CalendarSyncMemory, at: string): void =>
  remember(memory.exchangeLookups, at, EXCHANGE_LOOKUP_TRIES);
const failedOnce = (memory: CalendarSyncMemory, at: string): void =>
  remember(memory.exchangeLookups, at, (memory.exchangeLookups.get(at) ?? 0) + 1);

/** The letters this connection looked at for good, newest last, at most {@link EXCHANGE_SETTLED_LEFT_OUT}: the store leaves them out. */
function settledLetters(memory: CalendarSyncMemory, key: ConnectionKey): string[] {
  const prefix = `${key.id}:`;
  const ids: string[] = [];
  for (const [at, tries] of memory.exchangeLookups) {
    if (tries >= EXCHANGE_LOOKUP_TRIES && at.startsWith(prefix)) ids.push(at.slice(prefix.length));
  }
  return ids.slice(-EXCHANGE_SETTLED_LEFT_OUT);
}

/**
 * One turn's share of the work, at most once every {@link EXCHANGE_SCAN_EVERY_MS} for a connection.
 * Never throws for a provider's answer; a fault of the store is thrown to the caller, which keeps it
 * out of the turn's outcome. Answers the letters given a row.
 */
export async function exchangeInvitationPass(input: ExchangeInvitationInput): Promise<number> {
  const lookup = input.provider.invitations;
  if (lookup === undefined) return 0;
  const { db, key, memory } = input;
  const nowMs = input.now();
  const scanned = memory.exchangeScannedAt.get(key.id);
  if (scanned !== undefined && nowMs - scanned < EXCHANGE_SCAN_EVERY_MS) return 0;
  remember(memory.exchangeScannedAt, key.id, nowMs);
  const settled = settledLetters(memory, key);
  const head = sql`lower(substr(${messageBodies.text}, 1, ${sql.raw(String(HEAD_CHARS))}))`;
  const found = await inConnection(db, key, async ({ tx, held }) =>
    tx
      .select({
        id: messages.id,
        head: sql<string>`substr(${messageBodies.text}, 1, ${sql.raw(String(HEAD_CHARS))})`,
      })
      .from(messages)
      .innerJoin(
        messageBodies,
        and(eq(messageBodies.messageId, messages.id), eq(messageBodies.accountId, messages.accountId)),
      )
      .where(
        and(
          eq(messages.accountId, key.accountId),
          held.mailboxId === null ? undefined : eq(messages.mailboxId, held.mailboxId),
          isNull(messages.deletedAt),
          // A letter's date is its sender's word: one dated ahead never holds a place.
          gte(messages.date, new Date(nowMs - EXCHANGE_INVITATION_DAYS * DAY_MS)),
          lte(messages.date, new Date(nowMs + DAY_MS)),
          isNull(messageBodies.withheldReason),
          // The two forms of a calendar item link the reader takes, written plainly or percent-encoded.
          or(sql`${head} like '%calendar/item%'`, sql`${head} like '%calendar%2fitem%'`),
          settled.length === 0 ? undefined : notInArray(messages.id, settled),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(messageInvitations)
              .where(
                and(
                  eq(messageInvitations.accountId, messages.accountId),
                  eq(messageInvitations.messageId, messages.id),
                ),
              ),
          ),
        ),
      )
      .orderBy(desc(messages.date))
      .limit(EXCHANGE_CANDIDATES),
  );
  if (found === "gone") return 0;

  let asked = 0;
  let written = 0;
  for (const letter of found) {
    if (asked >= EXCHANGE_LOOKUPS_PER_TURN || input.signal.aborted) break;
    const at = lookupKey(key, letter.id);
    if ((memory.exchangeLookups.get(at) ?? 0) >= EXCHANGE_LOOKUP_TRIES) continue;
    const itemId = owaInvitationItemId(letter.head);
    if (itemId === null) {
      settle(memory, at);
      continue;
    }
    asked += 1;
    const answer = await lookup.eventOfItem(input.connection, itemId, input.signal);
    if (!answer.ok) {
      if (answer.reason === "not_found") settle(memory, at);
      else failedOnce(memory, at);
      // Graph asked to be left alone, or the sign-in no longer opens: nothing more is asked this turn.
      if (
        answer.reason === "throttled" ||
        answer.reason === "sign_in_refused" ||
        answer.reason === "consent_needed"
      )
        break;
      continue;
    }
    const row =
      answer.value === null ? null : invitationOf(key.accountId, letter.id, answer.value.event, input.zones);
    if (row === null) {
      settle(memory, at);
      continue;
    }
    const mine = answer.value!.answer;
    let done: boolean | "gone";
    try {
      done = await inConnection(db, key, async ({ tx }) => {
        const made = await writeInvitation(tx, row);
        if (!made.written) return false;
        const touched =
          mine === null || row.method !== "REQUEST"
            ? []
            : await recordInvitationAnswer(tx, {
                accountId: key.accountId,
                mailboxId: (await mailboxOf(tx, key.accountId, letter.id))!,
                uid: row.uid,
                recurrenceId: row.recurrenceId,
                sequence: row.sequence,
                organizer: row.organizer,
                answer: mine,
                at: new Date(input.now()),
              });
        const changed = [letter.id, ...made.touched, ...touched].filter(
          (id, i, all) => all.indexOf(id) === i,
        );
        await recordChanges(
          tx as LedgerTx,
          changed.map((id) => ({
            accountId: key.accountId,
            entityType: "message" as const,
            entityId: id,
            op: "update" as const,
            meta: null,
          })),
        );
        return true;
      });
    } catch (err) {
      // The store refused the write: the letter is asked about again later, a few times at most.
      failedOnce(memory, at);
      throw err;
    }
    settle(memory, at);
    if (done === true) written += 1;
  }
  if (written > 0)
    input.log.info("calendar_exchange_invitations", { accountId: key.accountId, count: written });
  return written;
}

async function mailboxOf(
  tx: Parameters<typeof writeInvitation>[0],
  accountId: string,
  messageId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ mailboxId: messageInvitations.mailboxId })
    .from(messageInvitations)
    .where(and(eq(messageInvitations.accountId, accountId), eq(messageInvitations.messageId, messageId)))
    .limit(1);
  return row?.mailboxId ?? null;
}
