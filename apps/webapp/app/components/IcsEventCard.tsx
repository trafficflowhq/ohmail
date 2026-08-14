"use client";

/**
 * ═══ THE EVENT CARD — a calendar invitation, readable instead of merely saveable ═══════════
 *
 * Renders one parsed calendar part ({@link import("@trafficflow/core/ics").IcsEventPreview})
 * as the event it carries: what, when, where, who — and the METHOD said plainly, because the
 * method IS the message: a REQUEST is an invitation, a COUNTER is a proposed new time (with
 * the time it would replace struck through beneath, when the sender carried it), a CANCEL is
 * a cancellation, a REPLY is the answer it contains.
 *
 * ── EVERY FIELD IS TEXT ───────────────────────────────────────────────────────────────────
 *
 * SUMMARY, LOCATION and every CN below arrive from whoever knows the address; they render as
 * React text nodes, never markup. ORGANIZER/ATTENDEE values are shown as names or plain
 * addresses — never as links: the parser already refuses every scheme but `mailto:` and this
 * card renders no anchor at all, so a crafted CAL-ADDRESS cannot become something pressable.
 *
 * ── TIME, IN THE READER'S CLOCK ───────────────────────────────────────────────────────────
 *
 * A resolved instant is formatted in the READER's zone and locale (`activeFormatZone`/
 * `activeFormatLocale`, the same seams every stamp in `format.ts` reads) — an invitation for
 * 14:00 Zurich reads "8:00 AM" to a reader in New York, which is when their meeting is. The
 * honest degradations, in order: an all-day date formats in UTC (it is a calendar day, not an
 * instant); a FLOATING time (no zone claimed) formats verbatim — RFC 5545 says it means the
 * observer's local clock; a time in a zone this runtime cannot resolve formats verbatim WITH
 * its zone label appended, which states exactly what is known and no more.
 */

import { useMemo } from "react";
import type { IcsEventPreview, IcsTime, IcsWeekday } from "@trafficflow/core/ics";
import "./ics-event-card.css";
import { liveCopy, activeFormatLocale, activeFormatZone } from "../shell/locale";

/**
 * THE ENGLISH SENTENCES — the fallback for the `icsEvent` namespace and the parity oracle for
 * it (`locale-shim-parity.test.ts` holds the two together). `liveCopy` and not the hook, for
 * the reason the strip's own table states: this component mounts bare in unit tests.
 */
const EN = {
  /* the kickers — what kind of calendar message is on screen */
  request: "Invitation",
  counter: "Proposed new time",
  cancelled: "Cancelled",
  accepted: "Accepted",
  declined: "Declined",
  tentative: "Tentative",
  reply: "Reply",
  event: "Event",
  /* the when-line's words */
  allDay: "All day",
  /**
   * The word before the struck-out time a COUNTER proposes to replace. A plain label rather
   * than an ICU template with the time inside, because the time renders as its own `<s>`
   * element — semantics a formatted string cannot carry.
   */
  previously: "was",
  /** en.json: "{count, plural, one {# invited} other {# invited}}" */
  invited: (count: number) => `${count} invited`,
  /* the spoken recurrence — only rules trivial enough to be TRUE in one line get here */
  daily: "Every day",
  everyNDays: (n: number) => `Every ${n} days`,
  weekly: "Weekly",
  weeklyOn: (days: string) => `Weekly on ${days}`,
  everyNWeeks: (n: number) => `Every ${n} weeks`,
  everyNWeeksOn: (n: number, days: string) => `Every ${n} weeks on ${days}`,
  monthly: "Monthly",
  everyNMonths: (n: number) => `Every ${n} months`,
  yearly: "Yearly",
  everyNYears: (n: number) => `Every ${n} years`,
};

export const COPY: typeof EN = liveCopy("icsEvent", EN, {
  invited: ["count"],
  everyNDays: ["n"],
  weeklyOn: ["days"],
  everyNWeeks: ["n"],
  everyNWeeksOn: ["n", "days"],
  everyNMonths: ["n"],
  everyNYears: ["n"],
});

/* ── time formatting ───────────────────────────────────────────────────────────────────── */

/**
 * The Date whose UTC fields ARE the wall-clock fields — what a floating or unresolvable time
 * formats through (`timeZone: "UTC"` reproduces the fields verbatim).
 */
function wallDate(t: IcsTime): Date {
  return new Date(Date.UTC(t.wall.year, t.wall.month - 1, t.wall.day, t.wall.hour, t.wall.minute));
}

/** The instant to format and the zone to format it in — the two honest-degradation branches. */
function displayBasis(t: IcsTime): { date: Date; zone: string; zoneLabel: string | null } {
  if (t.allDay) return { date: new Date(t.epochMs!), zone: "UTC", zoneLabel: null };
  if (t.epochMs !== null) return { date: new Date(t.epochMs), zone: activeFormatZone(), zoneLabel: null };
  // No instant: format the wall fields verbatim, naming the zone only where one was claimed.
  return { date: wallDate(t), zone: "UTC", zoneLabel: t.tzid };
}

function fmt(date: Date, zone: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(activeFormatLocale(), { ...opts, timeZone: zone }).format(date);
}

const DATE_OPTS: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", year: "numeric" };
const TIME_OPTS: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

/** All-day DTEND is EXCLUSIVE (RFC 5545) — the last day the reader is AT the event. */
function inclusiveAllDayEnd(end: IcsTime): Date {
  return new Date(end.epochMs! - 24 * 3600 * 1000);
}

/**
 * The when-line. Shapes, in the reader's locale and zone:
 *   timed, same day    — "Fri, Sep 11, 2026 · 4:00 – 4:30 PM"
 *   timed, multi-day   — "Fri, Sep 11, 2026, 4:00 PM – Sat, Sep 12, 2026, 10:00 AM"
 *   all-day, one day   — "Tue, Sep 15, 2026 · All day"
 *   all-day, multi-day — "Tue, Sep 15, 2026 – Wed, Sep 16, 2026"
 *   unresolvable zone  — "Wed, Aug 19, 2026 · 2:00 PM (Middle Earth Standard Time)"
 */
export function formatWhen(start: IcsTime, end: IcsTime | null): string {
  const s = displayBasis(start);

  if (start.allDay) {
    const first = fmt(s.date, "UTC", DATE_OPTS);
    if (end?.allDay && end.epochMs !== null && end.epochMs - start.epochMs! > 24 * 3600 * 1000) {
      return `${first} – ${fmt(inclusiveAllDayEnd(end), "UTC", DATE_OPTS)}`;
    }
    return `${first} · ${COPY.allDay}`;
  }

  const dayOf = (d: Date, zone: string) => fmt(d, zone, { year: "numeric", month: "numeric", day: "numeric" });
  const label = s.zoneLabel ? ` (${s.zoneLabel})` : "";
  const startDate = fmt(s.date, s.zone, DATE_OPTS);
  const startTime = fmt(s.date, s.zone, TIME_OPTS);

  // An end is comparable only when it lives on the same basis (both resolved, or both wall).
  const e = end && !end.allDay && (end.epochMs !== null) === (start.epochMs !== null) ? displayBasis(end) : null;
  if (!e) return `${startDate} · ${startTime}${label}`;
  if (dayOf(s.date, s.zone) === dayOf(e.date, e.zone)) {
    return `${startDate} · ${startTime} – ${fmt(e.date, e.zone, TIME_OPTS)}${label}`;
  }
  return `${startDate}, ${startTime} – ${fmt(e.date, e.zone, DATE_OPTS)}, ${fmt(e.date, e.zone, TIME_OPTS)}${label}`;
}

/** The calendar-page glyph's two lines, from the same display basis as the when-line. */
function glyphFields(t: IcsTime): { month: string; day: string } {
  const b = displayBasis(t);
  return { month: fmt(b.date, b.zone, { month: "short" }).replace(/\.$/, ""), day: fmt(b.date, b.zone, { day: "numeric" }) };
}

/* ── the spoken recurrence ─────────────────────────────────────────────────────────────── */

/** ICS weekday code → a Date pinned to that weekday (2026-06-01 is a Monday), for Intl naming. */
const WEEKDAY_ANCHOR: Record<IcsWeekday, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

function weekdayName(code: IcsWeekday): string {
  return new Intl.DateTimeFormat(activeFormatLocale(), { weekday: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, 5, WEEKDAY_ANCHOR[code])),
  );
}

/** "Weekly on Tuesday" — words only where the rule is trivially true in words; else nothing. */
export function recurrenceLine(rec: IcsEventPreview["recurrence"]): string | null {
  if (!rec) return null;
  const days = rec.byDay.map(weekdayName).join(", ");
  switch (rec.freq) {
    case "DAILY":
      return rec.interval === 1 ? COPY.daily : COPY.everyNDays(rec.interval);
    case "WEEKLY":
      if (rec.interval === 1) return days ? COPY.weeklyOn(days) : COPY.weekly;
      return days ? COPY.everyNWeeksOn(rec.interval, days) : COPY.everyNWeeks(rec.interval);
    case "MONTHLY":
      // A BYDAY-qualified monthly rule was already refused by the parser (ordinal days are not
      // trivially speakable), so what reaches here is a plain "monthly on the start date".
      return rec.interval === 1 ? COPY.monthly : COPY.everyNMonths(rec.interval);
    case "YEARLY":
      return rec.interval === 1 ? COPY.yearly : COPY.everyNYears(rec.interval);
  }
}

/* ── the kicker: METHOD semantics, said plainly ────────────────────────────────────────── */

function kicker(ev: IcsEventPreview): { text: string; tone: "cancel" | null } {
  if (ev.cancelled) return { text: COPY.cancelled, tone: "cancel" };
  switch (ev.method) {
    case "COUNTER":
      return { text: COPY.counter, tone: null };
    case "REPLY":
      return {
        text:
          ev.replyStatus === "ACCEPTED"
            ? COPY.accepted
            : ev.replyStatus === "DECLINED"
              ? COPY.declined
              : ev.replyStatus === "TENTATIVE"
                ? COPY.tentative
                : COPY.reply,
        tone: null,
      };
    case "REQUEST":
      return { text: COPY.request, tone: null };
    default:
      return { text: COPY.event, tone: null };
  }
}

/* ── who ───────────────────────────────────────────────────────────────────────────────── */

/**
 * One compact line of people. On a REPLY the replier is the story; otherwise the organizer,
 * with the invited count beside them when there is one. Names fall back to plain addresses —
 * TEXT, never a link (see the header).
 */
function peopleLine(ev: IcsEventPreview): string | null {
  const nameOf = (p: { name: string | null; email: string | null } | null): string | null =>
    p ? p.name || p.email : null;
  if (ev.method === "REPLY") return nameOf(ev.attendees[0] ?? null) ?? nameOf(ev.organizer);
  const host = nameOf(ev.organizer);
  const count = ev.attendeeCount > 0 ? COPY.invited(ev.attendeeCount) : null;
  if (host && count) return `${host} · ${count}`;
  return host ?? count ?? nameOf(ev.attendees[0] ?? null);
}

/* ── glyphs (the icon set's stroke grammar: 16-grid, 1.3 stroke) ───────────────────────── */

const GLYPH_PLACE = (
  <svg className="ic" viewBox="0 0 16 16" aria-hidden="true" style={{ width: 12, height: 12 }}>
    <path d="M8 14.2s-4.6-4.2-4.6-7.4a4.6 4.6 0 0 1 9.2 0c0 3.2-4.6 7.4-4.6 7.4z" />
    <circle cx="8" cy="6.6" r="1.7" />
  </svg>
);

const GLYPH_PEOPLE = (
  <svg className="ic" viewBox="0 0 16 16" aria-hidden="true" style={{ width: 12, height: 12 }}>
    <circle cx="6" cy="5.6" r="2.3" />
    <path d="M2.4 13.2c.5-2.4 1.9-3.6 3.6-3.6s3.1 1.2 3.6 3.6" />
    <path d="M10.4 3.8a2.3 2.3 0 0 1 0 3.7M12.1 9.9c.8.6 1.3 1.7 1.5 3" />
  </svg>
);

const GLYPH_REPEAT = (
  <svg className="ic" viewBox="0 0 16 16" aria-hidden="true" style={{ width: 12, height: 12 }}>
    <path d="M3 6.5a5 5 0 0 1 8.6-2.4l1.4 1.4M13 3v2.5h-2.5" />
    <path d="M13 9.5a5 5 0 0 1-8.6 2.4L3 10.5M3 13v-2.5h2.5" />
  </svg>
);

/* ── the card ──────────────────────────────────────────────────────────────────────────── */

export interface IcsEventCardProps {
  event: IcsEventPreview;
}

export function IcsEventCard({ event }: IcsEventCardProps) {
  const k = kicker(event);
  const glyph = glyphFields(event.start);
  const when = formatWhen(event.start, event.end);
  // Old → new, only where the COUNTER carried the time it proposes to replace.
  const previously = useMemo(
    () => (event.oldStart ? formatWhen(event.oldStart, event.oldEnd) : null),
    [event],
  );
  const repeat = recurrenceLine(event.recurrence);
  const people = peopleLine(event);

  return (
    <section className="ics-card" data-cancelled={event.cancelled || undefined}>
      <span className="ics-date" aria-hidden="true">
        <span className="ics-date-mo">{glyph.month}</span>
        <span className="ics-date-day">{glyph.day}</span>
      </span>
      <div className="ics-body">
        <div className="ics-kicker" data-tone={k.tone ?? undefined}>
          {k.text}
        </div>
        {event.summary ? <div className="ics-summary">{event.summary}</div> : null}
        <div className="ics-when">{when}</div>
        {previously ? (
          <div className="ics-prev">
            {/* `<s>`: struck through in the DOM's own vocabulary, so a screen reader with
                text-attribute announcement (and any styling failure) still carries "old". */}
            {COPY.previously}{" "}
            <s>{previously}</s>
          </div>
        ) : null}
        {repeat ? (
          <div className="ics-meta">
            {GLYPH_REPEAT}
            {repeat}
          </div>
        ) : null}
        {event.location ? (
          <div className="ics-meta">
            {GLYPH_PLACE}
            {event.location}
          </div>
        ) : null}
        {people ? (
          <div className="ics-meta">
            {GLYPH_PEOPLE}
            {people}
          </div>
        ) : null}
      </div>
    </section>
  );
}
