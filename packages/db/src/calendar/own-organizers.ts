import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { CALENDAR_CHANGES_PER_TRANSACTION, recordCalendarChanges, type CalendarChange, type LedgerTx, type Tx } from "../change-log.js";
import { calCalendars, calEvents } from "../schema-mail.js";
import { readOwnAddresses } from "../own-mail.js";

/**
 * WHOSE AN EVENT IS: the addresses an event of the account's own is organized under, in lower
 * case. They are the account's mailboxes by the one own set (`readOwnAddresses`: a mailbox erased or
 * removed is no mailbox of the account's any more) and the calendar connection's principal where
 * that is an address (Google's and Microsoft's sign-in name the account by its address there). The
 * write door and the drain ask `writeActRefusal` with this one set, so they take an event for the
 * account's own alike. CalDAV also supplies the signed-in principal's scheduling addresses.
 */
export async function ownOrganizerAddresses(
  tx: Tx, accountId: string, principal: string | null, discovered: readonly string[] | null = null,
): Promise<Set<string>> {
  const own = await readOwnAddresses(tx, accountId);
  const address = organizerPrincipalAddress(principal);
  if (address) own.add(address);
  for (const address of discovered ?? []) own.add(address);
  return own;
}

export function organizerPrincipalAddress(principal: string | null): string | null {
  const address = principal?.trim().toLowerCase().replace(/^mailto:/, "") ?? "";
  return address.includes("@") && !address.includes("/") ? address : null;
}

/** An empty discovery explicitly failed to identify the OAuth mailbox. Null is undiscovered. */
export function oauthIdentityAmbiguous(provider: string, addresses: readonly string[] | null | undefined): boolean {
  return (provider === "google" || provider === "microsoft") && addresses?.length === 0;
}

/** CalDAV stores a resource's original once, on its master. A changed day shares that exact version. */
export function calendarOriginalOf() {
  return sql<string | null>`coalesce(${calEvents.original}, case when ${calEvents.recurrenceId} <> '' then (
    select master.original from cal_events as master
    where master.account_id = "cal_events"."account_id" and master.calendar_id = "cal_events"."calendar_id"
      and master.uid = "cal_events"."uid" and master.provider_id = "cal_events"."provider_id"
      and master.version_tag = "cal_events"."version_tag" and master.recurrence_id = ''
    limit 1
  ) end)`;
}

/** Publish the changed event ownership and calendar invitation capabilities under the connection lock. */
export async function publishCalendarOrganizerChanges(
  tx: Tx, accountId: string, connectionId: string, before: readonly string[], after: readonly string[],
  includeAttendeeCopies = false,
) {
  const changed = [...before.filter((address) => !after.includes(address)), ...after.filter((address) => !before.includes(address))];
  if (!changed.length && !includeAttendeeCopies) return;
  const events = await tx.select({ id: calEvents.id }).from(calEvents)
    .innerJoin(calCalendars, and(eq(calCalendars.id, calEvents.calendarId), eq(calCalendars.accountId, accountId)))
    .where(and(eq(calEvents.accountId, accountId), eq(calCalendars.connectionId, connectionId),
      or(inArray(sql`lower(trim(${calEvents.organizer}))`, changed),
        includeAttendeeCopies ? isNotNull(calEvents.myAnswer) : undefined)));
  const changes: CalendarChange[] = events.map(({ id }) => ({ kind: "calendar_event", id, op: "update" }));
  if ((before.length === 0) !== (after.length === 0)) {
    const calendars = await tx.select({ id: calCalendars.id }).from(calCalendars).where(and(
      eq(calCalendars.accountId, accountId), eq(calCalendars.connectionId, connectionId), eq(calCalendars.autoSchedule, true),
    ));
    for (const { id } of calendars) changes.push({ kind: "calendar", id, op: "update" });
  }
  for (let at = 0; at < changes.length; at += CALENDAR_CHANGES_PER_TRANSACTION) {
    await recordCalendarChanges(tx as unknown as LedgerTx, accountId, changes.slice(at, at + CALENDAR_CHANGES_PER_TRANSACTION));
  }
}

/** Resolve the attendee of a connection. A different mailbox of the same account is a different copy. */
export function connectedAttendee(
  people: readonly string[],
  principal: string | null | undefined,
  own: ReadonlySet<string>,
): string | null {
  const named = principal?.trim().toLowerCase().replace(/^mailto:/, "") ?? "";
  const hasAddress = named.includes("@") && !named.includes("/");
  const matching = people.map((address) => address.trim().toLowerCase())
    .filter((address) => hasAddress ? address === named : own.has(address));
  return matching.length === 1 ? matching[0]! : null;
}
