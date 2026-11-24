/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { issue, mountStreamFrame, receipt } from "./registered-world.js";
beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= () => undefined;
  HTMLElement.prototype.scrollTo ??= () => undefined;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const place of ["News", "Receipts"] as const) {
  it(`${place}: the phone dock stays available on the closed feed`, () => {
    const make = place === "News" ? issue : receipt;
    const at = place === "News" ? "#/reads" : "#/receipts";
    mountStreamFrame({ at, phone: true, withReply: true, letters: [make("a", 20, { unread: false })] });
    const dock = within(screen.getByRole("navigation", { name: "Places" }));
    expect(dock.getByRole("button", { name: "More" })).toBeTruthy();
    const feed = within(screen.getByRole("region", { name: `${place} stream` }));
    expect(feed.queryByRole("toolbar", { name: "Actions" })).toBeNull();
    fireEvent.click(feed.getByRole("button", { name: "Read in full" }));
    const reader = within(screen.getByRole("region", { name: "Open message" }));
    expect(reader.getByRole("toolbar", { name: "Actions" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Places" })).toBeNull();
  });
}

it("uses an explicit receipt total in both the list and the preview", () => {
  mountStreamFrame({
    at: "#/receipts",
    letters: [receipt("a", 20, { body: "Two tickets.\nTotal paid: CHF 96.00", snippet: "Two tickets" })],
  });
  const row = screen.getByRole("option", { name: /Order 20/ });
  expect(within(row).getByText("CHF 96.00", { exact: true })).toBeTruthy();
  const preview = screen.getByRole("region", { name: "Receipts stream" });
  expect(within(preview).getByText("CHF 96.00", { exact: true })).toBeTruthy();
});
