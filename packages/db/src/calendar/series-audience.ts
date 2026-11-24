import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { calAttendees, calEvents } from "../schema-mail.js";
import type { Tx } from "../change-log.js";
import { CALENDAR_WRITE_LIMITS } from "./write-act.js";

export interface SeriesCancellation {
  readonly overrides: readonly { readonly id: string; readonly version: string }[];
  readonly message: string;
}

/** Read every stored changed occurrence, including those outside the served window. */
export async function changedSeriesAudience(
  db: Pick<Tx, "select">, accountId: string, master: { calendarId: string; uid: string },
) {
  const rows = await db.select({
    id: calEvents.id, providerId: calEvents.providerId, version: calEvents.versionTag,
    at: calEvents.recurrenceId, range: calEvents.thisAndFuture, partial: calEvents.partial,
    organizer: calEvents.organizer,
  }).from(calEvents).where(and(
    eq(calEvents.accountId, accountId), eq(calEvents.calendarId, master.calendarId), eq(calEvents.uid, master.uid),
    ne(calEvents.recurrenceId, ""), ne(calEvents.status, "cancelled"),
  )).orderBy(asc(calEvents.providerId)).limit(CALENDAR_WRITE_LIMITS.invitees + 1);
  if (rows.length > CALENDAR_WRITE_LIMITS.invitees ||
      new Set(rows.map((row) => row.providerId)).size !== rows.length ||
      rows.some((row) => row.partial || row.range || !row.version || !/^-?\d+$/.test(row.at) || !Number.isSafeInteger(Number(row.at))))
    return null;
  const people = rows.length ? await db.select({
    id: calAttendees.eventId, address: calAttendees.address, name: calAttendees.name,
  }).from(calAttendees).where(and(eq(calAttendees.accountId, accountId), inArray(calAttendees.eventId, rows.map((row) => row.id)))) : [];
  const byEvent = new Map<string, { address: string; name: string | null }[]>();
  for (const { id, name, address } of people) {
    const guest = { address: address.trim().toLowerCase(), name };
    const held = byEvent.get(id);
    if (held) held.push(guest);
    else byEvent.set(id, [guest]);
  }
  return {
    overrides: rows.map(({ providerId, version }) => ({ id: providerId, version: version! })),
    members: rows.map((row) => ({
      at: Number(row.at), range: false, organizer: row.organizer?.trim().toLowerCase() ?? null,
      guests: byEvent.get(row.id) ?? [],
    })),
  };
}
