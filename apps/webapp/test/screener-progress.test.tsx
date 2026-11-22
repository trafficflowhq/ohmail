/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScreenerSuggestControl } from "@ohmail/app/screener";
import { NO_RUN, type ScreenerState } from "@ohmail/app-logic/screener";
import { BESIDE, modelOf, mountPlace, sender } from "../../../packages/app/test/screener/screener-world.js";

interface Progress { done: number; total: number }

const QUEUE = [sender("one", "One")];

function running(progress: Progress | null): ScreenerSuggestControl {
  return {
    available: 40, resuggestable: 0, pool: 40, sizes: [40], size: 40, phase: "running",
    quote: { senders: 40, credits: 40 }, notice: null, progress,
    open: () => {}, openAgain: () => {}, choose: () => {}, confirm: () => {}, cancel: () => {},
  };
}

function mount(over: Partial<ScreenerState> = {}, control?: ScreenerSuggestControl) {
  const model = modelOf({ flushes: 0 }, { waiting: QUEUE, waitingCount: QUEUE.length, ...over });
  return mountPlace(model, {
    beside: control === undefined ? BESIDE : {
      ...BESIDE, suggest: { priced: true, control, noAdvice: NO_RUN },
    },
  });
}

afterEach(cleanup);

const tracks = () => screen.queryAllByRole("progressbar", { hidden: true });
const amounts = () => tracks().map((bar) => [bar.getAttribute("value"), bar.getAttribute("max")]);

describe("the suggest run's progress bar", () => {
  it("draws the field's own two numbers, and stays out of the announcement", () => {
    mount({}, running({ done: 3, total: 40 }));
    expect(amounts()).toEqual([["3", "40"]]);
    expect(tracks()[0]?.getAttribute("aria-hidden")).toBe("true");
    const ask = screen.getByRole("dialog", { name: "How many waiting senders to suggest for" });
    expect(within(ask).getByText("3 of 40 suggested…").getAttribute("role")).toBe("status");
  });

  it("draws nothing when the run is not in flight", () => {
    mount({}, running(null));
    expect(tracks()).toEqual([]);
    expect(screen.getByRole("button", { name: "Suggest…" })).toBeTruthy();
  });

  it("draws nothing rather than NaN when there is no denominator", () => {
    mount({}, running({ done: 0, total: 0 }));
    expect(tracks()).toEqual([]);
    expect(document.body.textContent ?? "").not.toContain("NaN");
  });
});

describe("the apply-all run's progress", () => {
  it("says how far it has got, in words and as a track", () => {
    mount({ applying: { done: 7, total: 40 } });
    expect(screen.getByText("Applying 7 of 40…").getAttribute("role")).toBe("status");
    expect(amounts()).toEqual([["7", "40"]]);
    expect(tracks()[0]?.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows nothing at all when no bulk is running", () => {
    mount({ applying: null });
    expect(screen.queryByText(/^Applying /)).toBeNull();
    expect(tracks()).toEqual([]);
  });

  it("the Apply verb carries the run and refuses a second press while it is on", () => {
    const applyAll = vi.fn();
    const suggested = [
      sender("one", "One", { ai: { dest: "ohbox" } }),
      sender("two", "Two", { ai: { dest: "reads" } }),
      sender("three", "Three", { ai: { dest: "reads" } }),
    ];
    const gate = {
      waiting: suggested, waitingCount: suggested.length, suggestedCount: 3, suggestedDests: ["ohbox", "reads"], applyAll,
    } satisfies Partial<ScreenerState>;
    const world = mount({ ...gate, applying: { done: 7, total: 40 } });
    const progress = screen.getByText("Applying 7 of 40…");
    expect(progress.getAttribute("role")).toBe("status");
    expect(screen.queryByRole("button", { name: "Apply 3" })).toBeNull();
    fireEvent.click(progress);
    expect(applyAll).not.toHaveBeenCalled();

    world.again(modelOf({ flushes: 0 }, { ...gate, applying: null }));
    const idle = screen.getByRole<HTMLButtonElement>("button", { name: "Apply 3" });
    expect(idle.disabled).toBe(false);
    expect(idle.getAttribute("aria-busy")).toBeNull();
    fireEvent.click(idle);
    expect(applyAll).toHaveBeenCalledTimes(1);
  });

  it("draws nothing rather than NaN when there is no denominator", () => {
    mount({ applying: { done: 0, total: 0 } });
    expect(tracks()).toEqual([]);
    expect(document.body.textContent ?? "").not.toContain("NaN");
  });
});
