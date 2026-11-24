/** @vitest-environment jsdom */
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NO_RUN } from "@ohmail/app-logic/screener";
import type { ScreenerSuggest } from "@ohmail/app/screener";
import { BESIDE, modelOf, mountPlace, sender } from "../../../packages/app/test/screener/screener-world.js";

const priced: ScreenerSuggest = {
  priced: true,
  noAdvice: NO_RUN,
  control: {
    available: 3,
    resuggestable: 0,
    pool: 3,
    sizes: [3],
    size: 3,
    phase: "ready",
    quote: { senders: 3, credits: 3 },
    notice: null,
    progress: null,
    open() {},
    openAgain() {},
    choose() {},
    confirm() {},
    cancel() {},
  },
};

afterEach(cleanup);

describe("the Screener's suggest control", () => {
  it("shows the host's own control instead, and drops the price vocabulary with it", () => {
    Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
    const model = modelOf({ flushes: 0 }, {
      waiting: [sender("first", "First"), sender("second", "Second"), sender("third", "Third")],
      waitingCount: 3,
    });
    const { view } = mountPlace(model, {
      at: "#/screener",
      beside: { ...BESIDE, suggest: priced, ownSuggest: <button type="button">Suggest for 3 senders</button> },
    });

    expect(screen.getAllByRole("button", { name: "Suggest for 3 senders" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Suggest…?$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Suggest again…?$/ })).toBeNull();
    const text = view.container.textContent ?? "";
    expect(text).toContain("Suggest for 3 senders");
    for (const word of [/credit/i, /\bprice\b/i, /\$/]) {
      expect(text, `the host's control was drawn beside price copy: ${String(word)}`).not.toMatch(word);
    }
  });
});
