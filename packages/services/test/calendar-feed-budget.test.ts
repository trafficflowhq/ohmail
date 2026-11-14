import { expect, it } from "vitest";
import type { CalendarEventRecord } from "@ohmail/wire";
import { cutToFit } from "../src/calendar/feed.js";
import { CALENDAR_EVENT_MAX_BYTES } from "../src/sync-page-byte-budget.js";

const at = "2026-11-16T00:00:00.000Z";
const record: CalendarEventRecord = {
  id: "kiln", calendarId: "study", uid: "kiln", recurrenceId: "", thisAndFuture: false,
  sequence: 0, status: "confirmed", title: "Kiln check", notes: "Keep the kiln door closed.",
  place: "Studio", callLink: null, start: { kind: "date", value: "20261116" }, end: null,
  duration: null, startsAt: at, endsAt: null, occurrenceAt: null,
  repeat: { rules: ["FREQ=DAILY;COUNT=4"], added: [], excluded: [] },
  organizer: null, myAnswer: null, heldBack: false, busy: true, private: false,
  invitees: [{ address: "guest@example.invalid", name: "Guest", role: "required", answer: "none" }],
  writes: [{
    id: "write", key: "key", state: "pending", reason: null, part: null, at,
    act: { kind: "calendar_event_update", eventId: "kiln", base: at, scope: { kind: "record" }, change: { title: "New title" } },
  }],
  alarms: [], cut: false, updatedAt: at,
};

it("omits oversized delete metadata before cutting existing event details", () => {
  const oversized: CalendarEventRecord = {
    ...record,
    deleteScopes: ["record", "occurrence"],
    deleteMembers: Array.from({ length: 1000 }, (_, day) => ({
      at: Date.UTC(2026, 10, day + 1), range: false, organizer: null,
      guests: [{ address: "guest@example.invalid", name: "Guest".repeat(40) }],
    })),
  };
  expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(CALENDAR_EVENT_MAX_BYTES);
  expect(cutToFit(oversized)).toEqual(record);
  const detailsTooLarge = { ...oversized, notes: "x".repeat(CALENDAR_EVENT_MAX_BYTES) };
  expect(cutToFit(detailsTooLarge)).toMatchObject({
    notes: null, invitees: [], cut: true, writes: [{ act: null }],
  });
  expect(cutToFit(detailsTooLarge)).not.toHaveProperty("deleteMembers");
});
