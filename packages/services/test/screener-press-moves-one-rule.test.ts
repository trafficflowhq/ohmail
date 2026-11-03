import { describe, expect, it } from "vitest";
import { GATE_SCREENING_AUTH_VERDICTS, heldRowMovesOnPress } from "@trafficflow/db";
import { SCREENING_AUTH_VERDICTS, heldMovesOnPress, type HeldCheck } from "@trafficflow/core/sender-headers";
import { heldCheckOf } from "@ohmail/client-engine";

/**
 * ONE RULE FOR WHAT A PRESS MOVES: the server's `heldRowMovesOnPress` (db, which does not import core)
 * and core's `heldMovesOnPress`, which the client's optimistic overlay asks, answer
 * alike over every row a press can meet. And the db's copy of the gate's verdicts is core's list.
 */

const DB_CHECK: Record<HeldCheck, string | null> = { none: "none", claim: "impersonation", unchecked: null };

describe("a press moves one set, on the server and in the overlay", () => {
  it("the two copies agree over the whole table", () => {
    let rows = 0;
    for (const check of ["none", "claim", "unchecked"] as const) {
      for (const from of ["pressed@a.example", "other@a.example"]) {
        for (const auth of ["fail", "pass", null] as const) {
          for (const marked of ["pressed", "none"] as const) {
            const server = heldRowMovesOnPress({ senderCheck: DB_CHECK[check], fromAddress: from, authVerdict: auth }, "pressed@a.example", marked);
            const overlay = heldMovesOnPress({ check, from, auth }, "pressed@a.example", marked);
            expect([check, from, auth, marked, overlay]).toEqual([check, from, auth, marked, server]);
            rows++;
          }
        }
      }
    }
    expect(rows).toBe(36);
  });

  it("a claim at another address stays; at the pressed address it moves (the deciding arm)", () => {
    expect(heldMovesOnPress({ check: "claim", from: "other@a.example", auth: null }, "pressed@a.example")).toBe(false);
    expect(heldMovesOnPress({ check: "claim", from: "Pressed@A.example", auth: null }, "pressed@a.example")).toBe(true);
    expect(heldMovesOnPress({ check: "none", from: "other@a.example", auth: null }, "pressed@a.example")).toBe(true);
  });

  it("a letter held for want of confirmation (mail 0176) moves as a claim does, on both: on its own address's press only", () => {
    const wire = heldCheckOf({ reason: "unverified", brand: "PayPal", domainShared: false, held: true });
    for (const from of ["pressed@a.example", "other@a.example"]) {
      for (const marked of ["pressed", "none"] as const) {
        const server = heldRowMovesOnPress(
          { senderCheck: "none", unconfirmedHold: true, fromAddress: from, authVerdict: null }, "pressed@a.example", marked);
        expect(heldMovesOnPress({ check: wire, from, auth: null }, "pressed@a.example", marked), `${from} ${marked}`).toBe(server);
        expect(server, `${from} ${marked}`).toBe(marked === "pressed" && from === "pressed@a.example");
      }
    }
  });

  it("the db's verdict list is core's", () => {
    expect([...GATE_SCREENING_AUTH_VERDICTS]).toEqual([...SCREENING_AUTH_VERDICTS]);
  });
});
