import type { CalendarEventRecord } from "@ohmail/app-logic/calendar";
import type { CalendarAct, CalendarChangeScope, CalendarEventFields } from "@ohmail/wire";

function guestsOf(record: CalendarEventRecord) {
  const normalized = (address: string) => address.trim().toLowerCase();
  const organizer = normalized(record.organizer?.address ?? "");
  const guests = new Map<string, string>();
  for (const invitee of record.invitees) {
    const address = normalized(invitee.address);
    if (address && address !== organizer) guests.set(address, invitee.name?.trim() || invitee.address);
  }
  return {
    names: [...guests.values()],
    addresses: [...guests.keys()].sort(),
    organizer: organizer || null,
  };
}

export interface GuestUpdate {
  readonly names: readonly string[];
  readonly audience: { readonly organizer: string | null; readonly guests: readonly string[] };
  readonly proposal: string;
}

export function guestUpdate(record: CalendarEventRecord, change: Partial<CalendarEventFields>) {
  const guests = guestsOf(record);
  return {
    names: guests.names,
    audience: { organizer: guests.organizer, guests: guests.addresses },
    proposal: JSON.stringify(change),
  };
}

export function eventUpdate(
  record: CalendarEventRecord,
  base: string,
  change: Partial<CalendarEventFields>,
  scope: CalendarChangeScope,
): CalendarAct {
  return {
    kind: "calendar_event_update",
    scope,
    eventId: record.id,
    base,
    change,
    ...(record.repeat ? { personalSeries: true } : { audience: guestUpdate(record, change).audience }),
  };
}
