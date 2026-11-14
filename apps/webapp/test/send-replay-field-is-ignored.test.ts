import { describe, expect, it } from "vitest";
import type { MutationResult } from "@ohmail/client-engine";
import { phaseFor } from "@ohmail/app-logic/writing/mail-send";

/**
 * ═══ THE BROWSER AND DESKTOP COMPOSER IGNORE `firstSend` ════════════════════════════════════
 *
 * This composer mints its key once per lane and resumes a standing lock on the next press, so a
 * press is refused or resumed but never re-keyed over different words — it cannot reach the
 * state the field describes. A field that means nothing here must change nothing here. The
 * desktop renders this same shell and has no send path of its own.
 *
 * Mutation: a branch on `firstSend` added to `phaseFor` → both cases.
 */
const confirmed = (firstSend?: { status: string; at: string }): MutationResult => ({
  id: "m1", key: "k1", status: "confirmed", seq: 7,
  ...(firstSend ? { firstSend } : {}),
});

describe("a confirmed send carrying the earlier-send field", () => {
  it("reads exactly as one without it", () => {
    expect(phaseFor(confirmed({ status: "sent", at: "2026-09-16T07:00:00.000Z" })))
      .toEqual(phaseFor(confirmed()));
  });

  it("and is still the confirmation that spends the editor", () => {
    expect(phaseFor(confirmed({ status: "sent", at: "2026-09-16T07:00:00.000Z" })).phase).toBe("idle");
  });
});
