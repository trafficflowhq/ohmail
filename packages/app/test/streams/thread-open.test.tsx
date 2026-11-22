/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { issue, mountStreamFrame, receipt } from "./registered-world.js";

beforeEach(() => {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTo");
  Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: () => {} });
  return () => {
    if (descriptor) Object.defineProperty(Element.prototype, "scrollTo", descriptor);
    else Reflect.deleteProperty(Element.prototype, "scrollTo");
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each([
  ["#/reads", "News", issue],
  ["#/receipts", "Receipts", receipt],
] as const)("opens a conversation in %s on its latest item", async (at, name, letter) => {
  const errors = vi.spyOn(console, "error");
  const older = letter("older", 2, { subject: "The first note", threadId: "thread" });
  const newer = letter("newer", 3, { subject: "The latest note", threadId: "thread" });
  mountStreamFrame({ at, letters: [older, newer] });
  const stream = screen.getByRole("region", { name: `${name} stream` });
  const card = await waitFor(() => {
    const item = stream.querySelector<HTMLElement>('[data-stream-item="older"]');
    expect(item).toBeTruthy();
    return item!;
  });
  fireEvent.click(within(card).getByRole("button", { name: "Expand" }));
  expect(
    [...card.querySelectorAll("[data-conv-id]")].map((node) => node.getAttribute("data-conv-id")),
  ).toEqual(["older", "newer"]);
  expect(errors.mock.calls.flat()).not.toContain("[view] render failed");
  expect(card.querySelector('[aria-current="true"]')?.getAttribute("data-conv-id")).toBe("newer");
});
