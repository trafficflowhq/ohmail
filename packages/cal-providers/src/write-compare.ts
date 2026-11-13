/**
 * DOES THE PROVIDER'S OBJECT ALREADY HOLD A CHANGE? Asked once, when a change was refused for its
 * version (412): an earlier attempt of the same write may have landed and its answer been lost. A
 * change every field of which the object holds is done; anything else is a version the change was
 * not made on, and nothing is sent again. Where a field cannot be told from the object as read, the
 * answer is no: a write is refused before it is ever sent twice over another's change.
 */
import { formatRRule, momentOrUtc, type CalEvent, type EventTime, type ZoneSource } from "@ohmail/cal-core";
import type { EventChange } from "./port.js";

const blank = (v: string | null | undefined): string | null =>
  v === undefined || v === null || v === "" ? null : v;

/** The same time: one day for a day, one moment for a time. */
function sameTime(a: EventTime | null, b: EventTime, zones: ZoneSource): boolean {
  if (a === null) return false;
  if (a.kind === "date" || b.kind === "date") {
    return (
      a.kind === "date" && b.kind === "date" && a.year === b.year && a.month === b.month && a.day === b.day
    );
  }
  return momentOrUtc(a, zones) === momentOrUtc(b, zones);
}

/** The minutes before the start each of the event's reminders rings at, where every one of them says so. */
function alarmMinutes(event: CalEvent): number[] | null {
  const out: number[] = [];
  for (const a of event.alarms) {
    const t = a.trigger;
    if (t === null || t.kind !== "relative" || t.to !== "START") return null;
    const d = t.duration;
    const minutes =
      (d.weeks ?? 0) * 7 * 24 * 60 + (d.days ?? 0) * 24 * 60 + (d.hours ?? 0) * 60 + (d.minutes ?? 0);
    out.push(d.negative ? minutes : -minutes);
  }
  return out.sort((x, y) => x - y);
}

/** Every field the change names, as the object holds it. */
export function alreadyHolds(change: EventChange, event: CalEvent, zones: ZoneSource): boolean {
  if (change.summary !== undefined && blank(event.summary) !== blank(change.summary)) return false;
  if (change.description !== undefined && blank(event.description) !== blank(change.description))
    return false;
  if (change.location !== undefined && blank(event.location) !== blank(change.location)) return false;
  if (change.url !== undefined && blank(event.url) !== blank(change.url)) return false;
  if (change.start !== undefined && !sameTime(event.start, change.start, zones)) return false;
  if (change.end !== undefined && !sameTime(event.end, change.end, zones)) return false;
  if (change.busy !== undefined && (event.transparency !== "TRANSPARENT") !== change.busy) return false;
  if (
    change.private !== undefined &&
    (event.classification === "PRIVATE" || event.classification === "CONFIDENTIAL") !== change.private
  )
    return false;
  if (change.rule !== undefined) {
    const held =
      event.rules.length === 0
        ? null
        : event.rules.length === 1 && event.rules[0]!.rule !== null
          ? formatRRule(event.rules[0]!.rule)
          : undefined;
    if (held === undefined || held !== (change.rule === null ? null : formatRRule(change.rule))) return false;
  }
  if (change.attendees !== undefined) {
    const held = new Map(
      event.attendees.flatMap((a) =>
        a.email === null ? [] : [[a.email, a.role === "OPT-PARTICIPANT"] as const],
      ),
    );
    if (held.size !== change.attendees.length) return false;
    for (const p of change.attendees) if (held.get(p.email.toLowerCase()) !== p.optional) return false;
  }
  if (change.alarms !== undefined) {
    const held = alarmMinutes(event);
    if (held === null || JSON.stringify(held) !== JSON.stringify([...change.alarms].sort((x, y) => x - y)))
      return false;
  }
  return true;
}
