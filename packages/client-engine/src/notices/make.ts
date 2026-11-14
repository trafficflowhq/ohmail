/**
 * THE ONE PLACE A CALENDAR RECORD BECOMES A NOTICE. A record is another party's words in every
 * field: an invitation's title, its times as a provider wrote them. Each maker takes the title
 * through the label, rebuilds every number inside its range, and answers `null` rather than a
 * notice it cannot vouch for. What decides WHEN a notice is due calls these and writes none itself.
 */
import { eventLabel } from "./label.js";
import {
  NOTICE_ACTS, NOTICE_COUNT_MAX, NOTICE_LEAD_MAX_MIN, noticeCount,
  type CalendarNotice, type Clock, type EventLabel, type NoticeAct,
} from "./kinds.js";

/** What a maker reads of an event: its id, and what its label is made from. */
export interface NoticedEvent {
  readonly id: string;
  readonly title: string;
  readonly private: boolean;
  readonly heldBack: boolean;
}

const whole = (n: unknown, min: number, max: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;

/** `clock` rebuilt from numbers in their ranges, or `null`. Nothing of the object handed in is kept. */
function clockOf(clock: Clock | null | undefined): Clock | null {
  if (typeof clock !== "object" || clock === null || !whole(clock.hour, 0, 23) || !whole(clock.minute, 0, 59)) return null;
  const { day } = clock;
  if (day === "today" || day === "tomorrow") return { hour: clock.hour, minute: clock.minute, day };
  if (typeof day !== "object" || day === null || !whole(day.month, 1, 12) || !whole(day.dom, 1, 31) || !whole(day.dow, 0, 6)) return null;
  return { hour: clock.hour, minute: clock.minute, day: { month: day.month, dom: day.dom, dow: day.dow } };
}

/** An id as the app's own stores mint them: short, and no character that could be read as words. */
function idOf(id: unknown): string | null {
  return typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? id : null;
}

/** The event's id and its label, or `null` where it makes no notice. */
function named(event: NoticedEvent, showTitles: boolean): { eventId: string; label: EventLabel } | null {
  const eventId = idOf(event.id);
  const label = eventLabel(event, showTitles);
  return eventId === null || label === null ? null : { eventId, label };
}

/** A count that may be nothing: a whole number from 0 to the largest a notice says. */
const tally = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), NOTICE_COUNT_MAX) : 0);

/** An alert of one occurrence. `acts` is cut down to the closed words, each once. */
export function alertNotice(
  event: NoticedEvent, showTitles: boolean,
  when: { readonly at: Clock; readonly allDay: boolean; readonly leadMin: number; readonly acts: readonly NoticeAct[] },
): CalendarNotice | null {
  const who = named(event, showTitles);
  const at = clockOf(when.at);
  if (who === null || at === null || !whole(when.leadMin, 0, NOTICE_LEAD_MAX_MIN)) return null;
  const acts = NOTICE_ACTS.filter((act) => when.acts.includes(act));
  return { kind: "cal_alert", ...who, at, allDay: when.allDay === true, leadMin: when.leadMin, acts };
}

/** An invitation that is shown on the calendar. One from a sender not let in is held back and makes none. */
export function invitationNotice(event: NoticedEvent, showTitles: boolean, when: { readonly at: Clock; readonly allDay: boolean }): CalendarNotice | null {
  const who = named(event, showTitles);
  const at = clockOf(when.at);
  if (who === null || at === null) return null;
  return { kind: "cal_invitation", ...who, at, allDay: when.allDay === true };
}

/** An event that moved: where it stands now, and where it stood when that is known. */
export function movedNotice(
  event: NoticedEvent, showTitles: boolean, when: { readonly at: Clock; readonly was: Clock | null; readonly allDay: boolean },
): CalendarNotice | null {
  const who = named(event, showTitles);
  const at = clockOf(when.at);
  if (who === null || at === null) return null;
  return { kind: "cal_change", change: "moved", ...who, at, was: clockOf(when.was), allDay: when.allDay === true };
}

/** An event that was called off. */
export function cancelledNotice(event: NoticedEvent, showTitles: boolean, when: { readonly at: Clock; readonly allDay: boolean }): CalendarNotice | null {
  const who = named(event, showTitles);
  const at = clockOf(when.at);
  if (who === null || at === null) return null;
  return { kind: "cal_change", change: "cancelled", ...who, at, allDay: when.allDay === true };
}

/** Invitees answered: the answer as a closed word and how many gave it. Never who. */
export function answeredNotice(event: NoticedEvent, showTitles: boolean, answer: "yes" | "maybe" | "no", count: number): CalendarNotice | null {
  const who = named(event, showTitles);
  const said = noticeCount(count);
  if (who === null || said === null || (answer !== "yes" && answer !== "maybe" && answer !== "no")) return null;
  return { kind: "cal_answer", ...who, answer, count: said };
}

/**
 * Events letters seem to propose. Takes the records and says how many: a proposal's title is the
 * letter's own words until the person adds it, so nothing of a record but its presence is read.
 */
export function foundNotice(found: readonly unknown[], first: Clock | null): CalendarNotice | null {
  const count = noticeCount(found.length);
  return count === null ? null : { kind: "cal_found", count, at: clockOf(first) };
}

/** The day's summary: counts and the first start. */
export function summaryNotice(day: { readonly events: number; readonly first: Clock | null; readonly toAnswer: number }): CalendarNotice {
  return { kind: "cal_summary", events: tally(day.events), first: clockOf(day.first), toAnswer: tally(day.toAnswer) };
}
