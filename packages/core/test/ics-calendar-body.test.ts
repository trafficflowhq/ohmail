import { describe, it, expect } from "vitest";
import { normalizeMime } from "../src/mime.js";
import { isCalendarBodyPart } from "../src/ics.js";
import { INVITE_SHAPES, PLAIN_ICS_FILE } from "./fixtures/invite-shapes.js";

/**
 * Which stored parts are an invitation's own calendar body (the card reads them, the strip lists
 * them as no tile), read off the rows ingest writes for each raw shape: the nameless text/calendar
 * alternative of Google, Thunderbird, Exchange and Outlook, and a bare iTIP message's one part.
 * Every named calendar file and every embedded part stays a file.
 */
const BODY_PARTS: Readonly<Record<string, readonly boolean[]>> = {
  google: [true, false],
  thunderbird: [true, false],
  "exchange-ical": [true],
  "outlook-related": [true, false],
  "embedded-calendar": [false],
  apple: [false],
  "single-part-itip": [true],
  tnef: [false],
  "two-events": [false, false],
  "update-sequence": [false, false],
  "hostile-duration": [false],
  "plain-ics-file": [false],
};

describe("isCalendarBodyPart, over what ingest stores", () => {
  for (const shape of [...INVITE_SHAPES, PLAIN_ICS_FILE]) {
    it(shape.name, async () => {
      const msg = await normalizeMime(shape.eml);
      expect(msg.attachments.map((a) => isCalendarBodyPart(a))).toEqual(BODY_PARTS[shape.name]);
    });
  }

  it("a name in either header, or a Content-ID, keeps a calendar part a file", () => {
    const part = { filename: null, contentType: "text/calendar; method=REQUEST", inline: false, contentId: null };
    expect(isCalendarBodyPart(part)).toBe(true);
    expect(isCalendarBodyPart({ ...part, filename: "invite.ics" })).toBe(false);
    expect(isCalendarBodyPart({ ...part, filename: "  " })).toBe(true);
    expect(isCalendarBodyPart({ ...part, contentId: "cal@example.test" })).toBe(false);
    expect(isCalendarBodyPart({ ...part, inline: true })).toBe(false);
    expect(isCalendarBodyPart({ ...part, contentType: "application/pdf" })).toBe(false);
  });
});
