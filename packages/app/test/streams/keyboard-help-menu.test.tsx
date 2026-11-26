/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { keySheetOver } from "../../src/keys/sheet/index.js";
import { afterEach, expect, it } from "vitest";
import { mountStreamFrame } from "./registered-world.js";
import ohbox from "../../messages/ohbox.en.json" with { type: "json" };
import search from "../../messages/search.en.json" with { type: "json" };

afterEach(cleanup);

it("Ohbox’s More menu opens the same shortcut sheet as ?", () => {
  mountStreamFrame({
    at: "#/ohbox",
    overs: { keys: keySheetOver },
  });
  const title = search.shortcuts.title;
  fireEvent.click(screen.getByRole("button", { name: ohbox.ohbox.list.menu }));
  const menu = within(screen.getByRole("menu", { name: ohbox.ohbox.list.menu }));
  const item = menu.getByRole("menuitem", { name: title });
  expect(item.getAttribute("aria-keyshortcuts")).toBe("?");
  fireEvent.click(item);
  expect(screen.getAllByRole("dialog", { name: title })).toHaveLength(1);
  fireEvent.keyDown(screen.getByRole("dialog", { name: title }), { key: "Escape" });
  fireEvent.keyDown(document.body, { key: "?" });
  expect(screen.getAllByRole("dialog", { name: title })).toHaveLength(1);
  fireEvent.keyDown(screen.getByRole("dialog", { name: title }), { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: ohbox.ohbox.list.menu }));
  fireEvent.keyDown(screen.getByRole("menu", { name: ohbox.ohbox.list.menu }), { key: "?", shiftKey: true });
  expect(screen.getAllByRole("dialog", { name: title })).toHaveLength(1);
  expect(screen.queryByRole("menu", { name: ohbox.ohbox.list.menu })).toBeNull();
});
