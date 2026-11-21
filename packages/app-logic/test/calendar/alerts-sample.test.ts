/**
 * THE CALENDAR AS THE NOTICES' GATE COMPARES IT: what the sample holds of the presented calendar, and the gate over
 * several sync turns, as the one caller takes them. Never the person's own change: a move, an answer or an edit of
 * theirs is told at no turn, neither while it waits nor when the calendar's echo of it arrives.
 */
import { describe, expect, it } from "vitest";
import { intlZones } from "@ohmail/cal-core";
import {
  NOTICE_KINDS,
  decideNotices,
  noticeChoicesOf,
  type CalendarSample,
  type Notice,
  type NoticeSample,
} from "@ohmail/client-engine";
import { eventsWithWrites, type DeviceAct, type EventWithWrites } from "@ohmail/client-engine/calendar-acts";
import type { CalendarEventAct, CalendarEventRecord, CalendarSuggestionRecord } from "@ohmail/wire";
import { calendarLookOf, calendarReadsOf, calendarSampleOf } from "../../src/calendar/alerts/index.js";
import { OWN, UPDATED, ZURICH, calendarOf, event, invitation, suggestion } from "./invitations/fixtures.js";

const zones = intlZones();
/** Monday 16 November 2026, 09:00 in Zurich. */
const NOW = Date.UTC(2026, 10, 16, 8, 0);
const ON = {
  ...noticeChoicesOf(null, null, { ohcalPhone: false }),
  cal_invitation: true,
  cal_change: true,
  cal_answer: true,
  cal_found: true,
};

const held = (record: CalendarEventRecord): EventWithWrites => ({
  record,
  waiting: null,
  refusal: null,
  refusedWriteId: null,
});
/** The calendar as the person sees it with `acts` of this device still waiting. */
const pressed = (records: readonly CalendarEventRecord[], ...acts: CalendarEventAct[]): EventWithWrites[] =>
  eventsWithWrites(
    records,
    acts.map((act, i): DeviceAct => ({ key: `k-${i}`, act })),
  );
const zurich = (day: string, clock: string) => ({
  kind: "zoned" as const,
  value: `${day}T${clock}`,
  zone: ZURICH,
});
const moveTo = (r: CalendarEventRecord, day: string, clock: string): CalendarEventAct => ({
  kind: "calendar_event_update",
  eventId: r.id,
  base: r.updatedAt,
  scope: { kind: "record" },
  change: {
    start: zurich(day, clock),
    end: zurich(day, `${String(Number(clock.slice(0, 2)) + 1).padStart(2, "0")}0000`),
  },
});
/** A write the calendar has not taken yet: the server's mark on the record. */
const pending = (r: CalendarEventRecord, act: CalendarEventAct): CalendarEventRecord => ({
  ...r,
  writes: [{ id: "w-1", key: "k-0", state: "pending", reason: null, act, part: null, at: UPDATED }],
});

function sampleOf(
  events: readonly EventWithWrites[],
  before: CalendarSample | null,
  suggestions: CalendarSuggestionRecord[] = [],
) {
  return calendarSampleOf(
    { events, calendars: [calendarOf()], suggestions, ownAddresses: [OWN], zone: ZURICH, zones },
    before,
  );
}

/** Sync turns as the one caller takes them: at each, the sample over the one before, then the gate. */
function turns(...worlds: (readonly EventWithWrites[])[]): Notice[][] {
  let before: NoticeSample | null = null;
  return worlds.map((events) => {
    const after: NoticeSample = {
      ohboxUnread: 0,
      screenerWaiting: 0,
      sends: new Map(),
      devices: null,
      calendar: sampleOf(events, before?.calendar ?? null),
    };
    const look = calendarLookOf({ events, suggestions: [], zone: ZURICH, zones, nowMs: NOW });
    const said = decideNotices(before, after, ON, "granted", NOTICE_KINDS, look);
    before = after;
    return said;
  });
}
const kinds = (said: Notice[][]) =>
  said.map((one) => one.map((n) => (n.kind === "cal_change" ? `${n.kind}:${n.change}` : n.kind)));

describe("what the sample holds of the calendar", () => {
  it("keeps sentence findings out of calendar notifications", () => {
    const reads = calendarReadsOf({
      liveScope: () => "calendar-account",
      ownAddresses: () => [OWN],
      suggestions: () => [
        suggestion("exact", "data"),
        suggestion("rules", "sentence"),
        suggestion("model", "sentence_model"),
      ],
      events: () => [],
      calendars: () => [calendarOf()],
      zone: () => ZURICH,
      zones,
      showTitles: () => true,
      acts: [],
    });

    const after = reads.changes(null, NOW);
    expect(after?.sample.found).toEqual(new Set(["exact"]));
    expect(after?.look.found("rules")).toBeNull();
    expect(after?.look.found("model")).toBeNull();
  });

  it("ids and instants for invitations, events the person is in, their own events' answers and what letters propose", () => {
    const records = [
      invitation("waits", "20261118"),
      invitation("answered", "20261119", { myAnswer: "accepted" }),
      event("mine", "20261120", {
        organizer: { address: OWN, name: null },
        invitees: [
          { address: "ADA@studio.test", name: null, role: "chair", answer: "accepted" },
          { address: "jo@elsewhere.test", name: "Jo", role: "required", answer: "accepted" },
          { address: "sam@elsewhere.test", name: null, role: "required", answer: "tentative" },
        ],
      }),
      event("shared", "20261120", { organizer: { address: "marco@elsewhere.test", name: "Marco" } }),
      invitation("held", "20261118", { heldBack: true }),
      invitation("hidden", "20261118", { calendarId: "cal-2" }),
      invitation("far", "20261118", {
        start: { kind: "zoned", value: "20261118T090000", zone: "Mars/Olympus" },
        end: { kind: "zoned", value: "20261118T093000", zone: "Mars/Olympus" },
      }),
    ];
    const s = calendarSampleOf(
      {
        events: records.map(held),
        calendars: [calendarOf(), calendarOf({ id: "cal-2", shown: false })],
        suggestions: [suggestion("s-1", "ticket")],
        ownAddresses: [OWN],
        zone: ZURICH,
        zones,
      },
      null,
    );
    expect([...s.invitations]).toEqual(["waits", "far"]);
    expect([...s.standing]).toEqual([
      ["waits", { startMs: Date.UTC(2026, 10, 18, 8, 0), status: "confirmed" }],
      ["answered", { startMs: Date.UTC(2026, 10, 19, 8, 0), status: "confirmed" }],
    ]);
    expect([...s.answers]).toEqual([["mine", [1, 1, 0]]]);
    expect([...s.found]).toEqual(["s-1"]);
  });
});

describe("the gate over sync turns: never the person's own change", () => {
  it.each(["date", "floating"] as const)(
    "travelling preserves a %s start and compares actual moves on the current clock",
    (kind) => {
      const value = (day: string) => (kind === "date" ? day : day + "T090000");
      const turn = (zone: string, day: string, previous: NoticeSample | null) => {
        const record = invitation("meeting", day, { start: { kind, value: value(day) } });
        const events = [held(record)];
        const input = {
          events,
          calendars: [calendarOf()],
          suggestions: [],
          ownAddresses: [OWN],
          zone,
          zones,
        };
        const calendar = calendarSampleOf(input, previous?.calendar ?? null);
        const after = { ohboxUnread: 0, screenerWaiting: 0, sends: new Map(), devices: null, calendar };
        const look = calendarLookOf({ ...input, nowMs: NOW });
        return { after, notices: decideNotices(previous, after, ON, "granted", NOTICE_KINDS, look) };
      };
      const first = turn(ZURICH, "20261118", null);
      expect(turn("Asia/Tokyo", "20261118", first.after).notices).toEqual([]);
      const moved = turn("Asia/Tokyo", "20261119", first.after).notices;
      const hour = kind === "date" ? 0 : 9;
      expect(moved).toMatchObject([
        { change: "moved", at: { hour, day: { dom: 19 } }, was: { hour, day: { dom: 18 } } },
      ]);
    },
  );

  it("their move: nothing at the press, nothing while the calendar takes it, nothing at its echo; the organizer's next move is told", () => {
    const at9 = invitation("crit", "20261118", { myAnswer: "accepted" });
    const move = moveTo(at9, "20261118", "110000");
    const at11 = { ...at9, start: zurich("20261118", "110000"), end: zurich("20261118", "120000") };
    const at15 = { ...at9, start: zurich("20261118", "150000"), end: zurich("20261118", "160000") };
    const said = turns(
      [held(at9)],
      pressed([at9], move),
      pressed([pending(at9, move)]),
      [held(at11)],
      [held(at15)],
    );
    expect(kinds(said)).toEqual([[], [], [], [], ["cal_change:moved"]]);
    expect(said[4]![0]).toMatchObject({
      eventId: "crit",
      at: { hour: 15, minute: 0, day: { month: 11, dom: 18, dow: 3 } },
      was: { hour: 11, minute: 0, day: { month: 11, dom: 18, dow: 3 } },
    });
  });

  it("their answer: the invitation leaves the list and nothing is told while it waits or when it lands", () => {
    const waits = invitation("inv", "20261118");
    const answer: CalendarEventAct = {
      kind: "calendar_event_answer",
      eventId: "inv",
      base: UPDATED,
      scope: { kind: "record" },
      answer: "accepted",
    };
    const said = turns([held(waits)], pressed([waits], answer), pressed([pending(waits, answer)]), [
      held({ ...waits, myAnswer: "accepted" }),
    ]);
    expect(kinds(said)).toEqual([[], [], [], []]);
  });

  it("their edit of their own event: no answer is told while it waits; the next answer after it is", () => {
    const invitees = (yes: number) =>
      Array.from({ length: 3 }, (_, i) => ({
        address: `guest${i}@elsewhere.test`,
        name: null,
        role: "required" as const,
        answer: i < yes ? ("accepted" as const) : ("none" as const),
      }));
    const own = (yes: number) =>
      event("own", "20261120", { organizer: { address: OWN, name: null }, invitees: invitees(yes) });
    const retitle: CalendarEventAct = {
      kind: "calendar_event_update",
      eventId: "own",
      base: UPDATED,
      scope: { kind: "record" },
      change: { title: "Studio day, moved rooms" },
    };
    const said = turns([held(own(1))], pressed([own(2)], retitle), [held(own(2))], [held(own(3))]);
    expect(kinds(said)).toEqual([[], [], [], ["cal_answer"]]);
    expect(said[3]![0]).toMatchObject({ answer: "yes", count: 1 });
  });

  it("an invitation held back, then let in: one notice, at the letting in", () => {
    const back = invitation("let", "20261118", { heldBack: true });
    const said = turns(
      [held(back)],
      [held(back)],
      [held({ ...back, heldBack: false })],
      [held({ ...back, heldBack: false })],
    );
    expect(kinds(said)).toEqual([[], [], ["cal_invitation"], []]);
  });

  it("an account's first sample with a write already waiting keeps its invitation where the person sees it", () => {
    const waits = invitation("inv", "20261118", { alarms: [] });
    const alarm: CalendarEventAct = {
      kind: "calendar_event_update",
      eventId: "inv",
      base: UPDATED,
      scope: { kind: "record" },
      change: { alarms: [10] },
    };
    const said = turns(pressed([waits], alarm), [held(waits)]);
    expect(kinds(said), "an invitation the person already had was told as new").toEqual([[], []]);
  });

  it("a cancellation and a new invitation of somebody else's are told, each once", () => {
    const one = invitation("one", "20261118", { myAnswer: "accepted" });
    const said = turns(
      [held(one)],
      [held({ ...one, status: "cancelled" }), held(invitation("two", "20261119"))],
      [held({ ...one, status: "cancelled" }), held(invitation("two", "20261119"))],
    );
    expect(kinds(said)).toEqual([[], ["cal_invitation", "cal_change:cancelled"], []]);
  });
});

describe("what the gate looks up to name an event", () => {
  it("the event's own words for its label, whether it is a whole day, a proposal's start, a start on the reader's clock", () => {
    const records = [
      event("doc", "20261118", { title: "Doctor", private: true }),
      event("fair", "20261118", {
        start: { kind: "date", value: "20261118" },
        end: { kind: "date", value: "20261119" },
      }),
    ];
    const look = calendarLookOf({
      events: records.map(held),
      suggestions: [suggestion("s-1", "ticket")],
      zone: ZURICH,
      zones,
      nowMs: NOW,
    });
    expect(look.event("doc")).toEqual({
      noticed: { id: "doc", title: "Doctor", private: true, heldBack: false },
      allDay: false,
    });
    expect(look.event("fair")?.allDay).toBe(true);
    expect(look.event("gone")).toBeNull();
    expect(look.found("s-1")).toBe(Date.UTC(2026, 10, 20, 18, 0));
    expect(look.found("gone")).toBeNull();
    expect(look.clock(Date.UTC(2026, 10, 17, 8, 30))).toEqual({ hour: 9, minute: 30, day: "tomorrow" });
  });
});
