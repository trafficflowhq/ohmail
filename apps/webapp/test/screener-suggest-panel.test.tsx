/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenerSuggestControl } from "@ohmail/app/screener";
import { NO_RUN } from "@ohmail/app-logic/screener";
import { BESIDE, modelOf, mountPlace, sender } from "../../../packages/app/test/screener/screener-world.js";

const noop = () => {};

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(cleanup);

function mount(over: Partial<ScreenerSuggestControl>, lang: "en" | "de" = "en", failed = false) {
  const control: ScreenerSuggestControl = {
    available: 74, resuggestable: 0, pool: 74, sizes: [10, 25, 50, 74], size: 25,
    phase: "ready", quote: null, notice: null, progress: null,
    open: noop, openAgain: noop, choose: vi.fn(), confirm: vi.fn(), cancel: noop,
    ...over,
  };
  const model = modelOf({ flushes: 0 }, {
    waiting: [sender("lena", "Lena Hart", failed ? {
      ai: { dest: "screener", confidence: 0, rationale: "", noAnswer: "model_unavailable" },
    } : {})],
    waitingCount: 74,
    suggestedCount: 1,
    suggestedDests: ["reads"],
  });
  const world = mountPlace(model, { lang, beside: { ...BESIDE, suggest: { control, priced: true, noAdvice: NO_RUN } } });
  return { ...world, control, model };
}

describe("the Suggest panel", () => {
  it.each([
    { lang: "en", title: "Suggest", price: "1 credit" },
    { lang: "de", title: "Vorschläge", price: "1 Credit" },
  ] as const)("gives the heading and the price their own lines in $lang", ({ lang, title, price }) => {
    mount({ available: 1, pool: 1, sizes: [1], size: 1, quote: { senders: 1, credits: 1 } }, lang);
    const ask = within(screen.getByRole("dialog"));
    expect(ask.getByRole("heading", { name: title }).textContent).toBe(title);
    expect(ask.getByText(price, { exact: true, selector: "p" })).toBeTruthy();
  });

  it.each([
    { lang: "en", all: "All 32", action: "Suggest for all 26 senders" },
    { lang: "de", all: "Alle 32", action: "Für alle 26 Absender vorschlagen" },
  ] as const)("keeps the snapshot size and confirms the quoted count in $lang", ({ lang, all, action }) => {
    mount({ available: 32, pool: 32, sizes: [10, 25, 32], size: 32, quote: { senders: 26, credits: 26 } }, lang);
    const ask = within(screen.getByRole("dialog"));
    const sizes = within(ask.getByRole("group"));
    expect(sizes.getAllByRole("button").map((button) => button.textContent)).toEqual(["10", "25", all]);
    expect(sizes.getByRole("button", { name: all, pressed: true })).toBeTruthy();
    expect(ask.getByRole("button", { name: action }).hasAttribute("disabled")).toBe(false);
  });

  it("keeps the size labels from the snapshot when a smaller quote arrives", () => {
    mount({ available: 32, pool: 32, sizes: [10, 25, 32], size: 10, quote: { senders: 9, credits: 9 } });
    const ask = within(screen.getByRole("dialog"));
    const sizes = within(ask.getByRole("group"));
    expect(sizes.getByRole("button", { name: "10", pressed: true })).toBeTruthy();
    expect(sizes.getByRole("button", { name: "All 32" })).toBeTruthy();
    expect(ask.getByRole("button", { name: "Suggest for 9 senders" })).toBeTruthy();
  });

  it("names the failed suggestion and lets the list retry it quietly", () => {
    const openRetry = vi.fn();
    mount({ phase: "closed", retryable: 1, openRetry }, "en", true);
    const row = screen.getByRole("option", { name: /Lena Hart/ });
    expect(row.getAttribute("aria-description")).toContain("Could not suggest");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Retry suggestions…" }));
    expect(openRetry).toHaveBeenCalledTimes(1);
  });

  it("returns focus to the list tools when a first purchase starts", () => {
    const { control, model, again } = mount({ quote: { senders: 25, credits: 25 } });
    fireEvent.click(screen.getByRole("button", { name: "Suggest for the first 25 senders" }));
    Object.assign(control, { phase: "running", progress: { done: 0, total: 25 } });
    again(model);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "List" }));
  });
});
