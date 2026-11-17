/**
 * THE NOTICE KINDS, AND WHAT EACH MAY SAY. One list for the gate, the pane and every surface's
 * emitter. A notice is read by whoever can see the screen, locked or not, so a mail notice is
 * closed words and whole numbers and has no member that could hold a letter's sender, subject or
 * words. The one free text in any notice is an event's title, and only through {@link EventLabel}.
 */

/** Mail's kinds: the ids a device's stored choices already use. */
export const MAIL_NOTICE_KINDS = ["ohbox", "screener", "scheduled", "pairing"] as const;
/** The calendar's kinds, one for each row of the Notifications pane. */
export const CALENDAR_NOTICE_KINDS = [
  "cal_alert", "cal_invitation", "cal_change", "cal_answer", "cal_found", "cal_summary",
] as const;
/** Every kind, in the order the pane lists them. */
export const NOTICE_KINDS = [...MAIL_NOTICE_KINDS, ...CALENDAR_NOTICE_KINDS] as const;

export type MailNoticeKind = (typeof MAIL_NOTICE_KINDS)[number];
export type CalendarNoticeKind = (typeof CALENDAR_NOTICE_KINDS)[number];
export type NoticeKind = MailNoticeKind | CalendarNoticeKind;

/** The surfaces that draw notices. A page a desktop serves to a phone's browser draws none. */
export type NoticeSurface = "web" | "desktop" | "android" | "iphone";

/** Where a kind's switch stands before the person touches it: `ohcal_phone` is on in the calendar's phone app alone. */
export type NoticeStart = "on" | "off" | "ohcal_phone";

export interface NoticeKindFacts {
  readonly product: "mail" | "calendar";
  readonly start: NoticeStart;
  /** The surfaces whose emitter may carry the kind. Never empty: a kind no surface emits does not compile. */
  readonly surfaces: readonly [NoticeSurface, ...NoticeSurface[]];
}

/**
 * Each kind's product, its start value and the surfaces that emit it. Total: a kind added to the
 * list above does not compile until it stands here. The iPhone draws no mail notice: it takes no
 * push, and only the calendar's two kinds that are set ahead reach it.
 */
export const NOTICE_KIND_FACTS: Readonly<Record<NoticeKind, NoticeKindFacts>> = {
  ohbox: { product: "mail", start: "on", surfaces: ["web", "desktop", "android"] },
  screener: { product: "mail", start: "on", surfaces: ["web", "desktop", "android"] },
  scheduled: { product: "mail", start: "on", surfaces: ["web", "desktop", "android"] },
  pairing: { product: "mail", start: "on", surfaces: ["web", "desktop", "android"] },
  cal_alert: { product: "calendar", start: "ohcal_phone", surfaces: ["web", "desktop", "android", "iphone"] },
  cal_invitation: { product: "calendar", start: "on", surfaces: ["web", "desktop", "android"] },
  cal_change: { product: "calendar", start: "on", surfaces: ["web", "desktop", "android"] },
  cal_answer: { product: "calendar", start: "off", surfaces: ["web", "desktop", "android"] },
  cal_found: { product: "calendar", start: "off", surfaces: ["web", "desktop", "android"] },
  cal_summary: { product: "calendar", start: "off", surfaces: ["web", "desktop", "android", "iphone"] },
};

/** The kinds `surface` may carry, in the pane's order: what its emitter's `carries` is held to. */
export function noticeKindsOf(surface: NoticeSurface): NoticeKind[] {
  return NOTICE_KINDS.filter((kind) => NOTICE_KIND_FACTS[kind].surfaces.includes(surface));
}

/** The largest count a notice says. */
export const NOTICE_COUNT_MAX = 9999;

/** `n` as a count a notice may say: a whole number from 1 to {@link NOTICE_COUNT_MAX}, or `null` for nothing to say. */
export function noticeCount(n: number): number | null {
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(Math.floor(n), NOTICE_COUNT_MAX);
}

/** The kind of device a pairing names, from the server's own list. Never the label a device chose for itself. */
export type NoticeDevice = "desktop" | "phone" | "browser";

export type MailNotice =
  | { readonly kind: "ohbox"; readonly count: number }
  | { readonly kind: "screener"; readonly count: number }
  | { readonly kind: "scheduled"; readonly outcome: "sent" | "failed"; readonly count: number }
  | { readonly kind: "pairing"; readonly change: "paired" | "revoked"; readonly device: NoticeDevice | null };

/**
 * How an event is named in a notice: its cleaned title, `Busy` for a private one, or `Event` where
 * titles are hidden. The surface has the words for the two closed forms.
 */
export type EventLabel =
  | { readonly as: "title"; readonly text: string }
  | { readonly as: "busy" }
  | { readonly as: "event" };

/** A day as a notice names it: `dow` counts from Sunday as 0. */
export interface NoticeDate { readonly month: number; readonly dom: number; readonly dow: number }

/** A time as numbers in their ranges, never as text: the surface writes it in the person's language. */
export interface Clock {
  readonly hour: number;
  readonly minute: number;
  readonly day: "today" | "tomorrow" | NoticeDate;
}

/** What a person can do from an alert without opening the app. The words are closed; no link rides a notice. */
export const NOTICE_ACTS = ["join", "again"] as const;
export type NoticeAct = (typeof NOTICE_ACTS)[number];

/** The longest lead an alert says, in minutes: four weeks. */
export const NOTICE_LEAD_MAX_MIN = 40_320;

export type CalendarNotice =
  | {
    readonly kind: "cal_alert"; readonly eventId: string; readonly label: EventLabel; readonly at: Clock;
    readonly allDay: boolean; readonly leadMin: number; readonly acts: readonly NoticeAct[];
  }
  | { readonly kind: "cal_invitation"; readonly eventId: string; readonly label: EventLabel; readonly at: Clock; readonly allDay: boolean }
  | {
    readonly kind: "cal_change"; readonly change: "moved"; readonly eventId: string; readonly label: EventLabel;
    readonly at: Clock; readonly was: Clock | null; readonly allDay: boolean;
  }
  | {
    readonly kind: "cal_change"; readonly change: "cancelled"; readonly eventId: string; readonly label: EventLabel;
    readonly at: Clock; readonly allDay: boolean;
  }
  | {
    readonly kind: "cal_answer"; readonly eventId: string; readonly label: EventLabel;
    readonly answer: "yes" | "maybe" | "no"; readonly count: number;
  }
  /** Something found in a letter. No label: its title is the letter's words until the person adds it. */
  | { readonly kind: "cal_found"; readonly count: number; readonly at: Clock | null }
  | { readonly kind: "cal_summary"; readonly events: number; readonly first: Clock | null; readonly toAnswer: number };

/** What an emitter is handed. */
export type Notice = MailNotice | CalendarNotice;
