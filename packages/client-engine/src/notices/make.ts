/**
 * THE ONE PLACE A CALENDAR RECORD BECOMES A NOTICE. A record is another party's words in every
 * field: an invitation's title, its times as a provider wrote them. Each maker takes the title
 * through the label, rebuilds every number inside its range, and answers `null` rather than a
 * notice it cannot vouch for. What decides WHEN a notice is due calls these and writes none itself.
 * An alert set ahead and the set a surface is handed are made here too, and nowhere else.
 */
import { readAhead } from "./closed.js";
import { AHEAD_DAYS, AHEAD_LATE_MS, AHEAD_MAX, type AheadSet, type NoticeAhead } from "./emitter.js";
import { eventLabel } from "./label.js";
import {
  NOTICE_ACTS, NOTICE_LEAD_MAX_MIN, NOTICE_NAMES_EVENT, noticeCount,
  type CalendarNotice, type CalendarNoticeKind, type Clock, type EventLabel, type NoticeAct,
} from "./kinds.js";
import { aheadIdOf, clockOf, idOf, instant, scopeOf, tally, whole } from "./shapes.js";

/** What a maker reads of an event: its id, and what its label is made from. */
export interface NoticedEvent {
  readonly id: string;
  readonly title: string;
  readonly private: boolean;
  readonly heldBack: boolean;
}

/**
 * The event's id and its label for a notice of `kind`, or `null` where it makes no notice. The one
 * place a maker gets a label, and it asks the rule first: a kind that names no event gets none.
 */
function named(kind: CalendarNoticeKind, event: NoticedEvent, showTitles: boolean): { eventId: string; label: EventLabel } | null {
  if (NOTICE_NAMES_EVENT[kind] !== true) return null;
  const eventId = idOf(event.id);
  const label = eventLabel(event, showTitles);
  return eventId === null || label === null ? null : { eventId, label };
}

/** An alert of one occurrence. `acts` is cut down to the closed words, each once. */
export function alertNotice(
  event: NoticedEvent, showTitles: boolean,
  when: { readonly at: Clock; readonly allDay: boolean; readonly leadMin: number; readonly acts: readonly NoticeAct[] },
): CalendarNotice | null {
  const who = named("cal_alert", event, showTitles);
  const at = clockOf(when.at);
  if (who === null || at === null || !whole(when.leadMin, 0, NOTICE_LEAD_MAX_MIN)) return null;
  const acts = NOTICE_ACTS.filter((act) => when.acts.includes(act));
  return { kind: "cal_alert", ...who, at, allDay: when.allDay === true, leadMin: when.leadMin, acts };
}

/** An invitation that is shown on the calendar. One from a sender not let in is held back and makes none. */
export function invitationNotice(event: NoticedEvent, showTitles: boolean, when: { readonly at: Clock; readonly allDay: boolean }): CalendarNotice | null {
  const who = named("cal_invitation", event, showTitles);
  const at = clockOf(when.at);
  if (who === null || at === null) return null;
  return { kind: "cal_invitation", ...who, at, allDay: when.allDay === true };
}

/** An event that moved: where it stands now, and where it stood when that is known. */
export function movedNotice(
  event: NoticedEvent, showTitles: boolean, when: { readonly at: Clock; readonly was: Clock | null; readonly allDay: boolean },
): CalendarNotice | null {
  const who = named("cal_change", event, showTitles);
  const at = clockOf(when.at);
  if (who === null || at === null) return null;
  return { kind: "cal_change", change: "moved", ...who, at, was: clockOf(when.was), allDay: when.allDay === true };
}

/** An event that was called off. */
export function cancelledNotice(event: NoticedEvent, showTitles: boolean, when: { readonly at: Clock; readonly allDay: boolean }): CalendarNotice | null {
  const who = named("cal_change", event, showTitles);
  const at = clockOf(when.at);
  if (who === null || at === null) return null;
  return { kind: "cal_change", change: "cancelled", ...who, at, allDay: when.allDay === true };
}

/** Invitees answered: the answer as a closed word and how many gave it. Never who. */
export function answeredNotice(event: NoticedEvent, showTitles: boolean, answer: "yes" | "maybe" | "no", count: number): CalendarNotice | null {
  const who = named("cal_answer", event, showTitles);
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

/** One occurrence and one of its alarms, as numbers: what an alert set ahead is made from. */
export interface AheadWhen {
  /** When the occurrence starts: milliseconds since the epoch. A whole day starts at its midnight on the reader's clock. */
  readonly startMs: number;
  readonly allDay: boolean;
  /** The alarm: whole minutes before the start, 0 to `NOTICE_LEAD_MAX_MIN`. */
  readonly leadMin: number;
  readonly acts: readonly NoticeAct[];
}

/**
 * An alert to ring later, for one occurrence and one of its alarms. The minute it rings is worked
 * out here, the start less the lead, and its id is minted here from the event, the start and the
 * lead: nobody hands either in, so an occurrence that moved is another alert and the old one is
 * missing from the next set. `null` for an event that makes no notice, a start that is no instant,
 * or a lead that is not a whole number of minutes within four weeks.
 */
export function aheadAlert(event: NoticedEvent, showTitles: boolean, when: AheadWhen): NoticeAhead | null {
  const who = named("cal_alert", event, showTitles);
  if (who === null || !instant(when.startMs) || !whole(when.leadMin, 0, NOTICE_LEAD_MAX_MIN)) return null;
  const atMs = when.startMs - when.leadMin * 60_000;
  if (!instant(atMs)) return null;
  const acts = NOTICE_ACTS.filter((act) => when.acts.includes(act));
  return {
    id: aheadIdOf(who.eventId, when.startMs, when.leadMin), eventId: who.eventId, atMs, startMs: when.startMs,
    allDay: when.allDay === true, label: who.label, leadMin: when.leadMin, acts,
  };
}

/**
 * The set a surface is handed: `scope`'s alerts from `nowMs` on. Each alert is read closed again
 * (one that the maker above did not make is left out), then: none whose minute passed longer ago
 * than an alert may ring late, none further ahead than the window, each id once, ascending, the
 * nearest kept when there are more than a surface holds. `null` where `scope` is no account's: the
 * demo and a surface with nobody signed in set nothing to ring.
 */
export function aheadSet(scope: string, alerts: readonly NoticeAhead[], nowMs: number): AheadSet | null {
  const under = scopeOf(scope);
  if (under === null || !instant(nowMs)) return null;
  const until = nowMs + AHEAD_DAYS * 86_400_000;
  const byId = new Map<string, NoticeAhead>();
  for (const handed of alerts) {
    const alert = readAhead(handed);
    if (alert === null || alert.atMs < nowMs - AHEAD_LATE_MS || alert.atMs > until) continue;
    byId.set(alert.id, alert);
  }
  const kept = [...byId.values()].sort((a, b) => a.atMs - b.atMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, AHEAD_MAX);
  return { scope: under, alerts: kept };
}

/**
 * The notice an alert becomes when its minute has come, for a surface that rings by the page: the
 * alert read closed again, its start as the reader's clock says it, and of its acts only those the
 * surface carries. `null` when the alert does not read or the time is out of its ranges.
 */
export function dueNotice(alert: NoticeAhead, at: Clock, carries: readonly NoticeAct[]): CalendarNotice | null {
  const read = readAhead(alert);
  const clock = clockOf(at);
  if (read === null || clock === null) return null;
  const acts = read.acts.filter((act) => carries.includes(act));
  return { kind: "cal_alert", eventId: read.eventId, startMs: read.startMs, label: read.label, at: clock, allDay: read.allDay, leadMin: read.leadMin, acts };
}
