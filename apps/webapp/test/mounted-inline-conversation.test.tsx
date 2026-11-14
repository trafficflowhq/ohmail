/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineMessage } from "@ohmail/wire";
import { issue, mountStreamFrame } from "../../../packages/app/test/streams/registered-world.js";
import { stubDom } from "./_draft-shell.js";

beforeEach(() => stubDom());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("answering within the stream", () => {
  it("opening the editor leaves the single letter and conversation at the stream's scroll position", async () => {
    const current = issue("current", 20, { threadId: "current-thread" });
    const earlier = (id: string, day: number) => issue(id, day, {
      threadId: current.threadId,
      folder: "Sent" as EngineMessage["folder"],
      local: true,
    });
    for (const companions of [[], [earlier("earlier", 18), earlier("latest", 19)]]) {
      mountStreamFrame({ at: "#/reads", withReply: true, letters: [current, ...companions] });
      const stream = screen.getByRole("region", { name: "News stream" });
      const scroll = stream.querySelector<HTMLElement>("[data-reading-scroll]")!;
      const card = stream.querySelector<HTMLElement>("[data-stream-item]")!;
      let top = 0;
      const writes: number[] = [];
      Object.defineProperties(scroll, {
        clientHeight: { value: 300 },
        scrollHeight: { value: 900 },
        scrollTop: { get: () => top, set: (next: number) => { top = next; writes.push(next); } },
      });
      scroll.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300);
      card.getBoundingClientRect = () => new DOMRect(0, 20 - top, 400, 600);
      const scrollTo = vi.fn((position?: number | ScrollToOptions, y?: number) => {
        top = (typeof position === "number" ? y : position?.top) ?? top;
      });
      scroll.scrollTo = scrollTo;
      const list = within(screen.getByRole("region", { name: "News" }));
      await act(async () => { fireEvent.click(list.getByRole("option", { name: /Issue 20/ })); });
      // Let the list press land before testing the separate Reply control.
      for (let frame = 0; frame < 6; frame += 1) {
        await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
      }
      expect(scrollTo).toHaveBeenCalled();
      writes.length = 0;
      scrollTo.mockClear();
      const actions = within(screen.getByRole("toolbar", { name: "Actions" }));
      await act(async () => { fireEvent.click(actions.getByRole("button", { name: "Reply" })); });
      expect(within(stream).getByRole("textbox", { name: "Reply body" })).toBeTruthy();
      expect(within(stream).getAllByRole("article")).toHaveLength(1 + companions.length);
      expect(writes).toEqual([]);
      expect(scrollTo).not.toHaveBeenCalled();
      cleanup();
    }
  });
});
