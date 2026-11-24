/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { issue, mountStreamFrame, receipt } from "./registered-world.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  HTMLElement.prototype.scrollTo ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const places = [
  ["reads", issue],
  ["receipts", receipt],
] as const;

it.each(places)("two deliberate d presses on a %s card file only that letter", async (place, make) => {
  const { mail } = mountStreamFrame({
    at: `#/${place}/m/selected`,
    letters: [make("selected", 10), make("beside", 9)],
  });
  fireEvent.keyDown(document.body, { key: "d" });
  const menu = screen.getByRole("menu", { name: "More" });
  const choice = within(menu).getByRole("menuitem", { name: "Delete" });
  for (const init of [
    { repeat: true },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { shiftKey: true },
    { isComposing: true },
  ]) {
    fireEvent.keyDown(choice, { key: "d", ...init });
  }
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
  expect(mail.mutations.filter((m) => m.kind === "message_delete")).toEqual([]);
  fireEvent.keyDown(choice, { key: "d" });
  expect(screen.getByRole("button", { name: /Undo/ })).toBeTruthy();
  expect(document.querySelector('.pl-list [data-id="beside"]')).toBeTruthy();
  expect(document.querySelector('.pl-list [data-id="selected"]')).toBeNull();
  expect(mail.mutations.filter((m) => m.kind === "message_delete")).toEqual([]);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(mail.mutations.filter((m) => m.kind === "message_delete")).toEqual([
    { kind: "message_delete", messageId: "selected" },
  ]);
});

it.each(places)("a %s card reaches Trash only after confirming its own Move", (place, make) => {
  mountStreamFrame({ at: `#/${place}/m/selected`, letters: [make("selected", 10), make("beside", 9)] });
  fireEvent.click(screen.getByRole("toolbar", { name: "Actions" }).querySelector("[data-more]")!);
  const menu = screen.getByRole("menu", { name: "More" });
  const choice = within(menu).getByRole("menuitem", { name: "Delete" });
  fireEvent.keyDown(choice, { key: "d" });
  expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
  fireEvent.click(choice);
  const confirmation = screen.getByRole("dialog", { name: /Move to Trash/ });
  expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
  fireEvent.click(within(confirmation).getByRole("button", { name: /Cancel/ }));
  expect(document.querySelector('.pl-list [data-id="selected"]')).toBeTruthy();
  fireEvent.click(screen.getByRole("toolbar", { name: "Actions" }).querySelector("[data-more]")!);
  fireEvent.click(
    within(screen.getByRole("menu", { name: "More" })).getByRole("menuitem", { name: "Delete" }),
  );
  fireEvent.click(
    within(screen.getByRole("dialog", { name: /Move to Trash/ })).getByRole("button", { name: /Move/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
  expect(document.querySelector('.pl-list [data-id="selected"]')).toBeTruthy();
});
