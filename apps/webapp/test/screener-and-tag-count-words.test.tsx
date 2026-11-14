/** @vitest-environment jsdom */
import { act, fireEvent, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { message, mountMailFrame, unmountAll, waitFor } from "./_registered-mail-frame.js";

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

function waitingLetter() {
  const held = message("waiting", { folder: "ohmail/Screener" });
  return { ...held, from: { ...held.from, address: `held-${held.from.address}` } };
}

it("the tag and Waiting counts name what they count", async () => {
  const letters = [
    message("tagged", { labels: ["studio"] }),
    waitingLetter(),
  ];
  const at = letters[0]!.updatedAt;
  const { el } = await mountMailFrame("#/ohbox", letters, { more: [{
    type: "tag", op: "create", id: "studio", updatedAt: at,
    entity: { id: "studio", name: "Studio", hue: "moss", createdAt: at, updatedAt: at },
  }] });
  const view = within(el);
  const tags = view.getByRole("button", { name: "Tags" });
  if (tags.getAttribute("aria-expanded") === "false") fireEvent.click(tags);
  const tag = view.getByRole("button", { name: /^Studio/ });
  expect.soft(tag.textContent).toContain("1");
  expect.soft(tag.title).toBe("1 message");

  const screener = view.getByRole("button", { name: /^Screener/ });
  fireEvent.click(screener);
  await waitFor(() => view.queryByRole("group", { name: "Screener sections" }) !== null, "Screener sections");
  const waiting = within(view.getByRole("group", { name: "Screener sections" })).getByRole("button", { name: /^Waiting/ });
  expect.soft(waiting.textContent).toContain("1");
  expect.soft(waiting.title).toBe("1 first-time sender waiting");
  expect(screener.title).toBe("1 first-time sender waiting");
});

it("the first open uses the Waiting queue already prepared over the Ohbox", async () => {
  const prepare = vi.fn((run: () => void) => setTimeout(run, 0));
  vi.stubGlobal("requestIdleCallback", prepare);
  vi.stubGlobal("cancelIdleCallback", clearTimeout);
  const held = waitingLetter();
  const { el } = await mountMailFrame("#/ohbox", [held]);
  const view = within(el);
  await waitFor(() => view.queryByRole("button", { name: /^Screener.*1/ }) !== null, "the Waiting count before opening");
  expect(view.queryByRole("listbox", { name: "Screener" })).toBeNull();
  expect(prepare).toHaveBeenCalledTimes(1);

  const firstRows: string[] = [];
  const commits = new MutationObserver(() => {
    const queue = view.queryByRole("listbox", { name: "Screener" });
    if (queue && firstRows.length === 0) firstRows.push(...within(queue).getAllByRole("option").map((row) => row.textContent ?? ""));
  });
  commits.observe(el, { childList: true, subtree: true });
  try {
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: /^Screener.*1/ }));
    });
    expect(firstRows).toEqual([expect.stringContaining("Ben Kiln")]);
    const queue = view.getByRole("listbox", { name: "Screener" });
    expect(within(queue).getAllByRole("option")).toHaveLength(1);
    expect(prepare).toHaveBeenCalledTimes(1);
  } finally {
    commits.disconnect();
  }
});
