/** @vitest-environment jsdom */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { issue, mountStreamFrame, receipt } from "../../../packages/app/test/streams/registered-world.js";

afterEach(cleanup);

it.each([
  ["News", "reads", issue],
  ["Receipts", "receipts", receipt],
] as const)("%s exposes unread rows and cards without drawing unread dots", (place, route, letter) => {
  mountStreamFrame({
    at: `#/${route}`,
    letters: [letter("unread", 12), letter("read", 11, { unread: false })],
  });
  const stream = screen.getByRole("region", { name: `${place} stream` });
  const cardFor = (id: string) => stream.querySelector(`[data-stream-item="${id}"]`);
  const rowFor = (id: string) => document.querySelector(`[role="option"][data-id="${id}"]`);
  expect(within(stream).getAllByRole("heading").length).toBeGreaterThan(0);
  expect(rowFor("unread")).not.toBeNull();
  expect(cardFor("unread")).not.toBeNull();
  expect(rowFor("unread")?.hasAttribute("data-unseen")).toBe(true);
  expect(cardFor("unread")?.hasAttribute("data-unseen")).toBe(true);
  expect(rowFor("read")?.hasAttribute("data-unseen")).toBe(false);
  expect(cardFor("read")?.hasAttribute("data-unseen")).toBe(false);
  expect(rowFor("unread")?.querySelector(".dot-unread")).toBeNull();
  expect(cardFor("unread")?.querySelector(".dot-unread")).toBeNull();
});
