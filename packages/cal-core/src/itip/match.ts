/**
 * What a message is about: the whole series, one occurrence, or one occurrence and every later one.
 * RFC 5546 section 2.1.5: an event is named by its UID, and "to reference an instance of a recurring
 * component, the primary key is composed of the UID and the RECURRENCE-ID properties".
 */
import type { CalEvent } from "../ical/event.js";
import { recurrenceKeyOf, recurrenceKeyString, type RecurrenceKey } from "../recur/key.js";
import type { Series } from "../recur/series.js";
import type { ZoneSource } from "../time/types.js";

export type MessageTarget =
  | { readonly scope: "series"; readonly key: null; readonly held: CalEvent | null }
  | { readonly scope: "occurrence" | "thisAndFuture"; readonly key: RecurrenceKey; readonly held: CalEvent | null };

/**
 * The part of a series one event of a message speaks of, and the component held for it: for the
 * series its own, for an occurrence its changed one where there is one, else the series'. `held` is
 * `null` when nothing is held (no series, or a series known only by other occurrences). The zone
 * source must be the one the series was grouped with: the keys are compared.
 *
 * Where `held` is the series' component for a message about one occurrence (`held.recurrenceId` is
 * `null`), a change the message brings is not the series' to take: it is made on that occurrence's
 * own component, which `changedOccurrence` gives. `applyReply` does so for an answer.
 */
export function targetOf(message: CalEvent, series: Series | null, zones: ZoneSource): MessageTarget {
  if (message.recurrenceId === null) return { scope: "series", key: null, held: series?.master ?? null };
  const key = recurrenceKeyOf(message.recurrenceId, zones);
  const held = series === null ? null : (series.overrides.get(recurrenceKeyString(key)) ?? series.master);
  return { scope: message.thisAndFuture ? "thisAndFuture" : "occurrence", key, held };
}
