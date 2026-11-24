import { describe, expect, it } from "vitest";
import { intlZones } from "@ohmail/cal-core";
import type { CalendarAccess, CalendarEventRecord } from "@ohmail/wire";
import { calendarReadsOf } from "../../src/calendar/alerts/index.js";
import { OWN, ZURICH, calendarOf, event, invitation } from "./invitations/fixtures.js";

const NOW = Date.UTC(2026, 10, 15, 12, 0);
const SCOPE = "calendar-account";

function readerOver(events: readonly CalendarEventRecord[]) {
  let access: CalendarAccess = "reader";
  const reads = calendarReadsOf({
    liveScope: () => SCOPE,
    ownAddresses: () => [OWN],
    suggestions: () => [],
    events: () =>
      events.map((record) => ({
        record,
        waiting: null,
        refusal: null,
        refusedWriteId: null,
      })),
    calendars: () => [calendarOf({ access }), calendarOf({ id: "mine" })],
    zone: () => ZURICH,
    zones: intlZones(),
    showTitles: () => true,
    acts: ["join"],
  });
  return {
    reads,
    busyOnly: () => {
      access = "busy";
    },
  };
}

describe("notification reads after Calendar access changes", () => {
  it("withdraws the shared calendar's prior alarm while a personal private alarm still rings as Busy", () => {
    const alarms = [{ minutesBefore: 0, method: "notice" }] as const;
    const shared = event("shared-discussion", "20261116", {
      title: "Shared discussion",
      alarms: [...alarms],
      callLink: "https://call.fixture.invalid/shared",
    });
    const mine = event("private-appointment", "20261116", {
      title: "Private appointment",
      calendarId: "mine",
      alarms: [...alarms],
      private: true,
    });
    const { reads, busyOnly } = readerOver([shared, mine]);
    expect(reads.ahead(SCOPE, NOW)?.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: shared.id,
          label: { as: "title", text: shared.title },
          acts: ["join"],
        }),
        expect.objectContaining({ eventId: mine.id, label: { as: "busy" } }),
      ]),
    );

    busyOnly();

    expect(reads.ahead(SCOPE, NOW)?.alerts).toEqual([
      expect.objectContaining({ eventId: mine.id, label: { as: "busy" } }),
    ]);
  });

  it("drops retained invitation, attendance and answer details when a calendar only permits busy time", () => {
    const pending = invitation("pending-invitation", "20261116", { title: "Pending invitation" });
    const accepted = invitation("accepted-invitation", "20261117", {
      title: "Accepted invitation",
      myAnswer: "accepted",
    });
    const organized = event("organized-meeting", "20261117", {
      organizer: { address: OWN, name: null },
      invitees: [{ address: "guest@fixture.invalid", name: null, role: "required", answer: "accepted" }],
    });
    const mine = invitation("personal-invitation", "20261118", {
      title: "Personal invitation",
      calendarId: "mine",
    });
    const { reads, busyOnly } = readerOver([pending, accepted, organized, mine]);
    const previous = reads.changes(null, NOW);
    expect(previous?.sample.invitations.has(pending.id)).toBe(true);
    expect(previous?.sample.standing.has(accepted.id)).toBe(true);
    expect(previous?.sample.answers.get(organized.id)).toEqual([1, 0, 0]);
    expect(previous?.look.event(pending.id)?.noticed.title).toBe(pending.title);

    busyOnly();

    const after = reads.changes(previous?.sample ?? null, NOW);
    expect(after?.sample.invitations).toEqual(new Set([mine.id]));
    expect(after?.sample.standing.has(accepted.id)).toBe(false);
    expect(after?.sample.answers.has(organized.id)).toBe(false);
    for (const record of [pending, accepted, organized]) {
      expect(after?.look.event(record.id)).toBeNull();
    }
    expect(after?.look.event(mine.id)?.noticed.title).toBe(mine.title);
  });
});
