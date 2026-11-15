import { describe, expect, it } from "vitest";
import { CALENDAR_TEXT_MAX_BYTES, CALENDAR_TEXT_MAX_PARTS } from "../packages/client-engine/src/engine/attachment-items";
import { INVITATION_PART_MAX_BYTES, INVITATION_PARTS_MAX } from "@trafficflow/core/mail";

/**
 * THE INGEST READS THE CALENDAR PARTS THE CARD READS. The invitation's identity is kept at ingest
 * (core) and the card draws the event from the parts a device fetches (the client engine); when
 * the two took different parts, the card and the row could name different events. The client half
 * may not import the server's packages, so the two numbers are two constants, held equal here.
 */
describe("the invitation's parts: the card's bounds and the ingest's", () => {
  it("are the same bytes per part and the same number of parts", () => {
    expect(INVITATION_PART_MAX_BYTES).toBe(CALENDAR_TEXT_MAX_BYTES);
    expect(INVITATION_PARTS_MAX).toBe(CALENDAR_TEXT_MAX_PARTS);
  });
});
