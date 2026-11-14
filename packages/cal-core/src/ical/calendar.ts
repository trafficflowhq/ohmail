/**
 * A calendar object read and written. Reading gives the tree and, over it, what this package has
 * words for: the header lines, the zones the file defines, the events. Writing gives the tree back
 * as text. What was read and not touched comes out as it went in, line for line; only fold positions
 * and line ends are this writer's own.
 */
import type { Limits } from "../limits.js";
import type { Duration } from "../time/duration.js";
import type { ZoneSource } from "../time/types.js";
import { fileZones, firstOf, type ZoneDefinition } from "../time/zones.js";
import { MAX_ZONE_NAME_CHARS } from "../limits.js";
import { componentsOf, parseComponents, propertyOf, withComponent, writeComponent, type Component, type DroppedComponent, type Property, type ReadRefusal, type Written } from "./component.js";
import { eventOf, type CalEvent } from "./event.js";
import { sameName } from "./lines.js";
import { parseDuration, unescapeText } from "./values.js";
import { zoneDefinitionsOf } from "./vtimezone.js";

export interface CalObject {
  /** The VCALENDAR component, whole. */
  readonly tree: Component;
  readonly prodid: string | null;
  readonly version: string | null;
  /** METHOD in upper case, as written: `itip/methods` knows which words are methods. */
  readonly method: string | null;
  /** The zones the file defines. Their components stay in the tree and are written back untouched. */
  readonly timezones: readonly ZoneDefinition[];
  /** Every VEVENT, in the order written: a series and its changed days are several of them with one UID (`seriesOf`). */
  readonly events: readonly CalEvent[];
  /** Components that are neither events nor zone definitions (tasks, journals, free-busy, anything unknown). */
  readonly other: readonly Component[];
}

export type CalendarRefusal = ReadRefusal | "several_calendars";
/**
 * `dropped`: the components the reader left out for a string longer than its kind may be
 * (`parseComponents`), in the order written; empty when the calendar is whole. A calendar read with
 * something left out is one to show: written back, it would take the place of a text that held more.
 */
export type ReadCalendar = { readonly ok: true; readonly calendar: CalObject; readonly dropped: readonly DroppedComponent[] } | { readonly ok: false; readonly reason: CalendarRefusal };
export type ReadCalendars = { readonly ok: true; readonly calendars: readonly CalObject[]; readonly dropped: readonly DroppedComponent[] } | { readonly ok: false; readonly reason: ReadRefusal };

/** The typed view over a VCALENDAR component. */
export function calendarOf(tree: Component): CalObject {
  const value = (name: string): string | null => {
    const p = propertyOf(tree, name);
    return p === null ? null : unescapeText(p.value).trim();
  };
  return {
    tree,
    prodid: value("PRODID"),
    version: value("VERSION"),
    method: value("METHOD")?.toUpperCase() ?? null,
    timezones: zoneDefinitionsOf(tree),
    events: componentsOf(tree, "VEVENT").map(eventOf),
    other: tree.components.filter((c) => !sameName(c.name, "VEVENT") && !sameName(c.name, "VTIMEZONE")),
  };
}

/** Every calendar object a text holds (a stream may hold several). Refuses by word, never by throwing. */
export function readCalendars(text: string, limits: Limits): ReadCalendars {
  const parsed = parseComponents(text, limits);
  if (!parsed.ok) return parsed;
  const calendars = parsed.components.filter((c) => sameName(c.name, "VCALENDAR")).map(calendarOf);
  return calendars.length === 0 ? { ok: false, reason: "not_a_calendar" } : { ok: true, calendars, dropped: parsed.dropped };
}

/** The one calendar object a text holds. A text holding several is refused by word, so that none is dropped unseen: read it with {@link readCalendars}. */
export function readCalendar(text: string, limits: Limits): ReadCalendar {
  const read = readCalendars(text, limits);
  if (!read.ok) return read;
  return read.calendars.length === 1 ? { ok: true, calendar: read.calendars[0]!, dropped: read.dropped } : { ok: false, reason: "several_calendars" };
}

/** The calendar as text: CRLF line ends, lines folded at 75 octets. Refused by word when a line of it holds a control character (`writeComponent`). */
export const writeCalendar = (calendar: CalObject): Written => writeComponent(calendar.tree);

/**
 * The zone rules a calendar is read with: the platform's for every name the platform knows (a
 * vendor's prefix taken off, a Windows name turned into its own), and the file's own definition
 * only for a name the platform does not know.
 *
 * A definition in a file is as old as the file. A zone's law changes (Mexico ended summer time in
 * 2022) and a stored series outlives it; a definition written for one event's span says nothing
 * true about the years after. The platform's rules are kept current with the device, a file's
 * with nothing. `firstOf` still gives the other order to a caller that means it.
 */
export const zonesOf = (calendar: CalObject, platform: ZoneSource): ZoneSource => firstOf(platform, fileZones(calendar.timezones));

/** The calendar with one of its events (this very one) replaced by an edited one or, with `null`, taken out. */
export function withEvent(calendar: CalObject, old: CalEvent, next: CalEvent | null): CalObject {
  return calendarOf(withComponent(calendar.tree, old.component, next === null ? null : next.component));
}

/** The calendar with one more event, written after the last one it has (a changed occurrence beside its series). */
export function withNewEvent(calendar: CalObject, event: CalEvent): CalObject {
  const tree = calendar.tree;
  let at = tree.components.length;
  while (at > 0 && !sameName(tree.components[at - 1]!.name, "VEVENT")) at--;
  if (at === 0) at = tree.components.length;
  // A property written after later components stays after them.
  const properties = tree.properties.map((p) => (p.afterComponents !== undefined && p.afterComponents > at ? { ...p, afterComponents: p.afterComponents + 1 } : p));
  return calendarOf({ ...tree, properties, components: [...tree.components.slice(0, at), event.component, ...tree.components.slice(at)] });
}

/** A calendar object written new: the header lines, then the zone definitions, then the events. */
export function newCalendar(parts: { readonly prodid: string; readonly method?: string; readonly timezones?: readonly Component[]; readonly events: readonly Component[] }): CalObject {
  const line = (name: string, value: string): Property => ({ name, params: [], value });
  const properties = [line("VERSION", "2.0"), line("PRODID", parts.prodid), ...(parts.method === undefined ? [] : [line("METHOD", parts.method)])];
  return calendarOf({ name: "VCALENDAR", properties, components: [...(parts.timezones ?? []), ...parts.events] });
}

/** What a calendar says about itself: RFC 7986's properties, with the older unregistered ones as their fallback. */
export interface CalendarInfo {
  readonly name: string | null;
  readonly description: string | null;
  /** A CSS colour name (RFC 7986 section 5.9), as written. */
  readonly color: string | null;
  /** How often the publisher suggests asking, at the least: REFRESH-INTERVAL, else X-PUBLISHED-TTL. */
  readonly refreshInterval: Duration | null;
  /** Where the publisher says the data lives. Information only: a subscription never moves itself there. */
  readonly source: string | null;
  readonly url: string | null;
  /** X-WR-TIMEZONE: the zone a writer meant its calendar to be read in. `null` when it is longer than a zone's name may be. */
  readonly timezone: string | null;
}

export function calendarInfo(calendar: CalObject): CalendarInfo {
  const text = (...names: string[]): string | null => {
    for (const name of names) {
      const p = propertyOf(calendar.tree, name);
      if (p !== null && p.value.trim() !== "") return unescapeText(p.value).trim();
    }
    return null;
  };
  const interval = text("REFRESH-INTERVAL", "X-PUBLISHED-TTL");
  const refresh = interval === null ? null : parseDuration(interval);
  const zone = text("X-WR-TIMEZONE");
  return {
    name: text("NAME", "X-WR-CALNAME"),
    description: text("DESCRIPTION", "X-WR-CALDESC"),
    color: text("COLOR"),
    refreshInterval: refresh !== null && !refresh.negative ? refresh : null,
    source: text("SOURCE"),
    url: text("URL"),
    timezone: zone !== null && zone.length <= MAX_ZONE_NAME_CHARS ? zone : null,
  };
}
