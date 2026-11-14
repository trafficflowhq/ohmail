/**
 * THE INVITATIONS' THREE GROUPS, worked out from what the calendar holds: To answer, Changed, Answered; one row per
 * event at its first occurrence from today; what is held back, on a hidden calendar, the account's own or without an
 * organizer is no invitation here.
 */
import { describe, expect, it } from "vitest";
import { intlZones } from "@ohmail/cal-core";
import type { EventWithWrites } from "@ohmail/client-engine/calendar-acts";
import type { CalendarEventRecord, CalendarRecord } from "@ohmail/wire";
import { dayOfIso, occurrencesIn } from "../../../src/calendar/index.js";
import { invitationCountOf, invitationsOf } from "../../../src/calendar/invitations/index.js";
import { OWN, ZURICH, calendarOf, connection, event, invitation } from "./fixtures.js";

const zones = intlZones();
const TODAY = "2026-11-16";

function groupsOf(
  records: readonly CalendarEventRecord[],
  calendars: readonly CalendarRecord[] = [calendarOf()],
  waits: (r: CalendarEventRecord) => Partial<EventWithWrites> = () => ({}),
  conn = connection(),
) {
  const events = records.map((record): EventWithWrites => ({
    record,
    waiting: null,
    refusal: null,
    refusedWriteId: null,
    ...waits(record),
  }));
  const occurrences = occurrencesIn({
    events,
    calendars,
    query: { from: dayOfIso(TODAY)!, to: dayOfIso("2027-01-31")! },
    zone: ZURICH,
    zones,
  }).shown;
  return invitationsOf({
    occurrences,
    connections: new Map([[conn.id, conn]]),
    ownAddresses: [OWN],
    todayKey: TODAY,
    zone: ZURICH,
    zones,
  });
}

const titles = (rows: readonly { title: string }[]) => rows.map((r) => r.title);

describe("the invitations' groups", () => {
  it("puts a waiting one under To answer, a cancelled one under Changed and the three answers under Answered", () => {
    const g = groupsOf([
      invitation("Tech check", "20261118", { title: "Tech check" }),
      invitation("Shoot", "20261117", { title: "Shoot", status: "cancelled" }),
      invitation("Yes", "20261119", { title: "Yes", myAnswer: "accepted" }),
      invitation("Maybe", "20261120", { title: "Maybe", myAnswer: "tentative" }),
      invitation("No", "20261121", { title: "No", myAnswer: "declined" }),
    ]);
    expect(titles(g.toAnswer)).toEqual(["Tech check"]);
    expect(titles(g.changed)).toEqual(["Shoot"]);
    expect(g.changed[0]).toMatchObject({ cancelled: true });
    expect(titles(g.answered)).toEqual(["Yes", "Maybe", "No"]);
    expect(g.answered.map((r) => r.answer)).toEqual(["accepted", "tentative", "declined"]);
    expect(g.waiting).toBe(1);
    expect(invitationCountOf(g)).toBe(1);
  });

  it("leaves out what is held back, what stands on a hidden calendar, the account's own and one with no organizer", () => {
    const hidden = calendarOf({ id: "cal-2", name: "Hidden", shown: false });
    const g = groupsOf(
      [
        invitation("held", "20261118", { heldBack: true }),
        invitation("hidden", "20261118", { calendarId: "cal-2" }),
        invitation("own", "20261118", { organizer: { address: "ADA@studio.test", name: null } }),
        invitation("nobody", "20261118", { organizer: null }),
        event("plain", "20261118"),
        invitation("shown", "20261118"),
      ],
      [calendarOf(), hidden],
    );
    expect(titles([...g.toAnswer, ...g.changed, ...g.answered])).toEqual(["shown"]);
  });

  it("lists a repeating invitation once, at its first occurrence from today, in date order", () => {
    const g = groupsOf([
      invitation("later", "20261125", { title: "Later" }),
      invitation("weekly", "20261102", {
        title: "Weekly",
        repeat: { rules: ["FREQ=WEEKLY"], excluded: [], added: [] },
        endsAt: null,
      }),
      invitation("past", "20261110", { title: "Past" }),
    ]);
    expect(titles(g.toAnswer)).toEqual(["Weekly", "Later"]);
    expect(g.toAnswer[0]).toMatchObject({ day: "2026-11-16", ref: { event: "weekly", day: "2026-11-16" } });
    expect(g.toAnswer[0]!.ref.occurrence).not.toBeNull();
  });

  it("names a changed day of a series as the views name it, and answers the changed day's own record", () => {
    const stored = "Europe/Zurich|20261116T0900|false";
    const g = groupsOf([
      invitation("weekly", "20261102", {
        title: "Weekly",
        repeat: { rules: ["FREQ=WEEKLY;COUNT=4"], excluded: [], added: [] },
      }),
      invitation("weekly-moved", "20261117", {
        title: "Weekly, moved",
        uid: "weekly@studio.test",
        recurrenceId: stored,
        start: { kind: "zoned", value: "20261117T100000", zone: ZURICH },
        end: { kind: "zoned", value: "20261117T103000", zone: ZURICH },
      }),
    ]);
    const moved = g.toAnswer.find((r) => r.title === "Weekly, moved");
    expect(moved?.ref).toEqual({ event: "weekly", occurrence: stored, day: "2026-11-17" });
    expect(moved?.recordId).toBe("weekly-moved");
  });

  it("says who invites, where the answer waits, and whether its calendar can only be looked at", () => {
    const g = groupsOf(
      [invitation("a", "20261118", { title: "A", place: "Hall 2" })],
      [calendarOf({ access: "reader" })],
      () => ({ waiting: "device" }),
    );
    expect(g.toAnswer[0]).toMatchObject({
      organizer: "Marco",
      waiting: "device",
      viewOnly: true,
      connectionStopped: false,
      place: "Hall 2",
      when: { first: "2026-11-18", allDay: false, startMinute: 540, endMinute: 570 },
    });
    const stopped = groupsOf(
      [invitation("b", "20261118")],
      undefined,
      undefined,
      connection({ status: "reconnect" }),
    );
    expect(stopped.toAnswer[0]).toMatchObject({ viewOnly: true, connectionStopped: true });
  });
});
