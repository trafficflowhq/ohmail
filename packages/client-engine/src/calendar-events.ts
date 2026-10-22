/**
 * THE EVENTS ONE MESSAGE CARRIES, ONCE EACH — what the web, the desktop and the phone draw as
 * event cards. Read from the message's ready list (inline parts included: an embedded calendar
 * part counts) and the calendar texts the engine holds, deduplicated by event identity
 * (`distinctCalendarEvents`). Synchronous, no side effects: `loadCalendarTexts` is the ask.
 * Memoized on the texts map, which the engine replaces when texts land and drops on release.
 */
import { distinctCalendarEvents, isCalendarMime, type DistinctCalendarEvent } from "@trafficflow/core/ics";
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
