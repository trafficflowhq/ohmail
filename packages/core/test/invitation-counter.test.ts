import { describe, expect, it } from "vitest";
import * as reply from "../src/invitation-reply.js";

const invitation = {
  uid: "planning",
  recurrenceId: String(Date.parse("2026-12-01T10:00:00Z")),
  sequence: 4,
  startRaw: "20261124T100000Z",
  startsAt: new Date("2026-11-24T10:00:00Z"),
  organizer: "host@calendar.example",
  invitedAddress: "guest@calendar.example",
  answer: "tentative",
  stamp: new Date("2026-11-22T12:00:00Z"),
  start: "20261201T130000Z",
  end: "20261201T140000Z",
};

describe("a calendar proposal", () => {
  it("writes the proposed interval and preserves the revision, occurrence and attendee's answer", () => {
    const part = reply.invitationCounterText({ ...invitation, method: "COUNTER" });
    for (const line of [
      "METHOD:COUNTER", "UID:planning", "SEQUENCE:4", "RECURRENCE-ID:20261201T100000Z",
      "DTSTART:20261201T130000Z", "DTEND:20261201T140000Z", "ATTENDEE;PARTSTAT=TENTATIVE:",
    ]) expect(part?.includes(line)).toBe(true);
  });

  it("writes DECLINECOUNTER for the same occurrence", () => {
    const part = reply.invitationCounterText({ ...invitation, method: "DECLINECOUNTER" });
    expect(part?.includes("METHOD:DECLINECOUNTER\r\n")).toBe(true);
    expect(part?.includes("RECURRENCE-ID:20261201T100000Z\r\n")).toBe(true);
  });

  it("refuses impossible or inverted intervals", () => {
    expect(reply.invitationCounterText({ ...invitation, method: "COUNTER", start: "20261131T130000Z" })).toBeNull();
    expect(reply.invitationCounterText({ ...invitation, method: "COUNTER", end: invitation.start })).toBeNull();
  });
});
