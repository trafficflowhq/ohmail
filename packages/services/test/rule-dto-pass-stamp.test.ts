import { describe, expect, it } from "vitest";
import { ruleRowToDTO } from "../src/dto/materialize.js";

/**
 * A RULE CARRIES ITS PASS OVER PAST MAIL: when it was asked for and when it finished, `null` for
 * either not yet. The walk's cursor and its count stay off the wire — a count taken from the filed
 * folder is not what a person sees, and the cursor is the walk's own bookkeeping.
 */
const BASE = {
  id: "r-1", accountId: "acct", kind: "sender", match: "a@x.example", destination: "INBOX", priority: 0,
  provenance: "manual", enabled: true, subjectContains: null, bodyContains: null, hits: 0, lastHitAt: null,
  demotions: 0, createdAt: new Date("2026-09-25T10:00:00.000Z"), updatedAt: new Date("2026-09-25T10:00:00.000Z"),
  retroRequestedAt: null, retroDoneAt: null, retroCursor: null, retroMoved: 0, refileFrom: null, refileAt: null,
} as unknown as Parameters<typeof ruleRowToDTO>[0];

describe("RuleDTO.retro", () => {
  it("asked and finished, as stored", () => {
    const dto = ruleRowToDTO({
      ...BASE, retroRequestedAt: new Date("2026-09-25T12:00:00.000Z"), retroDoneAt: new Date("2026-09-25T12:05:00.000Z"),
      retroCursor: "00000000-0000-4000-8000-000000000001", retroMoved: 41,
    });
    expect(dto.retro).toEqual({ requestedAt: "2026-09-25T12:00:00.000Z", doneAt: "2026-09-25T12:05:00.000Z", from: null });
    expect(JSON.stringify(dto)).not.toMatch(/retroCursor|retroMoved|"41"/);
  });

  it("nobody asked is two nulls, never an absent field", () => {
    expect(ruleRowToDTO(BASE).retro).toEqual({ requestedAt: null, doneAt: null, from: null });
  });

  /* While it waits, its origin; once a page moved mail or the walk parked (a mailbox only read here),
     the rule's own place, never null, which a client reads as a walk it takes whole. */
  it("a Rules-page Change's re-filing names its origin while it waits, then the rule's own place", () => {
    const at = new Date("2026-09-25T12:00:00.000Z");
    const waiting = { ...BASE, destination: "ohmail/Receipts", retroRequestedAt: at, refileAt: at, refileFrom: "ohmail/News" };
    expect(ruleRowToDTO(waiting).retro.from).toBe("ohmail/News");
    expect(ruleRowToDTO({ ...waiting, retroMoved: 1 }).retro.from).toBe("ohmail/Receipts");
    expect(ruleRowToDTO({ ...waiting, retroCursor: "ffffffff-ffff-ffff-0000-019a17a3b2c0" }).retro.from).toBe("ohmail/Receipts");
    expect(ruleRowToDTO({ ...waiting, retroCursor: "00000000-0000-4000-8000-000000000001" }).retro.from).toBe("ohmail/News");
    expect(ruleRowToDTO({ ...waiting, retroDoneAt: at }).retro.from).toBeNull();
    expect(ruleRowToDTO({ ...waiting, retroRequestedAt: new Date("2026-09-25T12:01:00.000Z") }).retro.from).toBeNull();
  });
});
