/**
 * Zone definitions in calendar text (RFC 5545 section 3.6.5): read from a file into the shape
 * `fileZones` takes, and written for a new event from the zone rules handed in.
 *
 * A definition that was read is never written again from this shape: it stays in the tree as it
 * came (a server may replace it with its own anyway). A definition is written only for an event
 * this side makes, because the standard demands one "for each unique TZID parameter value".
 */
import { MAX_ZONE_NAME_CHARS, MAX_ZONE_ONSETS, VTIMEZONE_SPAN_MAX_DAYS } from "../limits.js";
import { parseRRule } from "../recur/rrule.js";
import { MS_PER_DAY, MS_PER_SECOND, wallFromSeconds } from "../time/arith.js";
import type { Wall, ZoneSource } from "../time/types.js";
import type { Observance, ZoneDefinition } from "../time/zones.js";
import { componentsOf, propertiesOf, propertyOf, type Component, type Property } from "./component.js";
import { sameName } from "./lines.js";
import { formatUtcOffset, formatWall, parseDateTime, parsePeriod, parseUtcOffset, unescapeText } from "./values.js";

/** How many values a comma-separated list holds, counted on the text. */
function listLength(value: string): number {
  let count = 1;
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 0x2c) count++;
  return count;
}

/** One STANDARD or DAYLIGHT block; `null` without its three required lines; `"too_many"` when it lists more dates than `room` is left for. */
function observanceOf(c: Component, room: number): Observance | null | "too_many" {
  const start = parseDateTime(propertyOf(c, "DTSTART")?.value.trim() ?? "");
  const from = parseUtcOffset(propertyOf(c, "TZOFFSETFROM")?.value ?? "");
  const to = parseUtcOffset(propertyOf(c, "TZOFFSETTO")?.value ?? "");
  if (start === null || from === null || to === null) return null;
  const rule = propertyOf(c, "RRULE");
  const lists = propertiesOf(c, "RDATE");
  // Counted on the text, before a list is cut into its dates.
  if (lists.reduce((sum, p) => sum + listLength(p.value), 0) > room) return "too_many";
  const extra: Wall[] = lists.flatMap((p) =>
    p.value.split(",").flatMap((v) => {
      const reading = parseDateTime(v.trim()) ?? parsePeriod(v.trim())?.start ?? null;
      return reading === null ? [] : [reading.wall];
    }),
  );
  const name = propertyOf(c, "TZNAME");
  return { start: start.wall, offsetFrom: from, offsetTo: to, rule: rule === null ? null : parseRRule(rule.value), extra, daylight: sameName(c.name, "DAYLIGHT"), name: name === null ? null : unescapeText(name.value) };
}

/**
 * A VTIMEZONE component as a zone definition; `null` when it names no zone or names one with more
 * characters than a zone's name may have, and when it holds more onsets (its blocks' starts and the
 * dates they list) than a definition may: past `MAX_ZONE_ONSETS` it is no definition, and the zone
 * is one this file does not define. Blocks without their three required lines are left out.
 */
export function zoneDefinitionOf(c: Component): ZoneDefinition | null {
  const tzid = propertyOf(c, "TZID")?.value.trim() ?? "";
  if (tzid === "" || tzid.length > MAX_ZONE_NAME_CHARS) return null;
  const observances: Observance[] = [];
  let onsets = 0;
  for (const k of c.components) {
    if (!sameName(k.name, "STANDARD") && !sameName(k.name, "DAYLIGHT")) continue;
    const block = observanceOf(k, MAX_ZONE_ONSETS - onsets - 1);
    if (block === "too_many") return null;
    if (block === null) continue;
    onsets += 1 + block.extra.length;
    if (onsets > MAX_ZONE_ONSETS) return null;
    observances.push(block);
  }
  return { tzid, observances };
}

/** Every zone a calendar component defines. */
export const zoneDefinitionsOf = (calendar: Component): ZoneDefinition[] => componentsOf(calendar, "VTIMEZONE").flatMap((c) => zoneDefinitionOf(c) ?? []);

/** A day either side of the span asked: an event's own length and a viewer's zone never reach further. */
const MARGIN_MS = MS_PER_DAY;

const line = (name: string, value: string): Property => ({ name, params: [], value });

/**
 * A VTIMEZONE for `tzid`, good for the span given and for nothing after it: one block for the
 * offset in force when the span begins and one for every change the source reports inside it, each
 * with its explicit onset and no rule. The definition holds its last offset for ever, so the span
 * must cover the whole series it is written for, from the first occurrence to the end of the last:
 * a definition written for the first occurrence alone tells a reader that has no zone data of its
 * own that the clocks never change again. The span is cut at {@link VTIMEZONE_SPAN_MAX_DAYS}; a
 * series with no end gets a definition for that long. `null` when the source does not know the zone.
 */
export function vtimezoneFrom(tzid: string, zones: ZoneSource, span: { readonly startMs: number; readonly endMs: number }): Component | null {
  const from = Math.floor(span.startMs / MS_PER_DAY) * MS_PER_DAY - MARGIN_MS;
  const until = Math.min(Math.max(span.endMs, span.startMs), span.startMs + VTIMEZONE_SPAN_MAX_DAYS * MS_PER_DAY) + MARGIN_MS;
  let offset = zones.offsetAt(tzid, from);
  if (offset === null) return null;
  const local = (ms: number, by: number): string => formatWall(wallFromSeconds(Math.floor((ms + by) / MS_PER_SECOND)));
  const block = (daylight: boolean, onsetMs: number, before: number, after: number): Component => ({
    name: daylight ? "DAYLIGHT" : "STANDARD",
    properties: [line("DTSTART", local(onsetMs, before)), line("TZOFFSETFROM", formatUtcOffset(before / MS_PER_SECOND)), line("TZOFFSETTO", formatUtcOffset(after / MS_PER_SECOND))],
    components: [],
  });
  const blocks: Component[] = [block(false, from, offset, offset)];
  for (let day = from; day < until; day += MS_PER_DAY) {
    const next = zones.offsetAt(tzid, day + MS_PER_DAY);
    if (next === null) return null;
    if (next === offset) continue;
    // The change lies in this day: halve down to the first second that has the new offset.
    let lo = day;
    let hi = day + MS_PER_DAY;
    while (hi - lo > MS_PER_SECOND) {
      const mid = lo + Math.floor((hi - lo) / 2 / MS_PER_SECOND) * MS_PER_SECOND;
      if (zones.offsetAt(tzid, mid) === offset) lo = mid;
      else hi = mid;
    }
    blocks.push(block(next > offset, hi, offset, next));
    offset = next;
  }
  return { name: "VTIMEZONE", properties: [line("TZID", tzid)], components: blocks };
}
