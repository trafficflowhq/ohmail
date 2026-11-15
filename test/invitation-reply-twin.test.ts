import { describe, expect, it } from "vitest";
import { invitationReplyText, readLetterInvitation } from "@trafficflow/core/mail";
import { readCalendar, type CalObject } from "../packages/cal-core/src/ical/calendar";
import type { CalEvent } from "../packages/cal-core/src/ical/event";
import { messageFaults, methodOf } from "../packages/cal-core/src/itip/methods";
import { applyReply, replyFor } from "../packages/cal-core/src/itip/reply";
import { DEFAULT_LIMITS } from "../packages/cal-core/src/limits";
import { recurrenceKeyOf, recurrenceKeyString } from "../packages/cal-core/src/recur/key";
import { seriesOf } from "../packages/cal-core/src/recur/series";
import { instant } from "../packages/cal-core/src/time/types";
import { intlZones } from "../packages/cal-core/src/time/zones";
import { CORPUS } from "../packages/cal-core/test/corpus/index";
import { text } from "../packages/cal-core/test/support";

/**
 * TWO WRITERS OF ONE ANSWER. Mail writes the reply a press sends from the stored row alone (core's
 * `invitation-reply`, in the phone's engine); the calendar package writes a reply from the whole
 * request (`replyFor`) and takes one in (`applyReply`). They share no code, so this file is what
 * notices if they drift: for every invitation of the calendar's corpus, and for the occurrence
 * forms the corpus lacks, the letter's reply reads back as a message in order, names the same
 * event, occurrence, revision and invitee as the calendar's own, and is taken in by the series it
 * answers. The core package may not import the calendar's, so the comparison lives here.
 */
const platform = intlZones();
const STAMP = new Date("2026-11-15T09:30:00Z");

function calendarOf(source: string): CalObject {
  const read = readCalendar(source, DEFAULT_LIMITS);
  if (!read.ok) throw new Error(`not read: ${read.reason}`);
  return read.calendar;
}

const keyOf = (e: CalEvent): string => (e.recurrenceId === null ? "" : recurrenceKeyString(recurrenceKeyOf(e.recurrenceId, platform)));

/** An invitation of one event, for the occurrence forms the corpus has no request of. */
const request = (event: readonly string[]): string =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", "METHOD:REQUEST", "BEGIN:VEVENT", "DTSTAMP:20261110T090000Z",
    "SUMMARY:Wheel class", "ORGANIZER;CN=Giulia:mailto:giulia.ferrari@lichtgrat.example",
    "ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:mila.brunner@atelier.example", ...event, "END:VEVENT", "END:VCALENDAR"]
    .map((l) => `${l}\r\n`).join("");

const BUILT: ReadonlyArray<readonly [string, string]> = [
  ["one moved occurrence, its id on the zone's clock", request(["UID:wheel@lichtgrat.example", "SEQUENCE:3",
    "RECURRENCE-ID;TZID=Europe/Zurich:20261201T180000", "DTSTART;TZID=Europe/Zurich:20261202T190000", "DTEND;TZID=Europe/Zurich:20261202T210000"])],
  ["one occurrence named in UTC", request(["UID:wheel@lichtgrat.example", "SEQUENCE:1",
    "RECURRENCE-ID:20261208T170000Z", "DTSTART:20261208T170000Z", "DTEND:20261208T190000Z"])],
  ["a whole-day series", request(["UID:fair@lichtgrat.example", "SEQUENCE:2", "DTSTART;VALUE=DATE:20261205", "DTEND;VALUE=DATE:20261206"])],
  ["one occurrence of a whole-day series", request(["UID:fair@lichtgrat.example", "SEQUENCE:2",
    "RECURRENCE-ID;VALUE=DATE:20261212", "DTSTART;VALUE=DATE:20261213", "DTEND;VALUE=DATE:20261214"])],
  ["one occurrence of a floating series", request(["UID:standup@lichtgrat.example",
    "RECURRENCE-ID:20261208T090000", "DTSTART:20261208T093000", "DTEND:20261208T100000"])],
];

const INVITATIONS: ReadonlyArray<readonly [string, string]> = [
  ...CORPUS.map((f) => [f.name, text(f)] as const)
    .filter(([, t]) => readLetterInvitation([{ id: "1", contentType: "text/calendar", text: t }])?.method === "REQUEST"),
  ...BUILT,
];

describe("the reply a press sends, and the calendar's own", () => {
  it("the corpus holds invitations to answer", () => {
    expect(INVITATIONS.length).toBeGreaterThan(BUILT.length);
  });

  it.each(INVITATIONS)("%s", (_name, source) => {
    const invitation = readLetterInvitation([{ id: "1", contentType: "text/calendar; method=REQUEST", text: source }])!;
    const organizer = invitation.organizer!;
    const invitee = invitation.attendees.find((a) => a.toLowerCase() !== organizer.toLowerCase())!;
    const written = invitationReplyText({
      uid: invitation.uid, recurrenceId: invitation.recurrenceId, sequence: invitation.sequence,
      startRaw: invitation.startRaw, startsAt: invitation.startsAt, organizer, invitedAddress: invitee,
      answer: "declined", stamp: STAMP,
    });
    expect(written).not.toBeNull();
    const reply = calendarOf(written!);
    expect(methodOf(reply)).toBe("REPLY");
    expect(reply.events).toHaveLength(1);
    expect(messageFaults(reply)).toEqual([]);

    const asked = calendarOf(source);
    const theirs = replyFor(asked, invitee, "DECLINED", { dtstamp: instant(STAMP.getTime()), prodid: "-//test//EN" }, platform);
    expect(theirs.ok).toBe(true);
    if (!theirs.ok) return;
    const [ours, twin] = [reply.events[0]!, theirs.reply.events[0]!];
    expect(ours.uid).toBe(twin.uid);
    expect(ours.sequence ?? 0).toBe(twin.sequence ?? 0);
    expect(keyOf(ours)).toBe(keyOf(twin));
    expect(ours.dtstamp).toEqual(twin.dtstamp);
    expect(ours.organizer?.email).toBe(twin.organizer?.email);
    expect(ours.attendees.map((a) => [a.email, a.partstat])).toEqual(twin.attendees.map((a) => [a.email, a.partstat]));

    const [series] = seriesOf(asked.events, platform);
    expect(applyReply(series ?? null, ours, platform)).toMatchObject({ ok: true });
  });
});
