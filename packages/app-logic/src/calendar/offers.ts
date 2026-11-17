/**
 * WHAT MAY BE PRESSED on an event, by its calendar and the calendar's connection: one table, read by every view and
 * the card, so a calendar that can only be looked at is never offered a change anywhere.
 */
import type { CalendarConnectionRecord, CalendarRecord } from "@ohmail/wire";

/** A calendar that can be looked at here and not changed: shared to look at, busy times only, a subscription, a connection that waits. */
export function viewOnlyOf(
  calendar: CalendarRecord,
  connection: CalendarConnectionRecord | undefined,
): boolean {
  if (calendar.access === "reader" || calendar.access === "busy") return true;
  if (connection === undefined) return true;
  return connection.provider === "ics" || connection.status !== "active";
}

/**
 * A calendar's colour as a hue on the ring (0 to 359), `neutral` where it has none or one that is no `#rrggbb`. The
 * kit mixes what is drawn from the tokens; this only says where on the ring the calendar stands.
 */
export function hueOf(color: string | null): number | "neutral" {
  const m = color === null ? null : /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return "neutral";
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((h) => parseInt(h, 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return "neutral";
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round((((h * 60) % 360) + 360) % 360);
}
