/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useListWindow } from "../src/lists/list-window.js";

afterEach(cleanup);

describe("a History window over a million messages", () => {
  it("keeps the scrollbar representable and opens the last row from its end", async () => {
    const el = document.createElement("div");
    const count = 1_000_000;
    const maxScrollHeight = 8_000_000;
    const viewport = 820;
    Object.defineProperty(el, "clientHeight", { value: viewport });
    const options = { scrollerRef: { current: el }, count, maxScrollHeight };
    const { result } = renderHook(() => useListWindow(options));
    expect(result.current.offsetOf(count)).toBeLessThanOrEqual(maxScrollHeight);
    Object.defineProperty(el, "scrollHeight", { get: () => result.current.offsetOf(count) });

    await act(async () => {
      el.scrollTop = el.scrollHeight - viewport;
      el.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(result.current.end).toBe(count);
    expect(result.current.end - result.current.start).toBeLessThanOrEqual(60);
    expect(result.current.offsetOf(count)).toBeLessThanOrEqual(maxScrollHeight);
  });
});
