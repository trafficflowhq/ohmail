/** @vitest-environment jsdom */
import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import receiptsWords from "../../../packages/app/messages/receipts.en.json";
import { mountStreamFrame, receipt } from "../../../packages/app/test/streams/registered-world.js";

/**
 * THE RECEIPTS "APPLICATION ERROR" — the windowed list must not measure its own leading row and
 * feed that measurement back into the arithmetic that CHOOSES the leading row.
 *
 * A scrolled window whose leading row sets the height used to select that row can oscillate
 * between a short row and a tall one. With no layout in jsdom, give the real Receipts list rows
 * alternating heights and scroll its mounted list far enough to measure a new slice.
 */

const ISO = "2026-08-04T09:00:00.000Z";
const N = 5000;

const measuredRows = new Set<number>();
const origOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");

function mountReceipts(): HTMLElement {
  const start = Date.parse(ISO);
  const letters = Array.from({ length: N }, (_, index) => {
    const at = new Date(start - index * 1000).toISOString();
    return receipt(`m${index}`, 10, { date: at, arrivedAt: at });
  });
  mountStreamFrame({ at: "#/receipts", letters });
  const list = screen.getByRole("region", { name: receiptsWords.receipts.list.label });
  const scroller = list.querySelector<HTMLElement>(".pl-scroll");
  if (!scroller) throw new Error("Receipts has no list scroller");
  Object.defineProperty(scroller, "clientHeight", { value: 640 });
  return scroller;
}

async function scrollTo(scroller: HTMLElement, px: number): Promise<void> {
  scroller.scrollTop = px;
  await act(async () => {
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

describe("the windowed Receipts list does not loop into an Application error", () => {
  beforeEach(() => {
    measuredRows.clear();
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.dataset.index !== undefined && this.dataset.id?.startsWith("m")) {
          const index = Number(this.dataset.id.slice(1));
          measuredRows.add(index);
          return 80 + (index % 2);
        }
        return 0;
      },
    });
  });
  afterEach(() => {
    cleanup();
    if (origOffsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", origOffsetHeight);
    else delete (HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight;
    vi.restoreAllMocks();
  });

  it("does not run away when the window slides over rows of differing height", async () => {
    const errs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errs.push(String(a[0])); });
    const scroller = mountReceipts();
    expect(measuredRows.has(0)).toBe(true);
    const initiallyMeasured = new Set(measuredRows);

    let threw: unknown = null;
    try {
      await scrollTo(scroller, 8100);
    } catch (e) {
      threw = e;
    }
    spy.mockRestore();

    expect(threw, "the windowed measurement fed back into the window and React looped to a crash").toBeNull();
    expect(errs.join("\n"), "React logged a max-update-depth runaway — the Receipts Application error")
      .not.toMatch(/Maximum update depth/);
    const newlyMeasured = [...measuredRows].filter((row) => !initiallyMeasured.has(row));
    expect(newlyMeasured.some((row) => row % 2 === 0)).toBe(true);
    expect(newlyMeasured.some((row) => row % 2 === 1)).toBe(true);
  });
});
