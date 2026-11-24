/**
 * An invitee's answer as a calendar object (METHOD:REPLY, RFC 5546 section 3.2.3), and an answer
 * taken into the event it answers. This is the calendar's reply, for a server that schedules; the
 * reply as a letter is the mail side's to write, from the same identity.
 *
 * A reply repeats the identity it was sent and changes nothing else: the UID, the organizer, the
 * sequence number, the occurrence where one is answered, and exactly one invitee with the answer.
 * Taken in, it lands on the component that stands for what it answers and on no other: an answer to
 * one occurrence never changes the series.
 */
import { calendarOf, type CalObject } from "../ical/calendar.js";
import { componentsOf, propertiesOf, propertyOf, type Component, type Property } from "../ical/component.js";
import { ANSWER_PARAMS, withAnswer, withParam, type CalEvent, type PartStat } from "../ical/event.js";
import { paramOf } from "../ical/lines.js";
import { escapeText, timeProperty } from "../ical/values.js";
import { DEFAULT_LIMITS, type Limits } from "../limits.js";
import { recurrenceKeyOf, recurrenceKeyString } from "../recur/key.js";
import { changedOccurrence } from "../recur/occurrence.js";
import { occurrenceOf, type Series } from "../recur/series.js";
import type { EventTime, Instant, ZoneSource } from "../time/types.js";
import { onSteps } from "../time/zones.js";
import { replyStanding } from "./order.js";

export type ReplyAnswer = "ACCEPTED" | "DECLINED" | "TENTATIVE";
export type ReplyRefusal = "not_a_request" | "no_event" | "no_uid" | "no_organizer" | "not_invited";

export interface ReplyOptions {
  /** The reply's own stamp, handed in: this package reads no clock. */
  readonly dtstamp: Instant;
  /** The product's identifier for the PRODID line. */
  readonly prodid: string;
  /** Answer this one occurrence of a repeating event: its start as the series has it, as a clock time in its zone or as the instant. */
  readonly occurrence?: EventTime;
  readonly comment?: string;
  /** The steps finding that occurrence may cost (`maxSteps`): the invitation's own zone definitions are read to tell its changed days apart. */
  readonly limits?: Limits;
}

export type ReplyResult = { readonly ok: true; readonly reply: CalObject } | { readonly ok: false; readonly reason: ReplyRefusal };

const line = (name: string, value: string): Property => ({ name, params: [], value });

/**
 * The answer of the invitee with this mail address to an invitation. Refused by word when the
 * calendar is a message of another kind, holds no event, or the event has no UID or no organizer;
 * and when nobody on the event has the address: a forwarded invitation is not this person's to
 * answer.
 *
 * With `options.occurrence` the answer is to that one occurrence. Where the invitation carries a
 * component of its own for it (a changed day), that component is what is answered, with its version
 * and its guests: it is found by which occurrence it is, not by how its id is written, so an id in
 * UTC and a start named on the series' clock meet. The zone source is what makes them meet, and is
 * the one the invitation is otherwise read with. It is asked on one allowance of steps
 * (`options.limits`): a changed day in a zone whose definition the steps no longer cover is told
 * by how its id is written.
 */
export function replyFor(request: CalObject, attendee: string, answer: ReplyAnswer, options: ReplyOptions, zones: ZoneSource): ReplyResult {
  if (request.method !== null && request.method !== "REQUEST") return { ok: false, reason: "not_a_request" };
  const occurrence = options.occurrence;
  const asked = onSteps(zones, { steps: (options.limits ?? DEFAULT_LIMITS).maxSteps });
  const wanted = occurrence === undefined ? null : recurrenceKeyString(recurrenceKeyOf(occurrence, asked));
  const isFor = (e: CalEvent): boolean => wanted !== null && e.recurrenceId !== null && recurrenceKeyString(recurrenceKeyOf(e.recurrenceId, asked)) === wanted;
  const event = request.events.find(isFor) ?? request.events.find((e) => e.recurrenceId === null) ?? (occurrence === undefined ? request.events[0] : undefined);
  if (event === undefined) return { ok: false, reason: "no_event" };
  const from = event.component;
  const [uid, organizer] = [propertyOf(from, "UID"), propertyOf(from, "ORGANIZER")];
  if (uid === null || event.uid === null) return { ok: false, reason: "no_uid" };
  if (organizer === null) return { ok: false, reason: "no_organizer" };
  const address = attendee.trim().toLowerCase();
  const invitee = event.attendees.find((a) => a.email === address);
  if (invitee === undefined) return { ok: false, reason: "not_invited" };

  // The invitee's own line with the answer; what an organizer noted of earlier answers is the organizer's and stays there.
  const own = ["RSVP", ...ANSWER_PARAMS].reduce((p, name) => withParam(p, name, null), withParam(invitee.property, "PARTSTAT", [answer]));
  const properties: Property[] = [uid, timeProperty("DTSTAMP", options.dtstamp), organizer, own];
  const sequence = propertyOf(from, "SEQUENCE");
  if (sequence !== null) properties.push(sequence);
  if (occurrence === undefined || isFor(event)) {
    // The event as it stands is what is answered: its own times and title go along, as the big writers send them.
    for (const name of ["RECURRENCE-ID", "DTSTART", "DTEND", "DURATION", "SUMMARY"]) properties.push(...propertiesOf(from, name).slice(0, 1));
  } else {
    properties.push(timeProperty("RECURRENCE-ID", occurrence));
  }
  if (options.comment !== undefined) properties.push(line("COMMENT", escapeText(options.comment)));

  const named = new Set(properties.flatMap((p) => paramOf(p, "TZID") ?? []));
  const definitions = componentsOf(request.tree, "VTIMEZONE").filter((z) => named.has(propertyOf(z, "TZID")?.value.trim() ?? ""));
  const reply: Component = { name: "VEVENT", properties, components: [] };
  const tree: Component = { name: "VCALENDAR", properties: [line("VERSION", "2.0"), line("PRODID", options.prodid), line("METHOD", "REPLY")], components: [...definitions, reply] };
  return { ok: true, reply: calendarOf(tree) };
}

const ANSWERS: readonly string[] = ["NEEDS-ACTION", "ACCEPTED", "DECLINED", "TENTATIVE", "DELEGATED"];

/**
 * Why an answer was not taken in. `no_answer`: it names no invitee by mail address, or carries no
 * answer. `nothing_held`: no series, another event's, or a series with nothing for what is answered.
 * `no_such_occurrence`: it names a day the series does not have. `range_mismatch`: it names one
 * occurrence where a component for "this and every later one" stands, or such a range where none
 * does. `stale`, `ahead`: `replyStanding`. `not_invited`: the invitee is not on the component.
 */
export type ApplyRefusal = "no_answer" | "nothing_held" | "no_such_occurrence" | "range_mismatch" | "stale" | "ahead" | "not_invited";

/**
 * `event` is the component with the answer on it. `replaces` is the held component it takes the
 * place of (`withEvent`), or `null` when it is a new one to hold beside the series (`withNewEvent`):
 * an answer to an occurrence that had no component of its own until now.
 */
export type AppliedReply = { readonly ok: true; readonly event: CalEvent; readonly replaces: CalEvent | null } | { readonly ok: false; readonly reason: ApplyRefusal };

/**
 * A reply's answer taken into the series it answers. An answer to the series lands on the series'
 * component. An answer to one occurrence lands on that occurrence's own component: the one held for
 * it, or a new one made from the series for that day alone (`changedOccurrence`), so that the other
 * days stay as they were. In both the invitee's line gets the answer and a note of the version it
 * answered and its stamp; no other line changes.
 *
 * Refused by word (`ApplyRefusal`), and nothing changes: an answer that is not to the version held,
 * or that is older than the invitee's last one to the same component (RFC 5546 section 2.1.5: an
 * organizer keeps each invitee's last sequence and stamp and discards an earlier answer that arrives
 * late); an answer from somebody who is not on the component, since such a guest is the organizer's
 * to decide on. The zone source must be the one the series was grouped with.
 */
export function applyReply(series: Series | null, reply: CalEvent, zones: ZoneSource, limits: Limits = DEFAULT_LIMITS): AppliedReply {
  const refused = (reason: ApplyRefusal): AppliedReply => ({ ok: false, reason });
  const invitee = reply.attendees[0];
  if (invitee === undefined || invitee.email === null || invitee.partstat === null || !ANSWERS.includes(invitee.partstat)) return refused("no_answer");
  if (series === null || reply.uid === null || reply.uid !== series.uid) return refused("nothing_held");

  let base: CalEvent;
  let replaces: CalEvent | null;
  if (reply.recurrenceId === null) {
    if (series.master === null) return refused("nothing_held");
    [base, replaces] = [series.master, series.master];
  } else {
    const own = series.overrides.get(recurrenceKeyString(recurrenceKeyOf(reply.recurrenceId, zones))) ?? null;
    if (own !== null) {
      if (own.thisAndFuture !== reply.thisAndFuture) return refused("range_mismatch");
      [base, replaces] = [own, own];
    } else {
      if (reply.thisAndFuture) return refused("range_mismatch");
      if (series.master === null) return refused("nothing_held");
      const occurrence = occurrenceOf(series, reply.recurrenceId, zones, limits);
      if (occurrence === null) return refused("no_such_occurrence");
      [base, replaces] = [changedOccurrence(occurrence, zones), null];
    }
  }

  const standing = replyStanding(reply, base);
  if (standing !== "current") return refused(standing);
  const event = withAnswer(base, invitee.email, invitee.partstat as PartStat, { sequence: reply.sequence ?? 0, dtstamp: reply.dtstamp });
  return event === null ? refused("not_invited") : { ok: true, event, replaces };
}
