/** @vitest-environment jsdom */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issue, mountStreamFrame, receipt } from "../../../packages/app/test/streams/registered-world.js";

beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(cleanup);

describe("no visit yet in this browser: a read letter filed on top", () => {
  it("control: truly nothing new — an all-read pile says so, and offers nothing to clear", () => {
    const piles = [
      {
        at: "#/reads",
        name: "News",
        letters: [issue("r1", 10, { unread: false }), issue("r2", 9, { unread: false })],
      },
      {
        at: "#/receipts",
        name: "Receipts",
        letters: [receipt("t1", 10, { unread: false })],
      },
    ];
    for (const { at, name, letters } of piles) {
      mountStreamFrame({ at, letters });
      const pile = within(screen.getByRole("region", { name }));
      const head = within(pile.getByRole("banner"));
      expect(head.getByText("Nothing new since you were here")).toBeTruthy();
      expect(head.queryByRole("button", { name: "Mark all read" })).toBeNull();
      expect(pile.getAllByRole("option")).toHaveLength(letters.length);
      cleanup();
    }
  });
});
