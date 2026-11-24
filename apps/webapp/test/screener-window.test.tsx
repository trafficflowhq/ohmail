/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ESTIMATED_ROW_PX, FALLBACK_VIEWPORT_PX, FULL_RANGE_MAX_ROWS } from "@ohmail/app-logic/lists/list-window";
import { modelOf, mountPlace, sender } from "../../../packages/app/test/screener/screener-world.js";

const SPAN = Math.floor(FALLBACK_VIEWPORT_PX / ESTIMATED_ROW_PX) + 1;
const ROWS_AT_TOP = SPAN + 8;
const ROWS_MOUNTED = SPAN + 16;
const list = () => screen.getByRole("listbox", { name: "Screener" });
const ids = () => within(list()).getAllByRole("option").map((option) => option.dataset.id);

function mount(senders: number) {
  mountPlace(modelOf({ flushes: 0 }, {
    waiting: Array.from({ length: senders }, (_, i) => sender(`m${i}`, `Sender ${i}`)),
    waitingCount: senders,
  }));
  return list().parentElement!;
}

async function frames(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
}

async function scroll(scroller: HTMLElement, index: number) {
  scroller.scrollTop = index * ESTIMATED_ROW_PX;
  fireEvent.scroll(scroller);
  await frames();
}

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});
afterEach(cleanup);

describe("the Screener queue is a window", () => {
  it("a queue under the window's floor renders whole — the positive control", () => {
    mount(40);
    expect(ids()).toHaveLength(40);
    expect(40).toBeLessThanOrEqual(FULL_RANGE_MAX_ROWS);
  });

  it("a long queue of waiting senders mounts a viewport's rows, and the rest is reserved height", () => {
    mount(1510);
    expect(ids()).toHaveLength(ROWS_AT_TOP);
    expect(ids()[0]).toBe("m0");
    const spacers = list().querySelectorAll<HTMLElement>(":scope > [aria-hidden]");
    expect(spacers[0]?.style.height).toBe("0px");
    expect(spacers[1]?.style.height).toBe(`${(1510 - ROWS_AT_TOP) * ESTIMATED_ROW_PX}px`);
  });

  it("scrolling moves the window through the queue, and the mounted count stays a window", async () => {
    const scroller = mount(1510);
    await scroll(scroller, 700);
    expect(ids()).toContain("m700");
    expect(ids()).not.toContain("m0");
    expect(ids()).toHaveLength(ROWS_MOUNTED);
  });

  it("j from a selection the window has scrolled past lands on the next sender's row", async () => {
    const scroller = mount(1510);
    await scroll(scroller, 900);
    expect(ids()).not.toContain("m1");
    fireEvent.keyDown(document.body, { key: "j" });
    await frames();
    expect(ids()).toContain("m1");
    expect(within(list()).getByRole("option", { selected: true }).dataset.id).toBe("m1");
  });
});
