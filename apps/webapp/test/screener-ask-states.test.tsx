/** @vitest-environment jsdom */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenerSuggestControl } from "@ohmail/app/screener";
import { NO_RUN } from "@ohmail/app-logic/screener";
import { BESIDE, modelOf, mountPlace, sender } from "../../../packages/app/test/screener/screener-world.js";
import messages from "../messages/en.json";

const S = messages.screener.suggest;
const noop = () => {};
const dialog = () => within(screen.getByRole("dialog", { name: S.aria }));
const confirm = () => dialog().getByRole<HTMLButtonElement>("button", { name: /^Suggest for / });

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(cleanup);

function mount(over: Partial<ScreenerSuggestControl>) {
  const control: ScreenerSuggestControl = {
    available: 74, resuggestable: 0, pool: 74, sizes: [10, 25, 50, 74], size: 25,
    phase: "ready", quote: null, notice: null, progress: null,
    open: noop, openAgain: noop, choose: vi.fn(), confirm: vi.fn(), cancel: noop,
    ...over,
  };
  const world = mountPlace(modelOf({ flushes: 0 }, {
    waiting: [sender("lena", "Lena Hart")],
    waitingCount: 74,
    suggestedCount: 1,
    suggestedDests: ["reads"],
  }), { beside: { ...BESIDE, suggest: { control, priced: true, noAdvice: NO_RUN } } });
  return { ...world, control };
}

describe("the ask well's state", () => {
  it("idle: a price on screen, no dress, the confirm pressable", () => {
    mount({ quote: { senders: 12, credits: 12 } });
    expect(confirm().disabled).toBe(false);
    expect(confirm().getAttribute("aria-busy")).toBeNull();
    expect(dialog().getByText("12 senders · 12 credits", { exact: true })).toBeTruthy();
  });

  it("working while the price is being checked — the mark beside the sentence, nothing pressable", () => {
    mount({ phase: "pricing" });
    expect(dialog().getByRole("status", { busy: true }).textContent).toBe(S.pricing);
    expect(confirm().disabled).toBe(true);
  });

  it("working while the purchase runs — progress replaces the confirm and says so", () => {
    const { control } = mount({
      phase: "running", size: 50, quote: { senders: 40, credits: 40 },
      notice: "3 of 40 suggested…", progress: { done: 3, total: 40 },
    });
    expect(dialog().getByRole("status").textContent).toBe("3 of 40 suggested…");
    expect(dialog().queryByRole("button", { name: /^Suggest for / })).toBeNull();
    expect(dialog().getAllByText("3 of 40 suggested…", { exact: true })).toHaveLength(1);
    expect(dialog().queryByText("40 senders · 40 credits", { exact: true })).toBeNull();
    for (const rung of dialog().queryAllByRole<HTMLButtonElement>("button", { name: /^(?:10|25|50|All 74)$/ })) {
      expect(rung.disabled).toBe(true);
    }
    expect(control.choose).not.toHaveBeenCalled();
  });

  it("refused: the server answered with a sentence and no price", () => {
    mount({ quote: null, notice: S.stoppedCredits });
    expect(dialog().getByText(S.stoppedCredits, { exact: true })).toBeTruthy();
    expect(dialog().queryByText(S.pricing, { exact: true })).toBeNull();
    expect(confirm().disabled).toBe(true);
  });

  it("a set priced at zero is idle with a sentence — nothing was refused, there is nothing to buy", () => {
    mount({ quote: { senders: 0, credits: 0 }, notice: S.nothing });
    expect(dialog().getByText(S.nothing, { exact: true })).toBeTruthy();
    expect(dialog().queryByRole("status", { busy: true })).toBeNull();
    expect(confirm().disabled).toBe(true);
  });

  it("the size choices are grouped and Suggest is beside Apply", () => {
    const closed = mount({ phase: "closed" });
    expect(screen.getByRole("button", { name: S.open, expanded: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Apply 1$/ })).toBeTruthy();
    closed.view.unmount();

    mount({ quote: { senders: 12, credits: 12 } });
    const sizes = within(dialog().getByRole("group", { name: S.aria }));
    expect(sizes.getAllByRole("button").map((button) => button.textContent)).toEqual(["10", "25", "50", "All 74"]);
    expect(sizes.getByRole("button", { name: "25", pressed: true })).toBeTruthy();
  });
});
