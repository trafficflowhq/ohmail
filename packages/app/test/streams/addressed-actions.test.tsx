/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { issue, mountStreamFrame, receipt } from "./registered-world.js";

afterEach(cleanup);

it.each([
  ["reads", "News", issue, "focus"],
  ["receipts", "Receipts", receipt, "pointer"],
  ["reads", "News", issue, "key"],
] as const)("%s (%s) retargets and closes only the earlier expanded card (%#)", (route, name, make, how) => {
  const first = make("first", 13, { unread: false });
  const second = make("second", 12, { unread: false });
  const { address, mail } = mountStreamFrame({ at: `#/${route}`, letters: [first, second] });
  const region = screen.getByRole("region", { name: `${name} stream` });
  region.querySelector<HTMLElement>(".oh-sheet-scroll")!.scrollTo = () => {};
  const card = (subject: string) =>
    within(region).getByRole("heading", { name: subject }).closest<HTMLElement>("[data-stream-item]")!;
  for (const letter of [first, second])
    fireEvent.click(within(region).getByRole("heading", { name: letter.subject }));
  expect(address.read()).toBe(`#/${route}/m/second`);
  const earlier = card(first.subject!);
  if (how === "focus") act(() => earlier.focus());
  else if (how === "pointer") fireEvent.click(within(earlier).getByRole("heading", { name: first.subject }));
  else fireEvent.keyDown(document.activeElement ?? document.body, { key: "k" });
  expect(address.read()).toBe(`#/${route}/m/first`);
  expect(within(region).getAllByRole("toolbar", { name: "Actions" })).toHaveLength(1);
  fireEvent.click(
    within(screen.getByRole("toolbar", { name: "Actions" })).getByRole("button", { name: "Mark unread" }),
  );
  expect(mail.mutations.filter((m) => m.kind === "mark_seen")).toEqual([
    expect.objectContaining({ messageIds: ["first"], unread: true }),
  ]);
  fireEvent.click(within(earlier).getByRole("button", { name: "Collapse" }));
  expect(address.read()).toBe(`#/${route}`);
  expect(within(region).getAllByRole("toolbar", { name: "Actions" })).toHaveLength(1);
  expect(within(card(second.subject!)).getByRole("button", { name: "Collapse" })).toBeTruthy();
});
