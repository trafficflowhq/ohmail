import { expect, it } from "vitest";
import { parseCalendarAct, parseWritePayload, writePayloadOf } from "../src/calendar/write-act.js";

const id = "00000000-0000-4000-8000-000000000001";
const next = "00000000-0000-4000-8000-000000000002";
const at = String(Date.UTC(2026, 10, 17, 8));
const organizer = ["owner", "example.test"].join("@");
const guest = ["invitee", "example.test"].join("@");
const audience = { organizer, guests: [guest] };
const edit = { kind: "calendar_event_update", eventId: id, base: "2026-11-16T00:00:00.000Z", change: { title: "New firing" }, audience };

it.each([
  { kind: "occurrence", at },
  { kind: "following", at, newEventId: next },
  { kind: "record" },
])("keeps the confirmed audience on the $kind scope", (scope) => {
  expect(parseCalendarAct({ ...edit, scope })).toEqual({ ...edit, scope });
});

it("keeps rejecting a scoped change that replaces invitees", () => {
  expect(parseCalendarAct({ ...edit, scope: { kind: "occurrence", at }, change: { invitees: [] } })).toBeNull();
});

it("reads a current continuation for a personal series from an older client", () => {
  const first = parseCalendarAct({
    kind: "calendar_event_create",
    eventId: next,
    calendarId: id,
    event: {
      title: "Continued term",
      start: { kind: "date", value: "20261120" },
      end: { kind: "date", value: "20261121" },
      notes: null,
      place: null,
      callLink: null,
      busy: true,
      private: false,
      repeat: "FREQ=DAILY;COUNT=3",
      invitees: [],
      alarms: [],
    },
  });
  if (!first) throw new Error("continuation fixture could not be read");
  const payload = writePayloadOf(first, id, {
    of: "continue",
    n: 2,
    from: { eventId: id, at, named: ["title"], personalSeries: true, confirmed: true },
  });
  expect(parseWritePayload(payload)).toEqual(payload);
});
