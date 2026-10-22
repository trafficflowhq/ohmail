"use client";

/**
 * The event card — a calendar invitation, readable instead of merely saveable. Renders one parsed calendar part as
 * the event it carries: what, when, where, who — and the METHOD said plainly, because the method IS the message:
 * REQUEST an invitation, COUNTER a proposed new time (the replaced time struck through beneath when the sender
 * carried it), CANCEL a cancellation, REPLY the answer.
 */

/**
 * Every field is text: SUMMARY, LOCATION and every CN render as React text nodes, never markup; ORGANIZER/ATTENDEE
 * values are names or plain addresses, never links — the parser refuses every scheme but `mailto:` and this card
 * renders no anchor, so a crafted CAL-ADDRESS cannot become pressable. Time in the reader's clock
 * (`activeFormatZone`/`activeFormatLocale`); honest degradations in order: an all-day date formats in UTC (a calendar
 * day, not an instant), a FLOATING time formats verbatim (RFC 5545: the observer's clock), a zone this runtime cannot
 * resolve formats verbatim WITH its zone label — exactly what is known and no more.
 */

import { useMemo } from "react";
import {
  formatIcsWhen, icsDateGlyph, icsKicker, icsPeople, icsRecurrence, icsWeekdayName,
  type IcsEventPreview, type IcsTime,
} from "@trafficflow/core/ics";
import "./ics-event-card.css";
import { liveCopy, activeFormatLocale, activeFormatZone } from "../shell/locale";

/**
 * THE ENGLISH SENTENCES — the fallback for the `icsEvent` namespace and the parity oracle for
 * it (`test/locale-shim-parity.test.ts` holds the two together). `liveCopy` and not the hook, for
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

/* ── what the card says: core's shared helpers, in this reader's words ─────────────────── */

const formatOpts = () => ({ locale: activeFormatLocale(), zone: activeFormatZone() });

/** The when-line (`formatIcsWhen`), in the reader's locale and zone. */
export function formatWhen(start: IcsTime, end: IcsTime | null): string {
  return formatIcsWhen(start, end, { ...formatOpts(), allDay: COPY.allDay });
}

/** "Weekly on Tuesday": words only where the rule is trivially true in words; else nothing. */
export function recurrenceLine(rec: IcsEventPreview["recurrence"]): string | null {
  const said = icsRecurrence(rec);
  if (!said) return null;
  const locale = activeFormatLocale();
  switch (said.key) {
    case "everyNDays":
    case "everyNWeeks":
    case "everyNMonths":
    case "everyNYears":
      return COPY[said.key](said.n);
    case "weeklyOn":
      return COPY.weeklyOn(said.days.map((d) => icsWeekdayName(d, locale)).join(", "));
    case "everyNWeeksOn":
      return COPY.everyNWeeksOn(said.n, said.days.map((d) => icsWeekdayName(d, locale)).join(", "));
    default:
      return COPY[said.key];
  }
}

/** One compact line of people: the replier, or the organizer with the invited count. Text, never a link. */
function peopleLine(ev: IcsEventPreview): string | null {
  const { who, invited } = icsPeople(ev);
  const count = invited !== null ? COPY.invited(invited) : null;
  if (who && count) return `${who} · ${count}`;
  return who ?? count;
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
  const k = icsKicker(event);
  const glyph = icsDateGlyph(event.start, formatOpts());
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
          {COPY[k.key]}
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
