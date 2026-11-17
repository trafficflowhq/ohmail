/**
 * THE CALENDAR BESIDE MAIL: the rest of today beside the Ohbox, and what comes up with one person on their card. Both
 * are worked out from the occurrences the views draw: what has ended, what was cancelled or declined is left out,
 * and the times are the reader's clock.
 */
import { describe, expect, it } from "vitest";
import { intlZones } from "@ohmail/cal-core";
import type { CalendarEventRecord, CalendarRecord } from "@ohmail/wire";
import { dayOfIso, occurrencesIn, type ShownOccurrence } from "../../../src/calendar/index.js";
import { comingUpOf, todayRowsOf } from "../../../src/calendar/beside/index.js";

const ZURICH = "Europe/Zurich";
const ZONES = intlZones();
const UPDATED = "2026-11-01T08:00:00.000Z";
const studio: CalendarRecord = {
  id: "cal-1",
  connectionId: "conn-1",
  name: "Studio",
  color: "#3366cc",
  access: "owner",
  shown: true,
  timeZone: ZURICH,
  window: null,
  defaultAlarms: [],
  lastSyncedAt: null,
  errorCode: null,
  updatedAt: UPDATED,
};

function event(id: string, title: string, from: string, to: string, over: Partial<CalendarEventRecord> = {}) {
  const at = (v: string) =>
    v.length === 8
      ? ({ kind: "date", value: v } as const)
      : ({ kind: "zoned", value: v, zone: ZURICH } as const);
  const record: CalendarEventRecord = {
    id,
    calendarId: "cal-1",
    uid: `${id}@studio.test`,
    recurrenceId: "",
    thisAndFuture: false,
    sequence: 0,
    status: "confirmed",
    title,
    notes: null,
    place: null,
    callLink: null,
    start: at(from),
    end: at(to),
    duration: null,
    startsAt: UPDATED,
    endsAt: UPDATED,
    occurrenceAt: null,
    repeat: null,
    busy: true,
    private: false,
    organizer: null,
    myAnswer: null,
    heldBack: false,
    invitees: [],
    alarms: [],
    cut: false,
    writes: [],
    updatedAt: UPDATED,
    ...over,
  };
  return { record, waiting: null, refusal: null, refusedWriteId: null };
}

function shown(
  events: ReturnType<typeof event>[],
  from = "2026-11-16",
  to = "2026-11-30",
): readonly ShownOccurrence[] {
  return occurrencesIn({
    events,
    calendars: [studio],
    query: { from: dayOfIso(from)!, to: dayOfIso(to)! },
    zone: ZURICH,
    zones: ZONES,
  }).shown;
}
const now = (minute: number) => ({ day: "2026-11-16", minute, zone: ZURICH, zones: ZONES });

describe("today beside the Ohbox", () => {
  const day = [
    event("ev-all", "Kiln day", "20261116", "20261117"),
    event("ev-early", "Clay order", "20261116T080000", "20261116T083000"),
    event("ev-now", "Glaze test", "20261116T093000", "20261116T110000"),
    event("ev-late", "Supplier call", "20261116T160000", "20261116T163000"),
    event("ev-gone", "Cancelled firing", "20261116T120000", "20261116T130000", { status: "cancelled" }),
    event("ev-no", "Declined lunch", "20261116T123000", "20261116T133000", { myAnswer: "declined" }),
    event("ev-tomorrow", "Market", "20261117T090000", "20261117T120000"),
  ];

  it("lists the rest of today: the whole day first, then by the hour, what is on now marked", () => {
    const rows = todayRowsOf(shown(day), now(10 * 60));
    expect(rows.map((r) => r.title)).toEqual(["Kiln day", "Glaze test", "Supplier call"]);
    expect(rows.map((r) => r.startMinute)).toEqual([null, 9 * 60 + 30, 16 * 60]);
    expect(rows.map((r) => r.now)).toEqual([false, true, false]);
    expect(rows[1]!.ref).toEqual({ event: "ev-now", occurrence: null, day: "2026-11-16" });
  });

  it("keeps an event that began before today and lasts into it, as on now", () => {
    const rows = todayRowsOf(
      shown([event("ev-night", "Night firing", "20261115T220000", "20261116T110000")], "2026-11-15"),
      now(9 * 60),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Night firing", startMinute: null, now: true });
    expect(
      todayRowsOf(
        shown([event("ev-night", "Night firing", "20261115T220000", "20261116T110000")], "2026-11-15"),
        now(11 * 60),
      ),
    ).toEqual([]);
  });

  it("says a calendar shared as busy times by no title", () => {
    const busy = shown([event("ev-b", "Private thing", "20261116T150000", "20261116T160000")]).map((o) => ({
      ...o,
      calendar: { ...o.calendar, access: "busy" as const },
    }));
    expect(todayRowsOf(busy, now(9 * 60))[0]!.title).toBeNull();
  });
});

describe("coming up with one person", () => {
  const with_ = (address: string, over: Partial<CalendarEventRecord> = {}) => ({
    organizer: { address, name: null },
    invitees: [],
    ...over,
  });
  const events = [
    event("ev-1", "Studio visit", "20261116T140000", "20261116T150000", with_("Petra@Studio.test")),
    event("ev-2", "Review", "20261118T090000", "20261118T100000", {
      invitees: [{ address: "petra@studio.test", name: null, role: "required", answer: "none" }],
      organizer: { address: "me@own.test", name: null },
    }),
    event("ev-3", "Invited", "20261119T090000", "20261119T100000", {
      ...with_("petra@studio.test"),
      myAnswer: "none",
    }),
    event("ev-4", "Fourth", "20261120T090000", "20261120T100000", with_("petra@studio.test")),
    event("ev-past", "Earlier", "20261116T080000", "20261116T090000", with_("petra@studio.test")),
    event("ev-other", "Someone else", "20261116T150000", "20261116T160000", with_("bea@studio.test")),
    event("ev-off", "Called off", "20261117T090000", "20261117T100000", {
      ...with_("petra@studio.test"),
      status: "cancelled",
    }),
  ];

  it("lists the next ones with that person, organizer or invitee, by any spelling of the address, at most as many as asked", () => {
    const rows = comingUpOf(shown(events), "petra@studio.test", 3, now(10 * 60));
    expect(rows.map((r) => r.title)).toEqual(["Studio visit", "Review", "Invited"]);
    expect(rows.map((r) => r.toAnswer)).toEqual([false, false, true]);
    expect(rows.map((r) => r.day)).toEqual(["2026-11-16", "2026-11-18", "2026-11-19"]);
  });

  it("lists nothing for an address no event names", () => {
    expect(comingUpOf(shown(events), "nobody@studio.test", 3, now(10 * 60))).toEqual([]);
  });
});
