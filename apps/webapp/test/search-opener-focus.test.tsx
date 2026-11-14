/** @vitest-environment jsdom */
import { act, fireEvent, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { message, mountMailFrame, unmountAll, waitFor } from "./_registered-mail-frame.js";

afterEach(unmountAll);

it("Search, opened from the rail, returns to the rail's Search row", async () => {
  const { el } = await mountMailFrame("#/ohbox", [message("one")]);
  const view = within(el);
  const opener = view.getByRole("button", { name: "Search" });
  opener.focus();
  await act(async () => {
    fireEvent.keyDown(opener, { key: "Enter" });
    fireEvent.click(opener);
  });
  const searchField = () => view.queryByRole("textbox", { name: "Search" });
  await waitFor(() => document.activeElement === searchField(), "Search field takes focus");
  await act(async () => {
    fireEvent.keyDown(searchField()!, { key: "Escape" });
  });
  await waitFor(() => searchField() === null, "Escape leaves Search");
  expect(document.activeElement).toBe(opener);
});
