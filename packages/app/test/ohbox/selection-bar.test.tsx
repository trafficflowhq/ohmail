/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { at, msg, ohbox } from "./ohbox-world.js";
import { wideWindow } from "./setup.js";

beforeEach(wideWindow);
afterEach(cleanup);

const three = () =>
  ["a", "b", "c", "d"].map((id, i) => msg({ id, subject: id.toUpperCase(), date: at(10 - i) }));
const pick = (name: string) => fireEvent.click(screen.getByRole("option", { name }), { metaKey: true });

describe("the selection's bar", () => {
  it("says how many are picked, and its count lets them go", () => {
    ohbox({ newForYou: three() });
    expect(screen.queryByRole("toolbar")).toBeNull();
    pick("a: A");
    pick("b: B");
    pick("c: C");
    const bar = screen.getByRole("toolbar", { name: "Selection" });
    const count = within(bar).getByRole("button", { name: "3 selected — clear the selection" });
    fireEvent.click(count);
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.getByRole("option", { name: "a: A" }).getAttribute("aria-selected")).toBe("false");
  });

  it("Delete asks first, and only the answer deletes", () => {
    const world = ohbox({ newForYou: three() });
    pick("a: A");
    pick("b: B");
    const bar = screen.getByRole("toolbar", { name: "Selection" });
    fireEvent.click(within(bar).getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    expect(world.said.bulk).toEqual([]);
    expect(screen.getByRole("dialog", { name: "Delete 2 messages?" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("menuitem", { name: /Delete/ }).at(-1)!);
    expect(world.said.bulk).toEqual([{ action: "delete", ids: ["a", "b"] }]);
  });

  it("offers every verb the shipped bar offered over a pick: Resurface and Tag among them", () => {
    const world = ohbox({ newForYou: three() });
    let tagged: string[] | null = null;
    world.again({
      bulk: {
        run: (action, ids) => {
          world.said.bulk.push({ action, ids });
          return true;
        },
        tag: (ids) => {
          tagged = ids;
        },
        screenPreview: () => ({ senders: 1, messages: 2, rules: 0 }),
        screen: () => true,
      },
    });
    pick("b: B");
    pick("a: A");
    const bar = () => screen.getByRole("toolbar", { name: "Selection" });
    fireEvent.click(within(bar()).getByRole("button", { name: /Resurface/ }));
    expect(world.said.bulk).toEqual([{ action: "resurface", ids: ["a", "b"] }]);
    pick("c: C");
    fireEvent.click(within(bar()).getByRole("button", { name: /Tag/ }));
    expect(tagged).toEqual(["c"]);
  });

  it("a verb the bar folds for want of room stands behind More, in the bar's order, before Delete, and runs from there", () => {
    /* A bar with room for four controls, as a phone's has: each drawn verb takes 100 of the bar's 450. */
    const widths = {
      scrollWidth: Object.getOwnPropertyDescriptor(Element.prototype, "scrollWidth"),
      clientWidth: Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth"),
    };
    Object.defineProperty(Element.prototype, "scrollWidth", {
      configurable: true,
      get(this: Element) {
        return this.matches(".oh-actionpanel-bar")
          ? 100 * this.querySelectorAll("[data-rank]:not([hidden])").length
          : 0;
      },
    });
    Object.defineProperty(Element.prototype, "clientWidth", {
      configurable: true,
      get(this: Element) {
        return this.matches(".oh-actionpanel") ? 450 : 0;
      },
    });
    try {
      const world = ohbox({ newForYou: three() });
      pick("b: B");
      pick("a: A");
      const bar = screen.getByRole("toolbar", { name: "Selection" });
      const drawn = within(bar)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label"));
      expect(drawn, "the premise: the bar folded").toEqual([
        "2 selected — clear the selection",
        "Later",
        "Read",
        "Unread",
        "More",
      ]);
      fireEvent.click(within(bar).getByRole("button", { name: "More" }));
      /* Each item's words begin with its verb (its key is printed after). */
      const names = ["Park", "Resurface", "Tag", "Move", "Screening", "Delete"];
      const behind = screen.getAllByRole("menuitem").map((item) => item.textContent ?? "");
      expect(
        behind.map((words, at) => words.startsWith(names[at] ?? "?")),
        `behind More: ${behind.join(", ")}`,
      ).toEqual(names.map(() => true));
      fireEvent.click(screen.getByRole("menuitem", { name: /Park/ }));
      expect(world.said.bulk).toEqual([{ action: "aside", ids: ["a", "b"] }]);
    } finally {
      if (widths.scrollWidth) Object.defineProperty(Element.prototype, "scrollWidth", widths.scrollWidth);
      if (widths.clientWidth) Object.defineProperty(Element.prototype, "clientWidth", widths.clientWidth);
    }
  });

  it("Screening's question is titled for Screening, Move's for Move", () => {
    ohbox({ newForYou: three() });
    pick("a: A");
    const bar = () => screen.getByRole("toolbar", { name: "Selection" });
    fireEvent.click(within(bar()).getByRole("button", { name: /Screening/ }));
    expect(screen.getByRole("dialog", { name: "screen to" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "move to" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /News/ }));
    expect(
      screen.queryByRole("dialog", { name: "screen to" }),
      "the place leads on to the confirmation",
    ).toBeNull();
    cleanup();
    ohbox({ newForYou: three() });
    pick("a: A");
    fireEvent.click(within(bar()).getByRole("button", { name: /Move/ }));
    expect(screen.getByRole("dialog", { name: "move to" })).toBeTruthy();
  });

  it("a verb on the bar runs over the pick in list order", () => {
    const world = ohbox({ newForYou: three() });
    pick("c: C");
    pick("a: A");
    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "Selection" })).getByRole("button", { name: /Later/ }),
    );
    expect(world.said.bulk).toEqual([{ action: "later", ids: ["a", "c"] }]);
  });
});
