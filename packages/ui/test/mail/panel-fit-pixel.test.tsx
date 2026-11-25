/** @vitest-environment jsdom */
/**
 * THE ACTION PANEL NEVER STANDS A PIXEL WIDER THAN ITS ROOM: one whole pixel short
 * of what the standing verbs need, the next verb folds behind More, as at any other shortfall; a verb is never clipped
 * at the panel's edge for one pixel. Where the verbs fit exactly, nothing folds.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ActionPanel, type PanelVerb } from "../../src/mail/index.js";

const verbs: PanelVerb[] = [
  { id: "reply", label: "Reply", kind: "ink", icon: "reply", rank: 0, wordOrder: 2 },
  { id: "later", label: "Later", icon: "later", rank: 2 },
  { id: "tag", label: "Tag", icon: "tags", rank: 5 },
];

/* No layout here: a verb with its word is 80 px wide, one without 40, More 40; the room is what a case says. */
let wide: MockInstance, room: MockInstance;
beforeEach(() => {
  wide = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    let sum = 0;
    for (const el of this.querySelectorAll<HTMLElement>("button"))
      if (!el.hidden) sum += el.dataset.short === undefined && !("more" in el.dataset) ? 80 : 40;
    return sum;
  });
  room = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(2000);
});
afterEach(() => {
  wide.mockRestore();
  room.mockRestore();
  cleanup();
});
const shown = () => screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));

describe("the action panel at the edge of its room", () => {
  /* More holds verbs of its own here, so it stands whatever folds: the room asked is the three verbs and More. */
  it("folds the next verb where the room is one pixel short of the verbs and More", () => {
    room.mockReturnValue(80 * 3 + 40 - 1);
    render(<ActionPanel label="Actions" items={verbs} more={{ label: "More", behind: true }} />);
    expect(shown()).toEqual(["Reply", "Later", "More"]);
  });

  it("folds nothing where the verbs and More fit to the pixel", () => {
    room.mockReturnValue(80 * 3 + 40);
    render(<ActionPanel label="Actions" items={verbs} more={{ label: "More", behind: true }} />);
    expect(shown()).toEqual(["Reply", "Later", "Tag", "More"]);
  });
  it("keeps all the actions when they fit without an overflow menu", () => {
    room.mockReturnValue(80 * 3);
    render(<ActionPanel label="Actions" items={verbs} more={{ label: "More", behind: false }} />);
    expect(shown()).toEqual(["Reply", "Later", "Tag"]);
  });
});
