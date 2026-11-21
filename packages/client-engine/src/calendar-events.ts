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
const TILES = new WeakMap<ReadonlyMap<string, string>, readonly DistinctCalendarEvent[]>();

export function calendarEventsOf(
  engine: Pick<OhmailEngine, "attachmentsOf" | "calendarTextsOf">,
  messageId: string,
  attachmentTiles = false,
): readonly DistinctCalendarEvent[] {
  const texts = engine.calendarTextsOf(messageId);
  if (texts.size === 0) return NO_EVENTS;
  const cache = attachmentTiles ? TILES : HELD;
  const held = cache.get(texts);
  if (held) return held;
  const list = engine.attachmentsOf(messageId, { includeInlineParts: true });
  if (list.state !== "ready") return NO_EVENTS;
  const visible = attachmentTiles ? withoutCalendarBodies(engine, messageId, list.items) : list.items;
  const parts = visible.flatMap((item) => {
    const text = isCalendarMime(item.mimeType) ? texts.get(item.id) : undefined;
    return text === undefined ? [] : [{ id: item.id, contentType: item.mimeType, text }];
  });
  const events = distinctCalendarEvents(parts);
  cache.set(texts, events);
  return events;
}

const NO_IDS: ReadonlySet<string> = new Set();
/** Per texts map (one per message, replaced when texts land): the list it was read against, and the answer. */
const COVERED = new WeakMap<ReadonlyMap<string, string>, { items: readonly unknown[]; ids: ReadonlySet<string> }>();

/**
 * CALENDAR PARTS ANOTHER LISTED PART ALREADY CARRIES: a body (`AttachmentItem.calendarBody`)
 * is covered when the list holds a calendar part that is not a body (a named or embedded file) and
 * the body's own text either is not in hand or names an event one of those files' texts names too.
 * Google and Thunderbird: covered, whether the alternative fetched, failed or never parsed. Exchange
 * and Outlook (the alternative is the only calendar part), or a body whose event no file carries:
 * never, because it is then the one copy the person can retry, save or add to a calendar.
 */
function coveredCalendarParts(
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
  if (calendar.length > 1) {
    const keyOf = (id: string): string | null => {
      const text = texts.get(id);
      const event = text === undefined ? null : parseIcsEvent(text);
      return event ? calendarEventKey(event) : null;
    };
    const named = new Set<string>();
    const hidden = new Set<string>();
    for (const file of files) {
      const key = keyOf(file.id);
      if (key === null) continue;
      if (named.has(key)) hidden.add(file.id);
      else named.add(key);
    }
    for (const body of calendar.filter((item) => item.calendarBody)) {
      const key = keyOf(body.id);
      if (key === null ? files.length > 0 : named.has(key)) hidden.add(body.id);
      else if (key !== null) named.add(key);
    }
    if (hidden.size > 0) ids = hidden;
  }
  // The shared empty map is every text-less message's: nothing to key on, and nothing was parsed.
  if (texts.size > 0) COVERED.set(texts, { items: list.items, ids });
  return ids;
}

/**
 * A STRIP'S PARTS: `items` (any view of this message's ready list) without the calendar bodies a
 * listed part already carries ({@link coveredCalendarParts}). Every other part, inline
 * ones and an uncovered body included, stays, in order; the same array when nothing is left out.
 * The web and desktop strip, its Download all and the phone's file chips read through this one filter.
 */
export function withoutCalendarBodies<T extends { id: string; calendarBody?: boolean }>(
  engine: Pick<OhmailEngine, "attachmentsOf" | "calendarTextsOf">,
  messageId: string,
  items: T[],
): T[] {
  if (items.length < 2 && !items.some((item) => item.calendarBody === true)) return items;
  const covered = coveredCalendarParts(engine, messageId);
  return covered.size === 0 ? items : items.filter((item) => !covered.has(item.id));
}
