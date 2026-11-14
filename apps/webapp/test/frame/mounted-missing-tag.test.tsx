/** @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import en from "../../messages/en.json";
import { closeMailPage, inboxPage, mountMailPage, prepareMailPage, tick } from "../fixtures/mounted-mail-page";

afterEach(closeMailPage);

it.each([1, 0])("replaces a missing tag with the Ohbox when the mirror holds %d letters", async (count) => {
  await prepareMailPage({ "GET /api/sync": () => inboxPage(count) });
  window.history.replaceState(null, "", "#/tag/no-such-tag");
  const before = window.history.length;
  const rowsUnderTheTag: number[] = [];
  const observer = new MutationObserver(() => {
    if (window.location.hash === "#/tag/no-such-tag") {
      rowsUnderTheTag.push(screen.queryAllByRole("option").length);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  try {
    const page = await mountMailPage();
    await tick(1_000);
    expect(window.location.hash).toBe("#/ohbox");
    expect(rowsUnderTheTag.filter(Boolean)).toEqual([]);
    expect(window.history.length).toBe(before);
    expect(page.getByRole("button", { name: /^Ohbox\b/, current: "page" })).toBeTruthy();
    expect(page.getAllByRole("region", { name: en.frame.landmark.list }).length).toBeGreaterThan(0);
    expect(page.queryAllByRole("option")).toHaveLength(count);
  } finally {
    observer.disconnect();
  }
}, 45_000);
