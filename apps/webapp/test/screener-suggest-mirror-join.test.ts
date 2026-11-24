import type { ScreenerSenderDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { joinSuggestion } from "@ohmail/app-logic/screener/screener-state";
import type { SenderSuggestion, SuggestionOverlay } from "@ohmail/app-logic/screener/screener-suggest";

/**
 * THE TWO SOURCES OF ONE CHIP, JOINED IN ONE PLACE. The mirror fills a derived row's `ai` from
 * the `/sync` entity; the session overlay holds what THIS session bought or re-read. The overlay
 * is the fresher layer and WINS on a derived row — a "Suggest again" answers into it the moment
 * the response lands, and the mirror's previous row must not mask that answer until the next
 * delta. A fixture row keeps the demo's own `ai`. MUTATION-WATCH: restore the old guard —
 * `if (!overlay || x.ai || x.derived !== true) return x;` — and "the overlay's fresher answer
 * wins" goes red with the stale mirror verdict rendered after a re-buy. That mutation was run.
 */

const row = (over: Partial<ScreenerSenderDTO>): ScreenerSenderDTO => ({
  id: "m-1", segment: "waiting", from: { name: null, address: "New@Stranger.test" },
  initial: "N", time: "09:00", scope: "sender",
  ai: null, held: [], derived: true, gatePhysical: true,
  updatedAt: "2026-09-18T09:00:00.000Z", ...over,
} as ScreenerSenderDTO);

const advice = (dest: SenderSuggestion["dest"], confidence: number): SenderSuggestion =>
  ({ dest, confidence, rationale: "" });

const overlayOf = (address: string, s: SenderSuggestion): SuggestionOverlay =>
  new Map([[address.toLowerCase(), s]]);

describe("joinSuggestion — the overlay onto the mirror-filled row", () => {
  it("the overlay's fresher answer wins on a derived row that already carries mirror ai", () => {
    const x = row({ ai: advice("ohbox", 0.5) });
    const joined = joinSuggestion(x, overlayOf("new@stranger.test", advice("reads", 0.9)));
    expect(joined.ai).toEqual({ dest: "reads", confidence: 0.9, rationale: "" });
  });

  it("no overlay match keeps the mirror's ai, and the row identity is untouched", () => {
    const x = row({ ai: advice("ohbox", 0.5) });
    expect(joinSuggestion(x, overlayOf("someone@else.test", advice("reads", 0.9)))).toBe(x);
    expect(joinSuggestion(x, undefined)).toBe(x);
  });

  /* A refused act is the MIRROR's fact; the overlay carries advice and never that. */
  it("a refused act the mirror recorded survives the overlay's fresher advice, and is never invented", () => {
    const refused = row({ ai: { ...advice("spam", 0.95), actRefused: true } });
    expect(joinSuggestion(refused, overlayOf("new@stranger.test", advice("spam", 0.96))).ai)
      .toEqual({ dest: "spam", confidence: 0.96, rationale: "", actRefused: true });
    const plain = row({ ai: advice("spam", 0.95) });
    expect(joinSuggestion(plain, overlayOf("new@stranger.test", advice("spam", 0.96))).ai)
      .not.toHaveProperty("actRefused");
  });

  /* SUGGESTION-GAIN-READ-COVERS-QUEUE-GAINS-ONLY: the overlay names the mirror suggestion it
     landed over, so a newer purchase the mirror receives from anywhere wins the row. */
  it("a newer purchase on the mirror than the one the overlay landed over wins the row", () => {
    const x = row({ ai: { ...advice("reads", 0.9), id: "s-2" } });
    const joined = joinSuggestion(x, overlayOf("new@stranger.test", { ...advice("ohbox", 0.5), over: "s-1" }));
    expect(joined).toBe(x);
  });

  it("the overlay still wins over the mirror suggestion it landed over (the control)", () => {
    const x = row({ ai: { ...advice("ohbox", 0.5), id: "s-1" } });
    const joined = joinSuggestion(x, overlayOf("new@stranger.test", { ...advice("reads", 0.9), over: "s-1" }));
    expect(joined.ai).toEqual({ dest: "reads", confidence: 0.9, rationale: "" });
  });

  it("an overlay entry that landed over nothing yields to a purchase the mirror received since", () => {
    const x = row({ ai: { ...advice("reads", 0.9), id: "s-1" } });
    expect(joinSuggestion(x, overlayOf("new@stranger.test", { ...advice("ohbox", 0.5), over: null }))).toBe(x);
  });

  it("an entry naming nothing it landed over keeps the overlay's answer, as before", () => {
    const x = row({ ai: { ...advice("reads", 0.9), id: "s-2" } });
    expect(joinSuggestion(x, overlayOf("new@stranger.test", advice("ohbox", 0.5))).ai?.dest).toBe("ohbox");
  });

  it("a fixture row keeps the demo's own ai whatever the overlay says", () => {
    const x = row({ derived: undefined, ai: advice("screened", 0.7) });
    expect(joinSuggestion(x, overlayOf("new@stranger.test", advice("reads", 0.9)))).toBe(x);
  });
});
