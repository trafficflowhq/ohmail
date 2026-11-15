/**
 * WHAT HANGS ON A CALENDAR RECORD LEAVES WITH IT: a connection's delete takes its calendars and
 * their events, a calendar's delete its events. A second net only — the server deletes every
 * record it removes, children first — kept so that a page applied out of order never leaves an
 * event standing under a calendar the device no longer has. The same seq guard as the mailbox's
 * cascade: a record written after the delete stays.
 */
import type { MirrorRecord } from "./apply.js";

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
