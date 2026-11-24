/** @vitest-environment jsdom */
import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issue, mountStreamFrame, receipt } from "../../../packages/app/test/streams/registered-world.js";
import { stubDom } from "./_draft-shell.js";

const views = [
  ["News", "#/reads", issue],
  ["Receipts", "#/receipts", receipt],
] as const;
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

beforeEach(() => {
  stubDom();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const rects = Element.prototype.getClientRects;
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    if (this.hasAttribute("data-reading-scroll")) {
      return [new DOMRect(0, 0, 600, 600)] as unknown as DOMRectList;
    }
    return rects.call(this);
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(++nextFrame, cb);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => {
  cleanup();
  frames.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

for (const [name, route, make] of views) {
  describe(`${name}: the rows first, the stream after the paint`, () => {
    it("the press's own commit draws the rows and no card; the cards follow a frame later", () => {
      const letters = Array.from({ length: 20 }, (_, index) => make(`letter-${index}`, 21 - index));
      mountStreamFrame({ at: route, letters });

      const list = within(screen.getByRole("region", { name }));
      const stream = within(screen.getByRole("region", { name: `${name} stream` }));
      expect(list.getByRole("heading", { name })).toBeTruthy();
      expect(list.getAllByRole("option").length).toBeGreaterThan(0);
      expect(stream.queryAllByRole("article")).toEqual([]);
      expect(stream.queryByRole("heading", { name })).toBeNull();
      expect(stream.getAllByRole("toolbar", { name: "Actions" })).toHaveLength(1);

      act(() => {
        for (const [id, frame] of [...frames]) {
          frames.delete(id);
          frame(0);
        }
        vi.runOnlyPendingTimers();
      });
      expect(stream.getAllByRole("article").length).toBeGreaterThan(0);
    });
  });
}
