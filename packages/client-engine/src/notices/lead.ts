/**
 * HOW AN ALERT SAYS ITS LEAD. A lead is a whole number of minutes from none to four weeks, and it
 * is never text: an alert carries the number, and whatever draws it writes the words from this
 * rule in its own language. The rule has words for every such number, so the product's own steps
 * and an alarm an event already has at its provider, which may be any number of minutes, are said
 * alike and truly. An alarm further ahead than four weeks has no words here and is not rung here.
 *
 * An event with a time of day says the largest unit that divides its lead evenly: 90 minutes is
 * "90 minutes", never "about an hour". A whole day says how many days before the day the alert
 * rings, whatever its hour: the evening before is "tomorrow". The desktop's shell holds the same
 * rule (`alerts.rs`), bound by one table (`test/notice-lead-words.json`).
 */
import { NOTICE_LEAD_MAX_MIN } from "./kinds.js";
import { whole } from "./shapes.js";

export type LeadWords =
  | { readonly as: "now" | "today" | "tomorrow" }
  | { readonly as: "minutes" | "hours" | "days" | "weeks"; readonly count: number };

/** The words for `leadMin` minutes before the start, or `null` for anything that is not a lead. */
export function leadWords(leadMin: number, allDay: boolean): LeadWords | null {
  if (!whole(leadMin, 0, NOTICE_LEAD_MAX_MIN)) return null;
  if (allDay === true) {
    const days = Math.ceil(leadMin / 1440);
    if (days === 0) return { as: "today" };
    if (days === 1) return { as: "tomorrow" };
    return days % 7 === 0 ? { as: "weeks", count: days / 7 } : { as: "days", count: days };
  }
  if (leadMin === 0) return { as: "now" };
  if (leadMin % 10_080 === 0) return { as: "weeks", count: leadMin / 10_080 };
  if (leadMin % 1440 === 0) return { as: "days", count: leadMin / 1440 };
  if (leadMin % 60 === 0) return { as: "hours", count: leadMin / 60 };
  return { as: "minutes", count: leadMin };
}
