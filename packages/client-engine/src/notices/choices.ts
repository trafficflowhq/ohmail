/**
 * THE PERSON'S CHOICES, PER DEVICE. Two stored records, each read member by member: mail's keeps
 * the name and the record a device already holds (`ohmail.notifications.channels`), the calendar's
 * is new (`ohmail.notices.calendar`). Neither travels with the mailbox: who rings is this device's
 * own matter, and another install must never be able to make a notice say more.
 *
 * A record that is missing, unreadable or of another shape reads as the start values. That never
 * turns mail's notices all off, and never turns alerts on outside the calendar's phone app.
 */
import { NOTICE_KIND_FACTS, type CalendarNoticeKind, type MailNoticeKind, type NoticeKind } from "./kinds.js";

/** What the start values depend on: only the calendar's phone app rings alerts to start with. */
export interface NoticeWhere { readonly ohcalPhone: boolean }

/** Mail's stored record as the gate reads it: the master and its four kinds. A member a record holds beside these is not read. */
export type MailNoticeChoices = { readonly master: boolean } & Readonly<Record<MailNoticeKind, boolean>>;

/** When the daily summary rings while the person has set no time: 07:00, in minutes of the day. */
export const SUMMARY_AT_START = 420;

/** The calendar's stored record. */
export type CalendarNoticeChoices = Readonly<Record<CalendarNoticeKind, boolean>> & {
  /** Titles in notifications. Shown to start with; a private event says `Busy` either way. */
  readonly showTitles: boolean;
  /** Titles on the widgets. */
  readonly widgetTitles: boolean;
  /** When the daily summary rings: a whole minute of the day, 0 to 1439. */
  readonly summaryAt: number;
};

/** What the gate is handed: the master, every kind's switch, and whether a title may be shown. */
export type NoticeChoices = Readonly<Record<NoticeKind, boolean>> & {
  readonly master: boolean;
  readonly showTitles: boolean;
};

/** Where `kind`'s switch stands before the person touches it. */
export function noticeStartsOn(kind: NoticeKind, where: NoticeWhere): boolean {
  const start = NOTICE_KIND_FACTS[kind].start;
  return start === "on" || (start === "ohcal_phone" && where.ohcalPhone === true);
}

/** Reads a stored record's own member by name: an array, a string or nothing has none, and nothing inherited counts. */
function membersOf(raw: unknown): (name: string) => unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return () => undefined;
  const record = raw as Record<string, unknown>;
  return (name) => (Object.prototype.hasOwnProperty.call(record, name) ? record[name] : undefined);
}

/** A stored switch: exactly `true` or `false`, else the start value. */
function switchOf(stored: unknown, start: boolean): boolean {
  return stored === true || stored === false ? stored : start;
}

/** Mail's choices from its stored record. Each member is read by its own name; nothing else of the record is taken. */
export function mailChoicesOf(raw: unknown, where: NoticeWhere): MailNoticeChoices {
  const stored = membersOf(raw);
  const of = (kind: MailNoticeKind): boolean => switchOf(stored(kind), noticeStartsOn(kind, where));
  return { master: switchOf(stored("master"), true), ohbox: of("ohbox"), screener: of("screener"), scheduled: of("scheduled"), pairing: of("pairing") };
}

/** The calendar's choices from its stored record, read the same way. */
export function calendarChoicesOf(raw: unknown, where: NoticeWhere): CalendarNoticeChoices {
  const stored = membersOf(raw);
  const of = (kind: CalendarNoticeKind): boolean => switchOf(stored(kind), noticeStartsOn(kind, where));
  const at = stored("summaryAt");
  return {
    cal_alert: of("cal_alert"), cal_invitation: of("cal_invitation"), cal_change: of("cal_change"),
    cal_answer: of("cal_answer"), cal_found: of("cal_found"), cal_summary: of("cal_summary"),
    showTitles: switchOf(stored("showTitles"), true),
    widgetTitles: switchOf(stored("widgetTitles"), true),
    summaryAt: typeof at === "number" && Number.isInteger(at) && at >= 0 && at <= 1439 ? at : SUMMARY_AT_START,
  };
}

/** The gate's choices from the two stored records. */
export function noticeChoicesOf(mail: unknown, calendar: unknown, where: NoticeWhere): NoticeChoices {
  const m = mailChoicesOf(mail, where);
  const c = calendarChoicesOf(calendar, where);
  return {
    master: m.master, showTitles: c.showTitles,
    ohbox: m.ohbox, screener: m.screener, scheduled: m.scheduled, pairing: m.pairing,
    cal_alert: c.cal_alert, cal_invitation: c.cal_invitation, cal_change: c.cal_change,
    cal_answer: c.cal_answer, cal_found: c.cal_found, cal_summary: c.cal_summary,
  };
}
