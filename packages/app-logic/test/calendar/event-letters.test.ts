import { describe, expect, it } from "vitest";
import type { MessageDTO, MessageInvitationDTO } from "@ohmail/wire";
import { eventLetters } from "../../src/calendar/beside/event-letters.js";

function message(id: string, day: string, uid?: string, sortAt?: string) {
  const invitation: MessageInvitationDTO | undefined = uid
    ? {
        method: "REQUEST",
        uid,
        recurrenceId: "",
        sequence: 0,
        start: null,
        startsAt: null,
        organizer: null,
        invitedAddress: null,
        answer: null,
        answeredAt: null,
      }
    : undefined;
  return { id, folder: "INBOX", subject: id, date: day, sortAt, invitation } satisfies Pick<
    MessageDTO,
    "id" | "subject" | "folder" | "date" | "sortAt" | "invitation"
  >;
}

describe("letters about a calendar event", () => {
  it("uses only matching invitation UIDs and the effective message date", () => {
    const first = message("first", "2026-11-12T00:00:00Z", "meeting");
    const newest = message("newest", "2026-11-10T00:00:00Z", "meeting", "2026-11-15T00:00:00Z");
    const other = message("other", "2026-11-15T00:00:00Z", "different");
    const old = message("old mirror", "2026-11-15T00:00:00Z");
    expect(eventLetters("meeting", [first, other, newest, old])).toEqual([newest, first]);
    expect(eventLetters("", [first, other, newest, old])).toEqual([]);
  });
});
