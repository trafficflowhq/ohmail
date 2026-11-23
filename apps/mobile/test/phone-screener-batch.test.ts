import { describe, expect, it, vi } from "vitest";
import type { ScreenerRow } from "../src/state/live";
import { applySuggestions, planSuggestions } from "../src/ui/screener-batch";

const sender = (id: string, dest?: "reads" | "spam", held = [id]): ScreenerRow => ({
  id, routeKey: id, name: id, address: `${id}@example.test`, scope: "sender",
  held: held.map((id) => ({ id, time: "", subject: "", body: "", seen: false })),
  ai: dest ? { dest, confidence: 0.98, rationale: "" } : null,
} as ScreenerRow);

describe("applying suggestions on the phone", () => {
  it("calls the sender's existing action once per suggestion and never applies a default to a hold", async () => {
    const waiting = [sender("newsletter", "reads"), sender("unsure"), sender("junk", "spam")];
    const decide = vi.fn();
    const grants = vi.fn((row: ScreenerRow) => [row.id]);
    const plan = planSuggestions(waiting, grants);
    await applySuggestions(plan, () => waiting, decide);
    expect(decide.mock.calls).toEqual([
      [waiting[0], "reads", false, waiting, []],
      [waiting[2], "spam", false, waiting, ["junk"]],
    ]);
    expect(grants).toHaveBeenCalledTimes(1);
  });

  it("a confirmation does not apply outside the current queue or cover a new letter", async () => {
    const old = [sender("one", "reads"), sender("two", "spam")];
    const decide = vi.fn();
    const plan = planSuggestions(old, () => ["two"]);
    await applySuggestions(plan, () => [sender("two", "spam", ["two", "arrived"]), sender("other", "reads")], decide);
    expect(decide).not.toHaveBeenCalled();
  });
});
