/**
 * WHO HEARS A CALENDAR ALERT, AND WHEN: THE ONE RULE. An alert rings on a screen that may be locked,
 * in front of whoever stands there, so it is asked for twice and both answers are given here.
 *
 * When the calendar's alerts are made: does this event ring at all ({@link eventRings}), and for
 * which of its alarms ({@link ringingLeads}). What makes the alerts asks these and decides nothing
 * of its own, so a set never holds an alert for an event that was deleted or called off, that the
 * person declined, whose invitation is not shown yet, or whose calendar is gone or hidden.
 *
 * The moment one is due ({@link mayRing}): the account it was set under is still the signed-in one,
 * the alert still stands in the set the ringer holds now, and it is not too late for its words to
 * be true. Every ringer asks this before it draws or sounds: the page's own book below, the
 * desktop's shell (`alerts.rs`, held to the same table of cases), a phone's alarm.
 *
 * A set is replaced whole at every settle of the copy, so an event that moved, an alarm that was
 * removed and an invitation that was declined are simply missing from the next set. A ringer asked
 * under another account, or under nobody, drops everything it holds: what was set under the account
 * left never waits to fire.
 */
import type { CalendarAlarm, CalendarAnswer, CalendarEventStatus } from "@ohmail/wire";
import { readAheadSet } from "./closed.js";
import { AHEAD_LATE_MS, type AheadSet, type NoticeAhead } from "./emitter.js";
import { NOTICE_LEAD_MAX_MIN } from "./kinds.js";
import { scopeOf, whole } from "./shapes.js";

/** What the rule reads of an event: how it stands, never a word of it. */
export interface RungEvent {
  readonly status: CalendarEventStatus;
  /** The person's own answer where they are invited. */
  readonly myAnswer: CalendarAnswer | null;
  /** An invitation not yet shown on the calendar. */
  readonly heldBack: boolean;
  readonly alarms: readonly CalendarAlarm[];
}

/** What the rule reads of the event's calendar. */
export interface RungCalendar {
  readonly shown: boolean;
}

/**
 * Does `event` ring at all on this device? Only when every answer is a yes the rule knows: the
 * event is held and its calendar is held and shown, it is confirmed or tentative, its invitation is
 * shown, and the person has not declined it. Anything missing or of another word does not ring.
 */
export function eventRings(event: RungEvent | null | undefined, calendar: RungCalendar | null | undefined): boolean {
  if (event === null || event === undefined || calendar === null || calendar === undefined) return false;
  if (calendar.shown !== true || event.heldBack !== false) return false;
  if (event.status !== "confirmed" && event.status !== "tentative") return false;
  return event.myAnswer !== "declined";
}

/**
 * The leads `event` rings by, in whole minutes before its start, each once, ascending: none where
 * the event does not ring. Only an alarm that is a notice on the device (one that is a letter is
 * never acted on), and only a lead within four weeks: an event keeps whatever alarms its provider
 * holds, and one further ahead than that stays the provider's to ring.
 */
export function ringingLeads(event: RungEvent | null | undefined, calendar: RungCalendar | null | undefined): number[] {
  if (!eventRings(event, calendar) || !Array.isArray(event!.alarms)) return [];
  const leads = new Set<number>();
  for (const alarm of event!.alarms) {
    if (typeof alarm !== "object" || alarm === null || alarm.method !== "notice") continue;
    if (whole(alarm.minutesBefore, 0, NOTICE_LEAD_MAX_MIN)) leads.add(alarm.minutesBefore);
  }
  return [...leads].sort((a, b) => a - b);
}

/** What a ringer knows the moment an alert's minute has come. */
export interface RingAsk {
  /** The set the ringer holds now, as it was last handed; `null` when it holds none. */
  readonly held: AheadSet | null;
  /** The account that is signed in now, by its scope; `null` for nobody. */
  readonly live: string | null;
  readonly nowMs: number;
}

/**
 * May `alert` ring now? The set held was made under the account that is signed in now, the alert
 * still stands in it at the same minute, that minute has come, and no longer ago than an alert may
 * ring late.
 */
export function mayRing(alert: NoticeAhead, ask: RingAsk): boolean {
  const { held, live, nowMs } = ask;
  if (held === null || scopeOf(live) === null || held.scope !== live) return false;
  const standing = held.alerts.find((a) => a.id === alert.id);
  if (standing === undefined || standing.atMs !== alert.atMs) return false;
  return nowMs >= alert.atMs && nowMs - alert.atMs <= AHEAD_LATE_MS;
}

/**
 * A RINGER'S BOOK: the one set it holds, and what it has rung of it. The page rings by this where
 * its surface cannot set alerts itself; the desktop's shell keeps the same book in its own language.
 * It keeps no timer: `nextAtMs` says when to wake, `due` says what rings then.
 */
export class AlertBook {
  private held: AheadSet | null = null;
  private readonly rung = new Map<string, number>();

  /**
   * Take a set whole, read closed, as a copy: the one before is gone. A set that does not read
   * leaves nothing held. Another account's set also forgets what was rung for the one before.
   */
  set(set: AheadSet): void {
    const read = readAheadSet(set);
    if (read === null) {
      this.clear();
      return;
    }
    if (this.held !== null && this.held.scope !== read.scope) this.rung.clear();
    this.held = read;
  }

  /** Nothing is held and nothing rings: a sign-out, a switch, the shell going away. */
  clear(): void {
    this.held = null;
    this.rung.clear();
  }

  /** The scope of the set held; `null` when none is. */
  scope(): string | null {
    return this.held === null ? null : this.held.scope;
  }

  /** The minute of the next alert not yet asked for; `null` when there is none to wake for. */
  nextAtMs(): number | null {
    if (this.held === null) return null;
    for (const alert of this.held.alerts) if (!this.rung.has(alert.id)) return alert.atMs;
    return null;
  }

  /**
   * The alerts that ring now, under the account `live`, in the set's order, each once. Asked under
   * another account or under nobody, the book drops its set and answers nothing. An alert whose
   * minute passed too long ago is never rung, now or later.
   */
  due(live: string | null, nowMs: number): NoticeAhead[] {
    const held = this.held;
    if (held === null) return [];
    if (live !== held.scope) {
      this.clear();
      return [];
    }
    // Keep a recent delivery across an empty set. An expired id is needed only while the
    // corresponding stale alert remains in the book, to keep it from arming another timer.
    for (const [id, atMs] of this.rung) {
      if (nowMs - atMs > AHEAD_LATE_MS && !held.alerts.some(alert => alert.id === id)) this.rung.delete(id);
    }
    const out: NoticeAhead[] = [];
    for (const alert of held.alerts) {
      if (alert.atMs > nowMs) break;
      if (this.rung.has(alert.id)) continue;
      this.rung.set(alert.id, alert.atMs);
      if (mayRing(alert, { held, live, nowMs })) out.push(alert);
    }
    return out;
  }
}
