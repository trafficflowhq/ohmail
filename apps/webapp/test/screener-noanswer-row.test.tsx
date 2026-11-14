/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { ScreenerSenderDTO } from "@ohmail/wire";
import type { ScreenerSuggestControl } from "@ohmail/app/screener";
import { NO_RUN, hasRealSuggestion } from "@ohmail/app-logic/screener";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BESIDE, modelOf, mountPlace, sender } from "../../../packages/app/test/screener/screener-world.js";
import messages from "../messages/en.json";

const answered = { dest: "reads", confidence: 0.91, rationale: "a newsletter" } as const;
const unanswered = { dest: "screener", confidence: 0, rationale: "", noAnswer: "spend_unavailable" } as const;
const advice = (address: string, ai: ScreenerSenderDTO["ai"]): ScreenerSenderDTO =>
  sender(address, address, { from: { name: null, address }, ai });

const smallQueue = [
  advice("paper@x.test", answered),
  advice("letters@x.test", answered),
  advice("a@y.test", unanswered),
  advice("b@y.test", unanswered),
  advice("c@y.test", unanswered),
];

const closed: ScreenerSuggestControl = {
  available: 0, resuggestable: 19, pool: 0, sizes: [], size: 0,
  phase: "closed", quote: null, notice: null, progress: null,
  open: () => {}, openAgain: () => {}, choose: () => {}, cancel: () => {}, confirm: () => {},
};

function mount(waiting: ScreenerSenderDTO[], control?: ScreenerSuggestControl) {
  mountPlace(modelOf({ flushes: 0 }, {
    waiting,
    waitingCount: waiting.length,
    suggestedCount: waiting.filter(hasRealSuggestion).length,
    suggestedDests: ["reads"],
  }), {
    beside: control ? { ...BESIDE, suggest: { control, priced: true, noAdvice: NO_RUN } } : BESIDE,
  });
  expect(within(screen.getByRole("listbox", { name: "Screener" })).getAllByRole("option")).toHaveLength(waiting.length);
}

function open(address: string) {
  const list = within(screen.getByRole("listbox", { name: "Screener" }));
  const row = list.getByRole("option", { name: (name) => name.startsWith(address) });
  fireEvent.click(row);
  return screen.getByRole("region", { name: "Reading" });
}

const restingQueue = (withoutAdvice: number) => [
  ...Array.from({ length: 19 }, (_, i) => advice(`answered${i}@example.test`, answered)),
  ...Array.from({ length: withoutAdvice }, (_, i) => advice(`unanswered${i}@example.test`, unanswered)),
];

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(cleanup);

describe("a noAnswer row", () => {
  it("renders one plain sentence — no destination arrow, no 0.00", () => {
    mount(smallQueue);
    const reading = open("a@y.test");
    expect(within(reading).getAllByText(messages.screener.aiSkip.spend_unavailable, { exact: true })).toHaveLength(1);
    expect(reading.textContent).not.toContain("0.00");
    expect(reading.textContent).not.toContain("0% sure");
    expect(reading.textContent).not.toContain("→");

    const answeredReading = within(open("paper@x.test"));
    expect(answeredReading.getByRole("heading", { name: /paper@x.test goes to News/ })).toBeTruthy();
    expect(answeredReading.getByText("91% sure", { exact: true })).toBeTruthy();
  });

  it("the apply button and the filter chips read one selector", () => {
    mount(smallQueue);
    expect(screen.getByRole("button", { name: /^Apply 2 — News$/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^All 5$/ }));
    const filters = within(screen.getByRole("menu", { name: messages.screener.filterAria }));
    expect(filters.getByRole("menuitemradio", { name: /^All/ }).textContent).toContain("5");
    expect(filters.getByRole("menuitemradio", { name: /^News/ }).textContent).toContain("2");
    expect(filters.getByRole("menuitemradio", { name: /^No suggestion/ }).textContent).toContain("3");
  });
});

describe("the suggest control's resting sentence", () => {
  it("claims 'all suggested' only when no waiting sender lacks one", () => {
    mount(restingQueue(17), closed);
    expect(screen.getByRole("button", { name: "Suggest again…" })).toBeTruthy();
    expect(screen.queryByText(/have a suggestion\./)).toBeNull();
  });

  it("still states it when every sender truly has one — the positive control", () => {
    mount(restingQueue(0), closed);
    expect(screen.getByText("All 19 senders have a suggestion.", { exact: true })).toBeTruthy();
  });
});
