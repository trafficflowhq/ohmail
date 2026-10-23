/**
 * THE EVENTS ONE MESSAGE CARRIES, ONCE EACH — what the web, the desktop and the phone draw as
 * event cards. Read from the message's ready list (inline parts included: an embedded calendar
 * part counts) and the calendar texts the engine holds, deduplicated by event identity
 * (`distinctCalendarEvents`). Synchronous, no side effects: `loadCalendarTexts` is the ask.
 * Memoized on the texts map, which the engine replaces when texts land and drops on release.
 */
import {
  calendarEventKey, distinctCalendarEvents, isCalendarMime, parseIcsEvent, type DistinctCalendarEvent,
} from "@trafficflow/core/ics";
import type { OhmailEngine } from "./engine.js";

const NO_EVENTS: readonly DistinctCalendarEvent[] = Object.freeze([]);
const HELD = new WeakMap<ReadonlyMap<string, string>, readonly DistinctCalendarEvent[]>();

export function calendarEventsOf(
  engine: Pick<OhmailEngine, "attachmentsOf" | "calendarTextsOf">,
  messageId: string,
): readonly DistinctCalendarEvent[] {
  const texts = engine.calendarTextsOf(messageId);
  if (texts.size === 0) return NO_EVENTS;
  const held = HELD.get(texts);
  if (held) return held;
  const list = engine.attachmentsOf(messageId, { includeInlineParts: true });
  if (list.state !== "ready") return NO_EVENTS;
  const parts = list.items.flatMap((item) => {
    const text = isCalendarMime(item.mimeType) ? texts.get(item.id) : undefined;
    return text === undefined ? [] : [{ id: item.id, contentType: item.mimeType, text }];
  });
  const events = distinctCalendarEvents(parts);
  HELD.set(texts, events);
  return events;
}

const NO_IDS: ReadonlySet<string> = new Set();
/** Per texts map (one per message, replaced when texts land): the list it was read against, and the answer. */
const COVERED = new WeakMap<ReadonlyMap<string, string>, { items: readonly unknown[]; ids: ReadonlySet<string> }>();

/**
 * THE CALENDAR BODIES ANOTHER LISTED PART ALREADY CARRIES: a body (`AttachmentItem.calendarBody`)
 * is covered when the list holds a calendar part that is not a body (a named or embedded file) and
 * the body's own text either is not in hand or names an event one of those files' texts names too.
 * Google and Thunderbird: covered, whether the alternative fetched, failed or never parsed. Exchange
 * and Outlook (the alternative is the only calendar part), or a body whose event no file carries:
 * never, because it is then the one copy the person can retry, save or add to a calendar.
 */
function coveredCalendarBodies(
  engine: Pick<OhmailEngine, "attachmentsOf" | "calendarTextsOf">,
  messageId: string,
): ReadonlySet<string> {
  const list = engine.attachmentsOf(messageId, { includeInlineParts: true });
  if (list.state !== "ready") return NO_IDS;
  const texts = engine.calendarTextsOf(messageId);
  const held = texts.size > 0 ? COVERED.get(texts) : undefined;
  if (held && held.items === list.items) return held.ids;
  const calendar = list.items.filter((item) => isCalendarMime(item.mimeType));
  const files = calendar.filter((item) => item.calendarBody !== true);
  let ids = NO_IDS;
  if (files.length > 0) {
    const keyOf = (id: string): string | null => {
      const text = texts.get(id);
      const event = text === undefined ? null : parseIcsEvent(text);
      return event ? calendarEventKey(event) : null;
    };
    const fileKeys = new Set(files.map((item) => keyOf(item.id)));
    const covered = calendar.filter((item) => {
      if (item.calendarBody !== true) return false;
      const key = keyOf(item.id);
      return key === null || fileKeys.has(key);
    });
    if (covered.length > 0) ids = new Set(covered.map((item) => item.id));
  }
  // The shared empty map is every text-less message's: nothing to key on, and nothing was parsed.
  if (texts.size > 0) COVERED.set(texts, { items: list.items, ids });
  return ids;
}

/**
 * A STRIP'S PARTS: `items` (any view of this message's ready list) without the calendar bodies a
 * listed calendar file already carries ({@link coveredCalendarBodies}). Every other part, inline
 * ones and an uncovered body included, stays, in order; the same array when nothing is left out.
 * The web and desktop strip, its Download all and the phone's file chips read through this one filter.
 */
export function withoutCalendarBodies<T extends { id: string; calendarBody?: boolean }>(
  engine: Pick<OhmailEngine, "attachmentsOf" | "calendarTextsOf">,
  messageId: string,
  items: T[],
): T[] {
  if (!items.some((item) => item.calendarBody === true)) return items;
  const covered = coveredCalendarBodies(engine, messageId);
  return covered.size === 0 ? items : items.filter((item) => !covered.has(item.id));
}
