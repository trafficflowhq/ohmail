/** @vitest-environment jsdom */
import { fireEvent, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { EngineMessage } from "@ohmail/wire";
import en from "../messages/en.json";
import { message, mountMailFrame, unmountAll, waitFor } from "./_registered-mail-frame.js";

afterEach(unmountAll);

const folderCases = [
  ["Ohbox", "#/ohbox", "INBOX", false],
  ["News", "#/reads", "ohmail/News", false],
  ["Receipts", "#/receipts", "ohmail/Receipts", false],
  ["Screener", "#/screener", "ohmail/Screener", false],
  ["Answer Later", "#/triage", "INBOX", false],
  ["Trash", "#/trash", "INBOX", false],
  ["History", "#/history", "INBOX", false],
  ["Search", "#/search", "INBOX", false],
  ["News on a phone", "#/reads", "ohmail/News", true],
  ["Receipts on a phone", "#/receipts", "ohmail/Receipts", true],
  ["Ohbox on a phone", "#/ohbox", "INBOX", true],
] as const;

it.each(folderCases)("%s enters and leaves selection with a single circle", async (name, route, folder, phone) => {
  const letters = ["first", "second"].map((id, index) => {
    const letter = message(id, {
      subject: `Workshop ${id}`,
      folder: folder as EngineMessage["folder"],
      date: new Date(Date.UTC(2026, 10, 20 - index, 9)).toISOString(),
    });
    return {
      ...letter,
      from: {
        name: index === 0 ? "Ada" : "Bea",
        address: name === "Screener" ? `${id}@example.invalid` : letter.from.address,
      },
      triage: name === "Answer Later" ? {
        messageId: id, state: "reply_later" as const, bubbleUpAt: null,
        setAt: letter.updatedAt, updatedAt: letter.updatedAt,
      } : null,
    };
  });
  const { el, address } = await mountMailFrame(route, name === "Trash" ? [] : letters, {
    phone,
    prepareEngine(engine) {
      if (name === "Trash") {
        engine.trashAvailable = () => true;
        engine.listTrash = async () => ({
          state: "ready", nextCursor: null,
          items: letters.map((letter) => ({ ...letter, trashedAt: letter.date!, restoreTo: "INBOX" })),
        });
      }
    },
  });
  const view = within(el);
  if (name === "Search") {
    fireEvent.change(view.getByRole("textbox", { name: en.search.aria }), { target: { value: "workshop" } });
  }
  const circles = () => view.queryAllByRole("button", { name: en.ohbox.keyPick });
  const bar = () => view.queryByRole("toolbar", { name: en.ohbox.bar.label });
  await waitFor(() => circles().length === 2, "both selection circles are available");
  const [circle, other] = circles();
  const otherAvatars = view.getAllByText("B", { exact: true });
  const before = address.read();
  const readerActions = () => view.queryAllByRole("toolbar").filter((toolbar) => toolbar !== bar());
  const beforeActions = readerActions();
  expect(bar()).toBeNull();

  if (phone) {
    fireEvent.pointerDown(circle!, { pointerType: "touch" });
    fireEvent.pointerUp(circle!, { pointerType: "touch" });
  }
  fireEvent.click(circle!);
  const selection = bar();
  expect(selection).not.toBeNull();
  expect(within(selection!).getByRole("button", { name: /^1 selected\b/ })).toBeTruthy();
  expect(circle!.getAttribute("aria-pressed")).toBe("true");
  expect(other!.getAttribute("aria-pressed")).toBe("false");
  expect(view.queryAllByText("B", { exact: true })).toEqual(otherAvatars);
  expect(address.read()).toBe(before);
  const phoneStream = phone && (name === "News on a phone" || name === "Receipts on a phone");
  expect(readerActions()).toEqual(phoneStream ? [] : beforeActions);

  fireEvent.click(circle!);
  expect(bar()).toBeNull();
  expect(circle!.tabIndex).toBe(0);
  if (phoneStream) expect(readerActions()).toEqual(beforeActions);
  circle!.focus();
  // A native button's Enter key dispatches a click in the browser.
  expect(fireEvent.keyDown(circle!, { key: "Enter" })).toBe(true);
  expect(bar()).toBeNull();
  fireEvent.click(circle!);
  expect(bar()).not.toBeNull();
  fireEvent.keyDown(circle!, { key: "Escape" });
  expect(bar()).toBeNull();
  expect(circle!.getAttribute("aria-pressed")).toBe("false");
  expect(address.read()).toBe(before);
  expect(circles()).toHaveLength(2);

  fireEvent.click(circle!);
  fireEvent.click(other!, { shiftKey: true });
  expect(within(bar()!).getByRole("button", { name: /^2 selected\b/ })).toBeTruthy();
});

it("a focused Ohbox row opens on Enter while a pointer press picks it", async () => {
  const { el } = await mountMailFrame("#/ohbox", [message("first"), message("second")]);
  const view = within(el);
  const row = view.getByRole("option", { name: /Subject second/ });
  const first = view.getByRole("option", { name: /Subject first/ });
  fireEvent.click(within(first.parentElement!).getByRole("button", { name: en.ohbox.keyPick }));
  fireEvent.click(view.getByText("Subject second"));
  expect(view.getByRole("button", { name: /^2 selected\b/ })).toBeTruthy();
  expect(view.queryByRole("toolbar", { name: en.message.actions })).toBeNull();

  row.focus();
  fireEvent.keyDown(row, { key: "Enter" });
  expect(view.getByRole("button", { name: /^2 selected\b/ })).toBeTruthy();
  expect(row.hasAttribute("data-open")).toBe(true);
});

it("a phone News card still opens by its body when a circle is selected", async () => {
  const letters = ["first", "second"].map((id) => message(id, { folder: "ohmail/News" }));
  const { el, address } = await mountMailFrame("#/reads", letters, { phone: true });
  const view = within(el);
  fireEvent.click(view.getAllByRole("button", { name: en.ohbox.keyPick })[0]!);
  fireEvent.click(view.getByText("Subject second"));
  expect(address.read()).toBe("#/reads/m/second");
});

it("exposes a separate selection button and announces the first count in an existing region", async () => {
  const { el } = await mountMailFrame("#/ohbox", [message("first")]);
  const view = within(el);
  const circle = view.getByRole("button", { name: en.ohbox.keyPick });
  const liveSelector = '[aria-live="polite"][aria-atomic="true"]';
  const announcement = el.querySelector(liveSelector);
  expect.soft(circle.parentElement?.closest('[role="option"], [role="button"], button')).toBeNull();
  expect.soft(announcement?.textContent).toBe("");

  fireEvent.click(circle);
  expect(el.querySelector(liveSelector)).toBe(announcement);
  expect(announcement?.textContent).toBe("1 selected");
});
