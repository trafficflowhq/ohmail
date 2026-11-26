/** @vitest-environment jsdom */
import { fireEvent, renderHook, screen, within } from "@testing-library/react";
import { useListWindow } from "@ohmail/app-logic/lists/list-window";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, message, mountShell, press, stubDom, unmountAll, waitFor } from "./_draft-shell.js";

beforeEach(() => {
  stubDom();
  localStorage.clear();
});
afterEach(unmountAll);

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

async function findResults() {
  const field = await screen.findByRole("textbox", { name: "Search" });
  await act(async () => { fireEvent.change(field, { target: { value: "kiln" } }); });
}

describe("a search hit opens exactly the clicked message", () => {
  it("opens the clicked message in the Ohbox and marks its row", async () => {
    const clicked = message("clicked", { subject: "Kiln delivery" });
    const neighbor = message("neighbor", { subject: "Kiln inspection", date: "2026-09-27T08:30:00Z" });
    await mountShell("#/search", [clicked, neighbor]);
    await findResults();
    await screen.findByRole("button", { name: /Kiln inspection/ });
    await press(await screen.findByRole("button", { name: /Kiln delivery/ }), "the delivery result");

    await waitFor(() => window.location.hash === "#/search/m/clicked?q=kiln", "the clicked letter's Search address");
    const picked = document.querySelector('[data-hit="clicked"] .oh-row');
    expect(picked?.hasAttribute("data-open")).toBe(true);
    expect(document.querySelector('[data-hit="neighbor"] .oh-row')?.hasAttribute("data-open")).toBe(false);
    expect(document.querySelector(".ob-list")).toBeNull();
    const reading = await screen.findByRole("region", { name: "Reading" });
    await within(reading).findByRole("heading", { name: "Kiln delivery" });
    expect(within(reading).queryByRole("heading", { name: "Kiln inspection" })).toBeNull();
  }, 20_000);
});

describe("locating a folded conversation", () => {
  it("marks the same row for every member of the conversation", async () => {
    const letters = [
      message("oldest", { subject: "Kiln estimate", threadId: "shared", date: "2026-09-25T08:00:00Z" }),
      message("older", { subject: "Kiln delivery", threadId: "shared", date: "2026-09-26T08:00:00Z" }),
      message("lead", { subject: "Kiln inspection", threadId: "shared", date: "2026-09-27T08:00:00Z" }),
    ];

    for (const letter of letters) {
      await mountShell("#/search", letters);
      await findResults();
      await press(await screen.findByRole("button", { name: new RegExp(letter.subject) }), "a member's result");
      await waitFor(() => window.location.hash === `#/search/m/${letter.id}?q=kiln`, "the member's Search address");
      const selected = document.querySelectorAll(".sr-hit .oh-row[data-open]");
      expect(selected).toHaveLength(1);
      expect(selected[0]?.closest("[data-hit]")?.getAttribute("data-hit")).toBe(letter.id);
      const reading = await screen.findByRole("region", { name: "Reading" });
      expect(Array.from(reading.querySelectorAll("[data-conv-id]"), (item) => item.getAttribute("data-conv-id")))
        .toEqual(expect.arrayContaining(letters.map(({ id }) => id)));
      await unmountAll();
    }
  }, 20_000);
});

describe("the windowed lists reveal an externally-set cursor", () => {
  it("all three windowed views scroll the row's offset into the window", () => {
    // The window derives from scrollTop, so revealing = scrolling the scroller. Each view
    // owns its arithmetic; what is pinned is that NONE of them relies on `scrollIntoView`
    // against a row the window never mounted (a silent no-op). Two spellings of the offset:
    // rows times one height where rows are equal, and the window's own prefix sum where they
    // are not (the Ohbox — see `useListWindow`'s height cache).
    const ohbox = read("../../../packages/app-logic/src/ohbox/window.ts");
    expect(ohbox).toMatch(/scrollTop = Math\.max\(0, [^)]*win\.offsetOf\(/);
    for (const place of ["news", "receipts"]) {
      expect(read(`../../../packages/app/src/${place}/place.ts`)).toContain("List: StreamList");
    }
    const streams = read("../../../packages/app/src/stream/StreamList.tsx");
    expect(streams).toMatch(/model\.items\.findIndex\(\(item\) => item\.id === model\.openId\)/);
    expect(streams).toMatch(/useListWindow\(\{[\s\S]*?cursor: model\.openId === null \? undefined : \{ id: model\.openId, index: slot \}/);
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "clientHeight", { value: 640 });
    const scrollerRef = { current: scroller };
    const { result, rerender, unmount } = renderHook(
      ({ index }) => useListWindow({ scrollerRef, count: 1_000, cursor: { id: String(index), index } }),
      { initialProps: { index: 0 } },
    );
    try {
      expect(result.current.end).toBeLessThan(800);
      rerender({ index: 800 });
      expect(scroller.scrollTop).toBe(result.current.offsetOf(800));
      expect(result.current.start).toBeLessThanOrEqual(800);
      expect(result.current.end).toBeGreaterThan(800);
    } finally {
      unmount();
    }
  });
});
