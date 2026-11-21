/** @vitest-environment jsdom */
import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { issue, mountStreamFrame, receipt } from "./registered-world.js";

afterEach(cleanup);

it.each([
  ["reads", "News", issue],
  ["receipts", "Receipts", receipt],
] as const)("%s holds the standing row when a new unread letter arrives above it", (route, name, make) => {
  const letters = [make("first", 13, { unread: false }), make("second", 12, { unread: false })];
  const { address, replaceEngine } = mountStreamFrame({ at: `#/${route}`, letters });
  const list = within(screen.getByRole("region", { name }));
  expect.soft(list.queryByRole("option", { selected: true })?.dataset.id).toBe("first");
  const region = screen.getByRole("region", { name: `${name} stream` });
  const scroller = region.querySelector<HTMLElement>(".oh-sheet-scroll")!;
  scroller.scrollTo = vi.fn();
  let replacement!: ReturnType<typeof replaceEngine>;
  act(() => {
    replacement = replaceEngine("acct-1", [make("new", 14), ...letters]);
  });
  expect(
    [...region.querySelectorAll<HTMLElement>("[data-stream-item]")].map(
      (item) => within(item).getByRole("heading").textContent,
    ),
  ).toEqual([make("new", 14).subject, ...letters.map((letter) => letter.subject)]);
  expect(list.queryByRole("option", { selected: true })?.dataset.id).toBe("first");
  expect(within(region).queryByRole("button", { name: "Collapse" })).toBeNull();
  expect(scroller.scrollTo).not.toHaveBeenCalled();
  expect(address.read()).toBe(`#/${route}`);
  expect(replacement.bodyAsks).toEqual([]);
  expect(replacement.mutations).toEqual([]);
});
