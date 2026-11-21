/** @vitest-environment jsdom */
import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountStreamFrame, receipt } from "../../../packages/app/test/streams/registered-world.js";
import { stubDom } from "./_draft-shell.js";

beforeEach(() => {
  stubDom();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Receipts: a scroll nobody made must not write \\Seen", () => {
  it("an untouched view marks NOTHING, and does not scroll itself either", () => {
    const receipts = Array.from({ length: 20 }, (_, index) =>
      receipt(`r${index}`, 25 - index, { unread: index >= 12, body: undefined }),
    );
    const positions = new Map(receipts.map((letter, index) => [letter.id, index]));
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      const option = this.closest('[role="option"]');
      const scroll = option?.closest<HTMLElement>(".pl-scroll");
      // jsdom does not scroll the list when a row is brought into view.
      const position = positions.get(option?.getAttribute("data-id") ?? "");
      if (scroll && position !== undefined) scroll.scrollTop = Math.max(0, (position + 1) * 80 - 600);
    });

    const { mail } = mountStreamFrame({ at: "#/receipts", letters: receipts });
    const list = within(screen.getByRole("region", { name: "Receipts" })).getByRole("listbox");
    const scroll = list.closest<HTMLElement>(".pl-scroll")!;
    act(() => vi.advanceTimersByTime(2_500));

    expect(mail.mutations).toEqual([]);
    expect(scroll.scrollTop).toBe(0);
    expect(mail.bodyAsks).toEqual(["r12"]);
  });
});
