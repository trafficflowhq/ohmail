import { describe, expect, it } from "vitest";
import { quietLimit, verdicts, type Round } from "./_budget-clock.js";

const round = (before: number, after: number, ms: number): Round => ({ before, after, figures: { page: ms } });

describe("the search budget's clock", () => {
  it("a run loaded throughout is unjudged, never over", () => {
    const rounds = [round(20, 21, 130), round(22, 21, 128), round(21, 20, 133)];
    expect(verdicts(rounds, 100, quietLimit(20)).page).toEqual({ kind: "unjudged", ms: 128 });
  });

  it("a quiet round over the budget fails it whatever a loaded round read; a round within passes", () => {
    const quiet = round(11, 12, 104);
    expect(verdicts([quiet, round(19, 20, 120)], 100, quietLimit(11)).page).toEqual({ kind: "over", ms: 104, round: quiet });
    expect(verdicts([quiet, round(19, 20, 95)], 100, quietLimit(11)).page).toEqual({ kind: "within", ms: 95 });
  });

  it("with no quiet round, a figure past twice the budget is over: load alone has never read that slow", () => {
    expect(verdicts([round(20, 21, 201), round(22, 21, 573)], 100, quietLimit(20)).page).toEqual({ kind: "over", ms: 201 });
    expect(verdicts([round(20, 21, 200)], 100, quietLimit(20)).page).toEqual({ kind: "unjudged", ms: 200 });
  });

  it("a round quiet at one end only is not quiet", () => {
    expect(verdicts([round(12, 19, 104)], 100, quietLimit(11)).page.kind).toBe("unjudged");
    expect(verdicts([round(19, 12, 104)], 100, quietLimit(11)).page.kind).toBe("unjudged");
  });

  it("the quiet limit is a quarter over the quietest reading, never over 15 ms", () => {
    expect(quietLimit(10)).toBe(12.5);
    expect(quietLimit(14)).toBe(15);
  });
});
