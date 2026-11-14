/** @vitest-environment jsdom */
import { cleanup, screen } from "@testing-library/react";
import { STREAM_CARD_FALLBACK_PX, estimateCardHeight } from "@ohmail/ui";
import { afterEach, expect, it, vi } from "vitest";
import { issue, mountStreamFrame, receipt } from "../../../packages/app/test/streams/registered-world.js";

const WIDTH = 620;
const preview = (i: number) => i % 2 ? "A line of mail. ".repeat(50) : "The first line";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function open(count: number, route: string, name: string, letter: typeof issue) {
  const letters = Array.from({ length: count }, (_, i) => letter(`letter-${i}`, 20 - i, {
    body: undefined, snippet: preview(i), unread: false,
  }));
  mountStreamFrame({ at: `#/${route}`, letters });
  const stream = screen.getByRole("region", { name: `${name} stream` });
  const cards = [...stream.querySelectorAll<HTMLElement>("[data-stream-window-item]")];
  expect(cards).toHaveLength(count);
  return cards;
}

it.each([
  ["reads", "News", issue],
  ["receipts", "Receipts", receipt],
] as const)("%s reserves each card at the measured column width with one width sample", (route, name, letter) => {
  vi.stubGlobal("innerHeight", 9000);
  let reads = 0;
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!.get!;
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (!this.closest("[data-reading-scroll]")) return original.call(this);
    reads++;
    return WIDTH;
  });
  open(12, route, name, letter);
  const atTwelve = reads;
  cleanup();
  const cards = open(40, route, name, letter);
  expect(atTwelve).toBeGreaterThan(0);
  expect(reads - atTwelve).toBe(atTwelve);
  for (const [i, card] of cards.entries()) {
    const expected = estimateCardHeight({
      width: WIDTH, subject: `${route === "reads" ? "Issue" : "Order"} ${20 - i}`,
      preview: preview(i), clamped: true,
    });
    expect(expected).not.toBe(STREAM_CARD_FALLBACK_PX);
    expect(card.style.containIntrinsicBlockSize).toBe(`auto ${expected}px`);
  }
});

it("reserves the documented fallback until the column can be measured", () => {
  const cards = open(6, "reads", "News", issue);
  for (const card of cards) {
    expect(card.style.containIntrinsicBlockSize).toBe(`auto ${STREAM_CARD_FALLBACK_PX}px`);
  }
});
