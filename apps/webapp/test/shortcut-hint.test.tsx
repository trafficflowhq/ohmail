/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { keySheetOver } from "@ohmail/app/keys/sheet";
import { paletteOver } from "@ohmail/app/palette";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountStreamFrame } from "../../../packages/app/test/streams/registered-world.js";
import { stubDom } from "./_draft-shell.js";
import en from "../messages/en.json";

beforeEach(() => stubDom());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("every pane-foot strip is the affordance, not a legend", () => {
  it("the four views that had strips now render <ShortcutHint />", () => {
    for (const [at, name] of [
      ["/ohbox", "Ohbox"], ["/reads", "News"], ["/receipts", "Receipts"], ["/screener", "Screener"],
    ]) {
      const { page } = mountStreamFrame({
        at: "#" + at,
        overs: { palette: paletteOver, keys: keySheetOver },
        catalogue: en,
      });
      try {
        const places = within(screen.getByRole("navigation", { name: "Places" }));
        expect(places.getByRole("button", { name: new RegExp(`^${name}(?:$| \\d+$)`), current: "page" })).toBeTruthy();
        fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
        const palette = within(screen.getByRole("dialog", { name: "Command palette" }));
        const [command] = palette.getAllByRole("option", { name: /Keyboard shortcuts/ });
        expect(palette.getAllByRole("option", { name: /Keyboard shortcuts/ })).toHaveLength(1);
        expect(within(command!).getByText("?", { exact: true })).toBeTruthy();
        fireEvent.click(command!);
        expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
        expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
      } finally {
        page.unmount();
      }
    }
  });
});
