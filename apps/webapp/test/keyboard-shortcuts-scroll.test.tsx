/** @vitest-environment jsdom */
import { act, fireEvent, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { message, mountMailFrame, unmountAll, waitFor } from "./_registered-mail-frame.js";

afterEach(unmountAll);

it("Tab reaches the named shortcuts region and scroll keys belong to the sheet", async () => {
  const { el } = await mountMailFrame("#/ohbox", [message("one"), message("two")]);
  const options = () => within(el).getAllByRole("option");
  const opener = options()[0]!;
  opener.focus();
  fireEvent.keyDown(opener, { key: "?" });
  const dialog = () => within(el).queryByRole("dialog", { name: "Keyboard shortcuts" });
  await waitFor(() => dialog() !== null, "keyboard shortcuts");
  const close = within(dialog()!).getByRole("button", { name: "Close" });
  const region = within(dialog()!).getByRole("region", { name: "Keyboard shortcuts" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: "Tab" });
  expect(document.activeElement).toBe(region);

  const selection = options().map((option) => option.getAttribute("aria-selected"));
  for (const key of ["PageDown", "ArrowDown", "End", "PageUp", "Home", " "]) {
    expect(fireEvent.keyDown(region, { key })).toBe(true);
    expect(dialog()).not.toBeNull();
  }
  expect(options().map((option) => option.getAttribute("aria-selected"))).toEqual(selection);
  await act(async () => { fireEvent.keyDown(region, { key: "Insert" }); });
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(opener);
});
