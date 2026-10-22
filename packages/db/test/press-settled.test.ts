import { describe, expect, it } from "vitest";
import { pressSettled, type PressLeg } from "../src/request-apply.js";

/**
 * WHEN A READER'S RULE ROW MAY FOLLOW ITS PRESS: every leg finished. A delete leg refused
 * `no_such_rule` is finished (that holder's word that nothing under the key runs there); no other
 * refusal and no unanswered or expired leg is.
 */
const applied: PressLeg = { state: "applied", refusedReason: null };
const absent: PressLeg = { state: "refused", refusedReason: "no_such_rule" };
const stale: PressLeg = { state: "refused", refusedReason: "stale" };
const sent: PressLeg = { state: "sent", refusedReason: null };
const pending: PressLeg = { state: "pending", refusedReason: null };
const expired: PressLeg = { state: "expired", refusedReason: null };

describe("pressSettled", () => {
  it("one applied leg settles every op", () => {
    for (const op of ["create", "update", "delete"] as const) expect(pressSettled(op, [applied])).toBe(true);
  });
  it("every leg applied settles; one still sent, pending or expired does not", () => {
    expect(pressSettled("update", [applied, applied])).toBe(true);
    for (const other of [sent, pending, expired, stale]) {
      expect(pressSettled("update", [applied, other])).toBe(false);
      expect(pressSettled("delete", [other, applied])).toBe(false);
    }
  });
  it("a delete refused no_such_rule finishes its leg; an update or create refused so does not", () => {
    expect(pressSettled("delete", [applied, absent])).toBe(true);
    expect(pressSettled("delete", [absent, applied])).toBe(true);
    expect(pressSettled("update", [applied, absent])).toBe(false);
    expect(pressSettled("create", [applied, absent])).toBe(false);
  });
  it("a delete every holder refused no_such_rule settles; no legs is not a press", () => {
    expect(pressSettled("delete", [absent])).toBe(true);
    expect(pressSettled("delete", [absent, absent])).toBe(true);
    expect(pressSettled("delete", [])).toBe(false);
  });
  it("at a leave, a press whose every holder left settles; an unfinished live leg still holds it", () => {
    for (const op of ["create", "update", "delete"] as const) {
      expect(pressSettled(op, [], { legLeft: true })).toBe(true);
      expect(pressSettled(op, [], { legLeft: false })).toBe(false);
      expect(pressSettled(op, [applied], { legLeft: true })).toBe(true);
      for (const other of [sent, pending, expired, stale]) expect(pressSettled(op, [applied, other], { legLeft: true })).toBe(false);
    }
  });
});
