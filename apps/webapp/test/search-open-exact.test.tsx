/** @vitest-environment jsdom */
import { fireEvent, screen, within } from "@testing-library/react";
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

    await waitFor(() => window.location.hash === "#/ohbox/m/clicked", "the clicked letter's Ohbox address");
    const list = await screen.findByRole("region", { name: "Messages" });
    const option = within(list).getByRole("option", { name: /Kiln delivery/ });
    expect(option.getAttribute("data-id")).toBe(clicked.id);
    expect(option.hasAttribute("data-open")).toBe(true);
    await waitFor(() => option.hasAttribute("data-located"), "the arrival mark on the clicked row");
    expect(within(list).getByRole("option", { name: /Kiln inspection/ }).hasAttribute("data-located")).toBe(false);
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
      await waitFor(() => window.location.hash === `#/ohbox/m/${letter.id}`, "the member's Ohbox address");
      const list = await screen.findByRole("region", { name: "Messages" });
      const rows = within(list).getAllByRole("option");
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row!.getAttribute("data-id")).toBe("lead");
      expect(row!.getAttribute("data-ids")?.split(" ")).toEqual(expect.arrayContaining(letters.map(({ id }) => id)));
      expect(row!.hasAttribute("data-open")).toBe(true);
      await waitFor(() => row!.hasAttribute("data-located"), "the arrival mark on the folded row");
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
    const window = read("../../../packages/app-logic/src/lists/list-window.ts");
    expect(window).toMatch(/el\.scrollTop = offsetOf\(cursorIndex\)/);

  });
});
