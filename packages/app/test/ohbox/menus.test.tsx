/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { at, msg, NONE, ohbox } from "./ohbox-world.js";
import { wideWindow } from "./setup.js";

beforeEach(wideWindow);
afterEach(cleanup);

const two = () => [
  msg({ id: "a", subject: "One", date: at(10) }),
  msg({ id: "b", subject: "Two", date: at(9) }),
];

describe("the menus", () => {
  it("Mark all read names the engine's unread letters while the first sync is still owed, as the shipped head did", () => {
    const world = ohbox({ newForYou: two(), settled: false, owed: true });
    const button = screen.getByRole("button", { name: "Mark all 2 unread messages read" });
    expect(button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true").toBe(false);
    fireEvent.click(button);
    expect(world.said.markedAll).toEqual([["a", "b"]]);
  });

  it("the row's menu opens where it was asked and runs the row's own verbs", () => {
    const world = ohbox({ newForYou: two() });
    fireEvent.contextMenu(screen.getByRole("option", { name: "b: Two" }), { clientX: 30, clientY: 40 });
    fireEvent.click(screen.getByRole("menuitem", { name: /Done/ }));
    expect(world.said.marked).toEqual([{ ids: ["b"], unread: false }]);
    fireEvent.contextMenu(screen.getByRole("option", { name: "a: One" }), { clientX: 30, clientY: 20 });
    fireEvent.click(screen.getByRole("menuitem", { name: /Select/ }));
    expect(screen.getByRole("option", { name: "a: One" }).getAttribute("aria-selected")).toBe("true");
  });

  it("the row's menu runs a verb on the letter the row opens on", () => {
    const acted: Array<[string, string]> = [];
    ohbox({
      newForYou: two(),
      onAction: (a, m) => {
        acted.push([a, m.id]);
      },
    });
    fireEvent.contextMenu(screen.getByRole("option", { name: "b: Two" }), { clientX: 30, clientY: 40 });
    fireEvent.click(screen.getByRole("menuitem", { name: /Later/ }));
    fireEvent.contextMenu(screen.getByRole("option", { name: "a: One" }), { clientX: 30, clientY: 20 });
    fireEvent.click(screen.getByRole("menuitem", { name: /Reply/ }));
    expect(acted).toEqual([
      ["later", "b"],
      ["reply", "a"],
    ]);
  });

  it("the list's menu pulls new mail and marks all read", () => {
    const world = ohbox({ newForYou: two() });
    fireEvent.click(screen.getByRole("button", { name: "Ohbox actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Pull new mail/ }));
    expect(world.said.pulled).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Ohbox actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Mark all read/ }));
    expect(world.said.markedAll).toEqual([["a", "b"]]);
  });

  it("the list's menu prints no count of unread mail before the Ohbox may state one, and its verb stands", () => {
    const world = ohbox({ newForYou: two(), settled: false, owed: true });
    fireEvent.click(screen.getByRole("button", { name: "Ohbox actions" }));
    const all = screen.getByRole("menuitem", { name: /Mark all read/ });
    expect(all.textContent, "a count while the first sync is still owed").not.toMatch(/\d/);
    fireEvent.click(all);
    expect(world.said.markedAll).toEqual([["a", "b"]]);
    cleanup();
    ohbox({ newForYou: two() });
    fireEvent.click(screen.getByRole("button", { name: "Ohbox actions" }));
    expect(screen.getByRole("menuitem", { name: /Mark all read/ }).textContent).toContain("2");
  });

  it("the head's Mark all read stands only while something is unread; the list's menu keeps it", () => {
    ohbox({ previouslySeen: [msg({ id: "r", unread: false })] });
    expect(screen.queryByRole("button", { name: /^Mark all/ })).toBeNull();
    cleanup();
    ohbox({ newForYou: two() });
    expect(screen.getByRole("button", { name: "Mark all 2 unread messages read" })).not.toBeNull();
  });

  it("Mark all read stands disabled with nothing unread, and Pull is absent where the host cannot pull", () => {
    ohbox({ previouslySeen: [msg({ id: "r", unread: false })] }, { side: { pull: NONE } });
    fireEvent.click(screen.getByRole("button", { name: "Ohbox actions" }));
    expect(screen.queryByRole("menuitem", { name: /Pull new mail/ })).toBeNull();
    const all = screen.getByRole("menuitem", { name: /Mark all read/ });
    expect(all.getAttribute("aria-disabled") === "true" || (all as HTMLButtonElement).disabled).toBe(true);
  });
});
