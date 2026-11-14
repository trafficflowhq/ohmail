/**
 * WHAT HANGS ON A CALENDAR RECORD LEAVES WITH IT: a connection's delete takes its calendars and
 * their events, a calendar's delete its events. A second net only — the server deletes every
 * record it removes, children first — kept so that a page applied out of order never leaves an
 * event standing under a calendar the device no longer has. The same seq guard as the mailbox's
 * cascade: a record written after the delete stays.
 */
import type { CalendarEventRecord, CalendarRecord } from "@ohmail/wire";
import { recordKey, type MirrorRecord } from "./apply.js";

export function cascadeCalendarRemoval(
  records: ReadonlyMap<string, MirrorRecord>, applied: readonly MirrorRecord[],
  tombstone: (rec: MirrorRecord, seq: number) => void,
): void {
  const connections = new Map<string, number>();
  const calendars = new Map<string, number>();
  for (const r of applied) {
    if (r.entity !== null) continue;
    if (r.type === "calendar_connection") connections.set(r.id, r.seq);
    if (r.type === "calendar") calendars.set(r.id, r.seq);
  }
  if (connections.size === 0 && calendars.size === 0) return;
  const take = (type: string, via: string, owners: ReadonlyMap<string, number>, then?: Map<string, number>): void => {
    if (owners.size === 0) return;
    for (const rec of [...records.values()]) {
      if (rec.type !== type || rec.entity === null) continue;
      const owner = (rec.entity as Record<string, unknown>)[via];
      if (typeof owner !== "string") continue;
      const seq = owners.get(owner);
      if (seq === undefined || rec.seq > seq) continue;
      tombstone(rec, seq);
      then?.set(rec.id, seq);
    }
  };
  take("calendar", "connectionId", connections, calendars);
  take("calendar_event", "calendarId", calendars);
}

/** A synced access change can arrive without fresh event rows. Erase cached detail in the same flush. */
export function forgetBusyCalendarDetails(
  records: Map<string, MirrorRecord>, applied: readonly MirrorRecord[] | null,
): MirrorRecord[] {
  const calendarRows = applied === null ? records.values() : applied;
  let busy = false;
  const changedEvents: MirrorRecord[] = [];
  for (const row of calendarRows) {
    if (row.type === "calendar" && (row.entity as CalendarRecord | null)?.access === "busy") busy = true;
    if (applied !== null && row.type === "calendar_event") changedEvents.push(row);
  }
  const candidates = busy ? records.values() : changedEvents;
  const dirty: MirrorRecord[] = [];
  for (const row of candidates) {
    if (row.type !== "calendar_event") continue;
    const key = recordKey(row.type, row.id);
    if (records.get(key) !== row) continue;
    const event = row.entity as CalendarEventRecord | null;
    if (event === null) continue;
    const calendar = records.get(recordKey("calendar", event.calendarId))?.entity as CalendarRecord | null | undefined;
    if (calendar?.access !== "busy") continue;
    const { personalSeries, deleteMembers, deleteScopes, ...retained } = event;
    if (event.title === "" && event.notes === null && event.place === null && event.callLink === null &&
        event.organizer === null && event.myAnswer === null && !event.invitees?.length && !event.alarms?.length &&
        !event.writes?.length && personalSeries === undefined && deleteMembers === undefined && deleteScopes === undefined) continue;
    const next = {
      ...row,
      entity: {
        ...retained, title: "", notes: null, place: null, callLink: null, organizer: null, myAnswer: null,
        invitees: [], alarms: [], writes: [],
      } satisfies CalendarEventRecord,
    };
    records.set(key, next);
    dirty.push(next);
  }
  return dirty;
}
