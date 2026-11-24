import { describe, expect, it } from "vitest";
import { discardDecision, type Hold } from "@ohmail/app-logic/writing/send-lock";

/**
 * WHAT THE DRAFTS LIST'S DISCARD DOES WITH EACH HOLD — the truth table behind `discardDraft`.
 * The server admits the discard of an `unverified` row and refuses a running send by name, so
 * every hold but two goes to the wire. The two that stay are each a rendered refusal: a row still
 * `sending`, and a jar this browser cannot read (invariant S(4): a recovery fails closed on
 * `unknown`). Mutation: return `{ kind: "wire" }` for `unknown` → the last case reads red.
 */
const parkedBy = (by: "record" | "status", status: string | null): Hold =>
  ({ kind: "parked", by, status, draftId: "d1", session: null }) as Hold;

describe("discardDecision", () => {
  it("a free row goes to the wire", () => {
    expect(discardDecision({ kind: "free" })).toEqual({ kind: "wire" });
  });

  it("a row this browser holds by a RECORD goes to the wire — the server decides, the record is released on confirm", () => {
    expect(discardDecision(parkedBy("record", null))).toEqual({ kind: "wire" });
  });

  it("an `unverified` row goes to the wire — the discard a user pressed for weeks", () => {
    expect(discardDecision(parkedBy("status", "unverified"))).toEqual({ kind: "wire" });
  });

  it("a `sent` row goes to the wire — nothing holds a delivered message's row", () => {
    expect(discardDecision(parkedBy("status", "sent"))).toEqual({ kind: "wire" });
  });

  it("a row still `sending` is refused in the row — the server would refuse it too", () => {
    expect(discardDecision(parkedBy("status", "sending"))).toEqual({ kind: "refuse", why: "still-sending" });
  });

  it("a jar this browser cannot read fails closed, and says which half is missing", () => {
    expect(discardDecision({ kind: "unknown" })).toEqual({ kind: "refuse", why: "unknown-jar" });
  });
});
