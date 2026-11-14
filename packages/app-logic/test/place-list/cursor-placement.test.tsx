/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useListWalk } from "../../src/place-list/walk.js";

it("declines to place the cursor on a row that has not rendered", () => {
  const open = vi.fn();
  const say = vi.fn();
  const rendered = new Set<string>();
  const input = {
    list: "folder",
    columns: 2 as const,
    arrival: "rest" as const,
    order: ["first", "second"],
    openId: null,
    open,
    say,
    labels: { next: "Next", prev: "Previous", open: "Open" },
    rowRendered: (id: string) => rendered.has(id),
  };
  const { result } = renderHook(() => useListWalk(input));
  act(() => expect(result.current.place("Park")).toBe(false));
  expect(open).not.toHaveBeenCalled();
  expect(say).not.toHaveBeenCalled();

  rendered.add("first");
  act(() => expect(result.current.place("Park")).toBe(true));
  expect(open.mock.calls).toEqual([["first"]]);
  expect(say.mock.calls).toEqual([["Park"]]);
});

it("declines to place the cursor when there is nowhere to announce it", () => {
  const open = vi.fn();
  const { result } = renderHook(() =>
    useListWalk({
      list: "folder",
      columns: 2,
      arrival: "rest",
      order: ["first"],
      openId: null,
      open,
      labels: { next: "Next", prev: "Previous", open: "Open" },
    }),
  );
  act(() => expect(result.current.place("Park")).toBe(false));
  expect(open).not.toHaveBeenCalled();
});
