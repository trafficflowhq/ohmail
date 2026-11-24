/**
 * Invitation messages: what a message is, where it departs from its method's table, which of two
 * versions is newer, what a message is about, and an answer written and taken in.
 */
import { describe, expect, it } from "vitest";
import { readCalendar, withEvent, withNewEvent, writeCalendar, zonesOf, type CalObject } from "../src/ical/calendar.js";
import { withSequence, type CalEvent } from "../src/ical/event.js";
import { unfold } from "../src/ical/lines.js";
import { targetOf } from "../src/itip/match.js";
import { EVENT_PRESENCE, ITIP_METHODS, messageFaults, methodOf } from "../src/itip/methods.js";
import { compareVersions, isStaleReply, replyStanding, versionStanding } from "../src/itip/order.js";
import { applyReply, replyFor } from "../src/itip/reply.js";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { expandSeries, seriesOf } from "../src/recur/series.js";
import { instant, wall, zoned, type ZoneSource } from "../src/time/types.js";
import { intlZones } from "../src/time/zones.js";
import { radicale_wheel_class } from "./corpus/bench.js";
import { apple_reply, exchange_counter, exchange_request, google_cancel, google_export, google_request } from "./corpus/providers.js";
import type { Fixture } from "./corpus/types.js";
import { at, oneEvent, text, textOf } from "./support.js";

const platform = intlZones();
const STAMP = instant(at("2026-11-13T14:30:00Z"));

function read(source: Fixture | string): CalObject {
  const result = readCalendar(typeof source === "string" ? source : text(source), DEFAULT_LIMITS);
  if (!result.ok) throw new Error(`not read: ${result.reason}`);
  return result.calendar;
}
const write = (calendar: CalObject): string => textOf(writeCalendar(calendar));
/** A message of one event: the method, then the event's lines after the UID and the stamp `oneEvent` writes. */
const message = (method: string, lines: readonly string[]): CalObject => read(oneEvent(lines, [`METHOD:${method}`]));
const ORGANIZER = "ORGANIZER:mailto:giulia.ferrari@lichtgrat.example";
const MILA_AT = "mila.brunner@atelier.example";
const MILA = `ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${MILA_AT}`;
const RETO = "ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:reto.frei@atelier.example";
const PETRA = "ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:petra.wyss@lichtgrat.example";

/*
 * "Wheel class" as an invitation: Tuesdays 18:00 to 20:00 in Zurich, six times from 17 November 2026
 * (the 17th and 24th, 1, 8, 15 and 22 December; winter time, 17:00 UTC), Mila and Reto invited.
 * `MOVED` is its third day held on Wednesday the 2nd at 19:00 instead, with one more guest and a
 * version of its own.
 */
const WHEEL = (sequence: number): string[] => [
  "BEGIN:VEVENT", "UID:wheel@lichtgrat.example", "DTSTAMP:20261110T090000Z", "DTSTART;TZID=Europe/Zurich:20261117T180000", "DTEND;TZID=Europe/Zurich:20261117T200000",
  "RRULE:FREQ=WEEKLY;COUNT=6", "SUMMARY:Wheel class", ORGANIZER, MILA, RETO, `SEQUENCE:${sequence}`, "END:VEVENT",
];
const MOVED = (id: string): string[] => [
  "BEGIN:VEVENT", "UID:wheel@lichtgrat.example", "DTSTAMP:20261112T090000Z", id, "DTSTART;TZID=Europe/Zurich:20261202T190000", "DTEND;TZID=Europe/Zurich:20261202T210000",
  "SUMMARY:Wheel class (moved)", ORGANIZER, MILA, PETRA, "SEQUENCE:3", "END:VEVENT",
];
const calendar = (events: readonly string[], method?: string): CalObject =>
  read(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//corpus//EN", ...(method ? [`METHOD:${method}`] : []), ...events, "END:VCALENDAR", ""].join("\r\n"));
const tuesday = (month: number, day: number) => zoned(wall(2026, month, day, 18, 0), "Europe/Zurich");

describe("what a message is", () => {
  it("knows the eight methods and nothing else as one", () => {
    expect([google_export, google_request, google_cancel, apple_reply, exchange_counter].map((f) => methodOf(read(f)))).toEqual(["PUBLISH", "REQUEST", "CANCEL", "REPLY", "COUNTER"]);
    expect(methodOf(read(radicale_wheel_class))).toBeNull();
    expect(methodOf(message("FORWARD", ["DTSTART:20261125T150000Z"]))).toBeNull();
    expect(Object.keys(EVENT_PRESENCE)).toEqual([...ITIP_METHODS]);
  });

  it("finds the big writers' messages in order", () => {
    for (const f of [google_request, google_cancel, apple_reply, exchange_request, exchange_counter]) expect(messageFaults(read(f)), f.name).toEqual([]);
    expect(messageFaults(read(radicale_wheel_class))).toBeNull();
  });

  it("reports what a method's table asks for and does not get", () => {
    const faults = (method: string, lines: readonly string[]) => messageFaults(message(method, lines))!.map((f) => `${f.property} ${f.fault}`);
    expect(faults("REQUEST", ["DTSTART:20261125T150000Z", "SUMMARY:x", ORGANIZER])).toEqual(["ATTENDEE missing"]);
    expect(faults("REQUEST", [MILA])).toEqual(["DTSTART missing", "ORGANIZER missing", "SUMMARY missing"]);
    expect(faults("REPLY", [ORGANIZER, MILA, "ATTENDEE:mailto:reto.frei@atelier.example"])).toEqual(["ATTENDEE repeated"]);
    expect(faults("REFRESH", [ORGANIZER, MILA, "DTSTART:20261125T150000Z", "SEQUENCE:2"])).toEqual(["DTSTART forbidden", "SEQUENCE forbidden"]);
    expect(faults("CANCEL", [ORGANIZER])).toEqual(["SEQUENCE missing"]);
    expect(faults("ADD", ["DTSTART:20261125T150000Z", "SUMMARY:x", ORGANIZER, "SEQUENCE:1", "RECURRENCE-ID:20261125T150000Z"])).toEqual(["RECURRENCE-ID forbidden"]);
    // A published calendar that lists invitees departs from the table, and is common: it is reported, not refused.
    expect(new Set(messageFaults(read(google_export))!.map((f) => `${f.property} ${f.fault}`))).toEqual(new Set(["ATTENDEE forbidden", "ORGANIZER missing"]));
    const two = read(oneEvent(["DTSTART:20261125T150000Z", "SUMMARY:x", ORGANIZER, "SEQUENCE:1", "END:VEVENT", "BEGIN:VEVENT", "UID:corpus-1@atelier.example", "DTSTAMP:20261113T120000Z", "DTSTART:20261126T150000Z", "SUMMARY:y", ORGANIZER, "SEQUENCE:1"], ["METHOD:ADD"]));
    expect(messageFaults(two)).toEqual([{ uid: null, property: "VEVENT", fault: "repeated" }]);
  });
});

describe("which version is newer", () => {
  const version = (sequence: string | null, stamp: string | null) =>
    read(["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:v", ...(stamp ? [`DTSTAMP:${stamp}`] : []), ...(sequence ? [`SEQUENCE:${sequence}`] : []), "END:VEVENT", "END:VCALENDAR", ""].join("\r\n")).events[0]!;

  it("goes by the sequence number, then by the stamp", () => {
    expect(compareVersions(version("2", "20261113T120000Z"), version("1", "20261114T120000Z"))).toBe(1);
    expect(compareVersions(version("1", "20261113T120000Z"), version("1", "20261114T120000Z"))).toBe(-1);
    expect(compareVersions(version(null, "20261113T120000Z"), version("0", "20261113T120000Z"))).toBe(0);
    expect(compareVersions(version("1", null), version("1", "20261113T120000Z"))).toBe(-1);
    // The cancellation of the kiln handover (sequence 1) is newer than its invitation (sequence 0).
    expect(compareVersions(read(google_cancel).events[0]!, read(google_request).events[0]!)).toBe(1);
  });

  it("says whether an answer is to the version held", () => {
    const [request, reply] = [read(google_request).events[0]!, read(apple_reply).events[0]!];
    expect(replyStanding(reply, request)).toBe("current");
    expect(replyStanding(reply, version("2", null))).toBe("stale");
    expect(isStaleReply(reply, version("2", null))).toBe(true);
    expect(replyStanding(version("3", null), version("2", null))).toBe("ahead");
    expect(isStaleReply(version("3", null), version("2", null))).toBe(false);
    expect([versionStanding(reply, request), versionStanding(reply, version("2", null)), versionStanding(version("3", null), version("2", null))]).toEqual(["current", "stale", "ahead"]);
  });
});

describe("what a message is about", () => {
  const stored = read(radicale_wheel_class);
  const zones = zonesOf(stored, platform);
  const [series] = seriesOf(stored.events, zones);
  const about = (lines: readonly string[]) => targetOf(message("REPLY", lines).events[0]!, series!, zones);

  it("the series, one occurrence, or one and every later one", () => {
    expect(about([])).toEqual({ scope: "series", key: null, held: series!.master });
    // The occurrence that was moved is held as its own component; one that was not is held by the series.
    const moved = about(["RECURRENCE-ID;TZID=Europe/Zurich:20261201T180000"]);
    expect(moved).toMatchObject({ scope: "occurrence", key: { kind: "instant", epochMs: at("2026-12-01T17:00:00Z") } });
    expect(moved.held?.recurrenceId).not.toBeNull();
    expect(about(["RECURRENCE-ID:20261201T170000Z"]).held).toBe(moved.held);
    expect(about(["RECURRENCE-ID;TZID=Europe/Zurich:20261124T180000"]).held).toBe(series!.master);
    expect(about(["RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Zurich:20261208T180000"]).scope).toBe("thisAndFuture");
    expect(targetOf(message("REPLY", ["RECURRENCE-ID:20261201T170000Z"]).events[0]!, null, zones).held).toBeNull();
  });
});

describe("an answer", () => {
  const options = { dtstamp: STAMP, prodid: "-//ohmail//test//EN" };

  it("repeats the invitation's identity and carries exactly one invitee, with the answer", () => {
    const result = replyFor(read(google_request), " Mila.Brunner@atelier.example ", "ACCEPTED", options, platform);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(unfold(write(result.reply))).toEqual([
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//test//EN", "METHOD:REPLY", "BEGIN:VEVENT",
      "UID:4k8m2p6r0t4v8x2z6b0d4f8h2j@google.example", "DTSTAMP:20261113T143000Z", "ORGANIZER;CN=Giulia Ferrari:mailto:giulia.ferrari@lichtgrat.example",
      "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=mila.brunner@atelier.example;X-NUM-GUESTS=0:mailto:mila.brunner@atelier.example",
      "SEQUENCE:0", "DTSTART:20261125T150000Z", "DTEND:20261125T153000Z", "SUMMARY:Kiln handover", "END:VEVENT", "END:VCALENDAR",
    ]);
    expect(messageFaults(result.reply)).toEqual([]);
    expect(replyStanding(result.reply.events[0]!, read(google_request).events[0]!)).toBe("current");
  });

  it("takes the zone definition along when the event's times name a zone", () => {
    const result = replyFor(read(exchange_request), MILA_AT, "TENTATIVE", { ...options, comment: "Only if the kiln is cool; else later." }, platform);
    expect(result.ok && result.reply.tree.components.map((c) => c.name)).toEqual(["VTIMEZONE", "VEVENT"]);
    expect(result.ok && result.reply.timezones.map((z) => z.tzid)).toEqual(["W. Europe Standard Time"]);
    expect(result.ok && unfold(write(result.reply))).toContain("COMMENT:Only if the kiln is cool\\; else later.");
    expect(result.ok && result.reply.events[0]!.attendees.map((a) => [a.email, a.partstat, a.rsvp])).toEqual([[MILA_AT, "TENTATIVE", false]]);
  });

  it("names the one occurrence it answers", () => {
    // An invitation to a weekly class: answering the 24 November one alone names it; answering a changed day uses that day's own component.
    const lines = text(radicale_wheel_class).replace(/SUMMARY:Wheel class\r\n/g, `SUMMARY:Wheel class\r\n${ORGANIZER}\r\n${MILA}\r\n`).replace("VERSION:2.0\r\n", "VERSION:2.0\r\nMETHOD:REQUEST\r\n");
    const request = read(lines);
    const one = replyFor(request, MILA_AT, "DECLINED", { ...options, occurrence: zoned(wall(2026, 11, 24, 18, 0), "Europe/Zurich") }, platform);
    expect(one.ok && unfold(write(one.reply)).filter((l) => /^(RECURRENCE-ID|DTSTART|METHOD|BEGIN:VTIMEZONE)/.test(l))).toEqual(["METHOD:REPLY", "BEGIN:VTIMEZONE", "DTSTART:19701025T030000", "DTSTART:19700329T020000", "RECURRENCE-ID;TZID=Europe/Zurich:20261124T180000"]);
    const changedDay = replyFor(request, MILA_AT, "ACCEPTED", { ...options, occurrence: zoned(wall(2026, 12, 1, 18, 0), "Europe/Zurich") }, platform);
    expect(changedDay.ok && changedDay.reply.events[0]).toMatchObject({ recurrenceId: zoned(wall(2026, 12, 1, 18, 0), "Europe/Zurich"), start: zoned(wall(2026, 12, 2, 19, 0), "Europe/Zurich") });
    const whole = replyFor(request, MILA_AT, "ACCEPTED", options, platform);
    expect(whole.ok && whole.reply.events[0]!.recurrenceId).toBeNull();
  });

  it("finds a changed day by which day it is, however its id and the day asked are written", () => {
    // 18:00 in Zurich on 1 December is 17:00 UTC: one occurrence, written two ways by the organizer and named two ways by the caller.
    const asked = [tuesday(12, 1), instant(at("2026-12-01T17:00:00Z"))];
    for (const id of ["RECURRENCE-ID;TZID=Europe/Zurich:20261201T180000", "RECURRENCE-ID:20261201T170000Z"]) {
      const request = calendar([...WHEEL(1), ...MOVED(id)], "REQUEST");
      for (const occurrence of asked) {
        for (const who of [MILA_AT, "petra.wyss@lichtgrat.example"]) {
          const result = replyFor(request, who, "ACCEPTED", { ...options, occurrence }, platform);
          // The answer is to the changed day: its version, its times, its title.
          expect(result.ok && result.reply.events[0], `${id}, asked as ${occurrence.kind}, ${who}`).toMatchObject({
            sequence: 3, summary: "Wheel class (moved)", start: zoned(wall(2026, 12, 2, 19, 0), "Europe/Zurich"), end: zoned(wall(2026, 12, 2, 21, 0), "Europe/Zurich"),
          });
        }
      }
    }
    // The guest of that one day is not invited to the others.
    const request = calendar([...WHEEL(1), ...MOVED("RECURRENCE-ID:20261201T170000Z")], "REQUEST");
    expect(replyFor(request, "petra.wyss@lichtgrat.example", "ACCEPTED", { ...options, occurrence: tuesday(12, 8) }, platform)).toEqual({ ok: false, reason: "not_invited" });
  });

  it("looks for the changed day on one allowance of steps", () => {
    // An invitation whose six changed days are each written in a zone only the letter defines, each definition a summer rule that ran for two
    // hundred years. Which changed day is asked about is told by its moment, so the definitions are read: on one allowance, as an expansion's are.
    const six = [0, 1, 2, 3, 4, 5];
    const zone = (k: number): string[] => [
      "BEGIN:VTIMEZONE", `TZID:Works ${k}`,
      "BEGIN:DAYLIGHT", "DTSTART:18000330T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU;UNTIL=19991231T000000Z", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "END:DAYLIGHT",
      "END:VTIMEZONE",
    ];
    const changed = (k: number): string[] => [
      "BEGIN:VEVENT", "UID:works@atelier.example", "DTSTAMP:20261113T120000Z", `RECURRENCE-ID;TZID=Works ${k}:2026010${k + 1}T090000`, `DTSTART;TZID=Works ${k}:2026010${k + 1}T100000`, ORGANIZER, MILA, "SEQUENCE:1", "END:VEVENT",
    ];
    const request = read(["BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", ...six.flatMap(zone), ...six.flatMap(changed), "END:VCALENDAR", ""].join("\r\n"));
    /** What the first question about a zone costs a source that has not read its definition, and nothing if it has. */
    const priceOf = (zones: ZoneSource, k: number): number => {
      const left = { steps: 1_000_000 };
      zones.offsetAt(`Works ${k}`, at("2026-01-01T00:00:00Z"), left);
      return 1_000_000 - left.steps;
    };
    const price = priceOf(zonesOf(request, platform), 0);
    expect(price).toBeGreaterThan(200 * 31);
    const sixth = zoned(wall(2026, 1, 6, 9, 0), "Works 5");
    // The day asked about is told first (the sixth zone is read), then the changed days in the order written: the first and the second
    // are read too, the third is given up part read, the fourth and fifth are not begun. The sixth is found by what was read already.
    const zones = zonesOf(request, platform);
    const result = replyFor(request, MILA_AT, "ACCEPTED", { ...options, occurrence: sixth, limits: { ...DEFAULT_LIMITS, maxSteps: 3 * price + 100 } }, zones);
    expect(result.ok && result.reply.events[0]).toMatchObject({ recurrenceId: sixth, start: zoned(wall(2026, 1, 6, 10, 0), "Works 5"), sequence: 1 });
    expect(six.map((k) => priceOf(zones, k))).toEqual([0, 0, price, price, price, 0]);
    // With the default allowance every definition on the way is read.
    const all = zonesOf(request, platform);
    expect(replyFor(request, MILA_AT, "ACCEPTED", { ...options, occurrence: sixth }, all).ok).toBe(true);
    expect(six.map((k) => priceOf(all, k))).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("is refused by word when it is not this person's to give", () => {
    const refusal = (request: CalObject, who = MILA_AT) => {
      const r = replyFor(request, who, "ACCEPTED", options, platform);
      return r.ok ? "written" : r.reason;
    };
    expect(refusal(read(google_request), "ben.arnold@lichtgrat.example")).toBe("not_invited");
    expect(refusal(read(google_cancel))).toBe("not_a_request");
    expect(refusal(message("REQUEST", [MILA]))).toBe("no_organizer");
    expect(refusal(read("BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n"))).toBe("no_event");
    expect(refusal(read(`BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\n${ORGANIZER}\r\n${MILA}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`))).toBe("no_uid");
  });
});

describe("an answer taken in", () => {
  const options = { dtstamp: STAMP, prodid: "-//ohmail//test//EN" };
  const window = { startMs: at("2026-11-01T00:00:00Z"), endMs: at("2027-02-01T00:00:00Z"), viewerZone: "Europe/Zurich" };
  const milaOn = (event: CalEvent) => event.attendees.find((a) => a.email === MILA_AT);
  /** Mila's answer on each occurrence of the class, in order. */
  const answersOf = (held: CalObject): (string | null | undefined)[] => expandSeries(seriesOf(held.events, platform)[0]!, window, platform).occurrences.map((o) => milaOn(o.event)?.partstat);
  /** A REPLY from Mila as another calendar sends it: stamped then, to that version, with these lines more. */
  const answer = (partstat: string, stamp: string, more: readonly string[] = [], sequence = 0): CalEvent =>
    calendar(["BEGIN:VEVENT", "UID:wheel@lichtgrat.example", `DTSTAMP:${stamp}`, ...more, ORGANIZER, `ATTENDEE;PARTSTAT=${partstat}:mailto:${MILA_AT}`, `SEQUENCE:${sequence}`, "END:VEVENT"], "REPLY").events[0]!;
  /** The held calendar after a reply: its component replaced, a new one added, or the word it was refused with. */
  const take = (held: CalObject, reply: CalEvent): { held: CalObject; outcome: string } => {
    const applied = applyReply(seriesOf(held.events, platform)[0] ?? null, reply, platform);
    if (!applied.ok) return { held, outcome: applied.reason };
    return applied.replaces === null ? { held: withNewEvent(held, applied.event), outcome: "added" } : { held: withEvent(held, applied.replaces, applied.event), outcome: "replaced" };
  };
  const NEEDS = "NEEDS-ACTION";

  it("changes the invitee's line and no other, and keeps the answer's version and stamp on it", () => {
    const request = read(google_request);
    const held = request.events[0]!;
    const applied = applyReply(seriesOf(request.events, platform)[0]!, read(apple_reply).events[0]!, platform);
    expect(applied.ok && applied.replaces).toBe(held);
    if (!applied.ok) return;
    expect(applied.event.attendees.map((a) => [a.email, a.partstat])).toEqual([["giulia.ferrari@lichtgrat.example", "ACCEPTED"], [MILA_AT, "ACCEPTED"]]);
    expect(applied.event.component.properties.filter((p, i) => p !== held.component.properties[i]).map((p) => p.name)).toEqual(["ATTENDEE"]);
    // Apple's reply was stamped 14:00 UTC on 13 November, to version 0.
    expect(applied.event.attendees.map((a) => a.answered)).toEqual([null, { sequence: 0, dtstamp: instant(at("2026-11-13T14:00:00Z")) }]);
    // What `replyFor` writes, `applyReply` reads.
    const written = replyFor(request, MILA_AT, "DECLINED", options, platform);
    const again = written.ok ? applyReply(seriesOf(request.events, platform)[0]!, written.reply.events[0]!, platform) : null;
    expect(again?.ok && milaOn(again.event)).toMatchObject({ partstat: "DECLINED", answered: { sequence: 0, dtstamp: STAMP } });
  });

  it("is refused by word when it answers nothing that is held, or another version", () => {
    const request = read(google_request);
    const [series] = seriesOf(request.events, platform);
    const uid = "UID:4k8m2p6r0t4v8x2z6b0d4f8h2j@google.example";
    const reply = (lines: readonly string[]): CalEvent => calendar(["BEGIN:VEVENT", uid, "DTSTAMP:20261113T140000Z", ORGANIZER, ...lines, "END:VEVENT"], "REPLY").events[0]!;
    const refusal = (r: CalEvent, of: typeof series | null = series) => {
      const applied = applyReply(of ?? null, r, platform);
      return applied.ok ? "taken" : applied.reason;
    };
    const accepted = `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${MILA_AT}`;
    expect(refusal(reply([accepted]))).toBe("taken");
    // An answer from somebody who was never invited changes nothing here: that guest is the organizer's to decide on.
    expect(refusal(reply(["ATTENDEE;PARTSTAT=ACCEPTED:mailto:reto.frei@atelier.example"]))).toBe("not_invited");
    expect(refusal(reply([`ATTENDEE:mailto:${MILA_AT}`]))).toBe("no_answer");
    expect(refusal(reply([]))).toBe("no_answer");
    expect(refusal(reply([accepted]), null)).toBe("nothing_held");
    expect(refusal(answer("ACCEPTED", "20261113T140000Z"))).toBe("nothing_held");
    // The event has moved on to version 2: an answer to version 0 answers another meeting, one to version 5 a meeting not yet held here.
    const [newer] = seriesOf([withSequence(request.events[0]!, 2)], platform);
    expect(refusal(reply([accepted]), newer)).toBe("stale");
    expect(refusal(reply([accepted, "SEQUENCE:5"]), newer)).toBe("ahead");
    expect(refusal(reply([accepted, "SEQUENCE:2"]), newer)).toBe("taken");
  });

  it("to one occurrence makes that occurrence a component of its own, and the series stays as it was", () => {
    const request = calendar(WHEEL(0), "REQUEST");
    const declined = replyFor(request, MILA_AT, "DECLINED", { ...options, occurrence: tuesday(11, 24) }, platform);
    if (!declined.ok) throw new Error(declined.reason);
    const before = calendar(WHEEL(0));
    expect(answersOf(before)).toEqual([NEEDS, NEEDS, NEEDS, NEEDS, NEEDS, NEEDS]);
    const taken = take(before, declined.reply.events[0]!);
    expect(taken.outcome).toBe("added");
    expect(answersOf(taken.held)).toEqual([NEEDS, "DECLINED", NEEDS, NEEDS, NEEDS, NEEDS]);
    // The series' own component is the one that was held; the new one is that day, with its times and without the rule.
    expect(taken.held.events[0]!.component).toBe(before.events[0]!.component);
    expect(taken.held.events[1]).toMatchObject({ recurrenceId: tuesday(11, 24), start: tuesday(11, 24), end: zoned(wall(2026, 11, 24, 20, 0), "Europe/Zurich"), rules: [], sequence: 0, summary: "Wheel class" });
    expect(taken.held.events[1]!.attendees.map((a) => a.partstat)).toEqual(["DECLINED", NEEDS]);
    // It reads back from text as it stands.
    expect(answersOf(read(write(taken.held)))).toEqual([NEEDS, "DECLINED", NEEDS, NEEDS, NEEDS, NEEDS]);
    // A later answer to the same day, naming it by its instant, lands on the component that now stands for it.
    const second = take(taken.held, answer("ACCEPTED", "20261114T090000Z", ["RECURRENCE-ID:20261124T170000Z"]));
    expect([second.outcome, second.held.events.length]).toEqual(["replaced", 2]);
    expect(answersOf(second.held)).toEqual([NEEDS, "ACCEPTED", NEEDS, NEEDS, NEEDS, NEEDS]);
    // A day the class does not have, and a day with every later one, are refused by word.
    expect(take(before, answer("DECLINED", "20261114T090000Z", ["RECURRENCE-ID;TZID=Europe/Zurich:20261125T180000"])).outcome).toBe("no_such_occurrence");
    expect(take(before, answer("DECLINED", "20261114T090000Z", ["RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Zurich:20261124T180000"])).outcome).toBe("range_mismatch");
    expect(take(taken.held, answer("DECLINED", "20261114T090000Z", ["RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Zurich:20261124T180000"])).outcome).toBe("range_mismatch");
  });

  it("to one occurrence is not measured against an answer to the series", () => {
    // Mila accepted the whole class at 12:00 and had declined the 24th alone at 11:00; the earlier one arrives last.
    const whole = take(calendar(WHEEL(0)), answer("ACCEPTED", "20261113T120000Z"));
    expect(whole.outcome).toBe("replaced");
    const both = take(whole.held, answer("DECLINED", "20261113T110000Z", ["RECURRENCE-ID;TZID=Europe/Zurich:20261124T180000"]));
    expect(both.outcome).toBe("added");
    expect(answersOf(both.held)).toEqual(["ACCEPTED", "DECLINED", "ACCEPTED", "ACCEPTED", "ACCEPTED", "ACCEPTED"]);
    // The day's own line records the answer to the day, and Reto's line on it nothing.
    expect(both.held.events[1]!.attendees.map((a) => a.answered)).toEqual([{ sequence: 0, dtstamp: instant(at("2026-11-13T11:00:00Z")) }, null]);
  });

  it("keeps an invitee's last word, whichever of two answers arrives first", () => {
    // Mila accepted at 10:00 and declined at 11:00, both to version 0 of an event that does not repeat.
    const accepted = answer("ACCEPTED", "20261113T100000Z");
    const declined = answer("DECLINED", "20261113T110000Z");
    const single = calendar(WHEEL(0).filter((l) => !l.startsWith("RRULE")));
    const inOrder = (replies: readonly CalEvent[]) => {
      let held = single;
      const outcomes: string[] = [];
      for (const reply of replies) {
        const taken = take(held, reply);
        held = taken.held;
        outcomes.push(taken.outcome);
      }
      return { held, outcomes, last: milaOn(held.events[0]!)?.partstat };
    };
    expect(inOrder([accepted, declined])).toMatchObject({ outcomes: ["replaced", "replaced"], last: "DECLINED" });
    const late = inOrder([declined, accepted]);
    expect(late).toMatchObject({ outcomes: ["replaced", "stale"], last: "DECLINED" });
    // The same answer delivered twice is no older than itself.
    expect(inOrder([declined, declined])).toMatchObject({ outcomes: ["replaced", "replaced"], last: "DECLINED" });
    // The record is on the invitee's own line, and it is what the standing is read from.
    expect(unfold(write(late.held)).filter((l) => l.includes(MILA_AT))).toEqual([`ATTENDEE;PARTSTAT=DECLINED;RSVP=TRUE;X-OHMAIL-REPLY-SEQUENCE=0;X-OHMAIL-REPLY-DTSTAMP=20261113T110000Z:mailto:${MILA_AT}`]);
    const held = read(write(late.held)).events[0]!;
    expect([replyStanding(accepted, held), replyStanding(declined, held), versionStanding(accepted, held)]).toEqual(["stale", "current", "current"]);
    // The organizer moves the event (version 1): an answer to version 1 is newer whatever its stamp, one to version 0 is to another meeting.
    const moved = withEvent(late.held, late.held.events[0]!, withSequence(late.held.events[0]!, 1));
    expect(take(moved, answer("ACCEPTED", "20261113T090000Z", [], 1))).toMatchObject({ outcome: "replaced" });
    expect(take(moved, answer("ACCEPTED", "20261113T230000Z")).outcome).toBe("stale");
  });

  it("is written without the organizer's own record of earlier answers", () => {
    // An invitation whose line for Mila carries what its organizer noted of her last answer: her next answer does not send it back.
    const request = calendar(WHEEL(0).map((l) => (l === MILA ? `ATTENDEE;PARTSTAT=DECLINED;RSVP=TRUE;X-OHMAIL-REPLY-SEQUENCE=0;X-OHMAIL-REPLY-DTSTAMP=20261113T110000Z:mailto:${MILA_AT}` : l)), "REQUEST");
    const reply = replyFor(request, MILA_AT, "ACCEPTED", options, platform);
    expect(reply.ok && unfold(write(reply.reply)).filter((l) => l.startsWith("ATTENDEE"))).toEqual([`ATTENDEE;PARTSTAT=ACCEPTED:mailto:${MILA_AT}`]);
  });
});
