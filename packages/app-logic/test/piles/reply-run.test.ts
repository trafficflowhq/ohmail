// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useReplyRun } from "../../src/piles/reply-run.js";

interface World {
  ids: string[];
  openId: string | null;
  opened: string[];
  written: string[];
}

function mount(ids: string[]) {
  const world: World = { ids, openId: null, opened: [], written: [] };
  const hook = renderHook(
    ({ ids: pile, openId }: { ids: string[]; openId: string | null }) =>
      useReplyRun(pile, {
        openId,
        open: (id) => world.opened.push(id),
        write: (id) => world.written.push(id),
      }),
    { initialProps: { ids, openId: null as string | null } },
  );
  const set = (over: Partial<Pick<World, "ids" | "openId">>) => {
    Object.assign(world, over);
    hook.rerender({ ids: world.ids, openId: world.openId });
  };
  return { world, hook, set };
}

describe("the Reply Run", () => {
  it("stands on the first letter with its reply open, and counts the pile", () => {
    const { world, hook } = mount(["a", "b", "c"]);
    act(() => hook.result.current.start());
    expect(hook.result.current.state).toMatchObject({ at: "a", step: 1, total: 3 });
    expect(world.opened).toEqual(["a"]);
    expect(world.written).toEqual(["a"]);
  });

  it("never steps at Done's press: it steps when the letter leaves Answer Later, as a sent reply makes it", () => {
    const { world, hook, set } = mount(["a", "b", "c"]);
    act(() => hook.result.current.start());
    set({ openId: "a" });
    // The press alone: the pile still holds the letter, so the run stays on it.
    set({ ids: ["a", "b", "c"] });
    expect(hook.result.current.state?.at).toBe("a");
    set({ ids: ["b", "c"] });
    expect(hook.result.current.state).toMatchObject({ at: "b", step: 2, total: 3 });
    expect(world.opened).toEqual(["a", "b"]);
    expect(world.written).toEqual(["a", "b"]);
  });

  it("ends on the letter an Undo brings back", () => {
    const { world, hook, set } = mount(["a", "b"]);
    act(() => hook.result.current.start());
    set({ openId: "a" });
    set({ ids: ["b"] });
    set({ openId: "b" });
    expect(hook.result.current.state?.at).toBe("b");
    set({ ids: ["a", "b"] });
    expect(hook.result.current.state).toBeNull();
    expect(world.opened.at(-1)).toBe("a");
  });

  it("Skip and Exit move the run alone and write nothing", () => {
    const { world, hook } = mount(["a", "b"]);
    act(() => hook.result.current.start());
    act(() => hook.result.current.state!.skip());
    expect(hook.result.current.state).toMatchObject({ at: "b", step: 2 });
    act(() => hook.result.current.state!.exit());
    expect(hook.result.current.state).toBeNull();
    // Only the steps opened a letter and its reply; nothing was sent or filed.
    expect(world.opened).toEqual(["a", "b"]);
    expect(world.written).toEqual(["a", "b"]);
  });

  it("ends when another letter is opened, and after the last letter", () => {
    const { hook, set } = mount(["a", "b"]);
    act(() => hook.result.current.start());
    set({ openId: "a" });
    set({ openId: "z" });
    expect(hook.result.current.state).toBeNull();

    const last = mount(["a"]);
    act(() => last.hook.result.current.start());
    last.set({ ids: [] });
    expect(last.hook.result.current.state).toBeNull();
  });

  it("does not start on an empty pile", () => {
    const { world, hook } = mount([]);
    act(() => hook.result.current.start());
    expect(hook.result.current.state).toBeNull();
    expect(world.opened).toEqual([]);
  });
});
