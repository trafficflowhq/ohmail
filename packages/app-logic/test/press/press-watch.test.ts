/** @vitest-environment jsdom */
/**
 * THE PRESS WATCH LISTENS ONLY WHILE A PRESS WAITS: no subscription to the engine's change notice while no watch
 * stands; once one stands, each change asks its rules, a finished pass is told once, and the watch lets go when none
 * is left. Nothing renders for it.
 */
import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EntityReader } from "@ohmail/client-engine";
import { usePressWatch, type PressWatch, type PressWatchSource } from "../../src/press/press-watch.js";

function engineOf(retro: { requestedAt: string | null; doneAt: string | null }) {
  const listeners = new Set<() => void>();
  const reader = {
    get: (kind: string, id: string) => (kind === "rule" && id === "r1" ? { id, retro } : undefined),
  } as unknown as EntityReader;
  const source: PressWatchSource & { notify: () => void; listening: () => number } = {
    read: () => reader,
    subscribe: vi.fn((l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    }),
    notify: () => {
      for (const l of [...listeners]) l();
    },
    listening: () => listeners.size,
  };
  return { source, retro };
}

function mount(source: PressWatchSource) {
  const got: { watch: PressWatch | null; renders: number } = { watch: null, renders: 0 };
  function Host() {
    got.renders += 1;
    got.watch = usePressWatch(source);
    return null;
  }
  render(createElement(Host));
  return got;
}

afterEach(cleanup);

describe("the press watch", () => {
  it("does not listen while no press waits", () => {
    const { source } = engineOf({ requestedAt: "t", doneAt: null });
    mount(source);
    expect(source.subscribe).not.toHaveBeenCalled();
  });

  it("tells a waiting press once when its pass finished, then lets go; nothing renders for it", () => {
    const { source, retro } = engineOf({ requestedAt: "t", doneAt: null });
    const got = mount(source);
    const done = vi.fn();
    act(() => got.watch!.watch({ ruleIds: ["r1"], done }));
    expect(source.listening()).toBe(1);
    act(() => source.notify());
    expect(done).not.toHaveBeenCalled();
    retro.doneAt = "later";
    act(() => source.notify());
    act(() => source.notify());
    expect(done.mock.calls).toEqual([["done"]]);
    expect(source.listening(), "the watch kept listening with no press waiting").toBe(0);
    expect(got.renders).toBe(1);
  });

  it("lets go when its host leaves", () => {
    const { source } = engineOf({ requestedAt: "t", doneAt: null });
    const got = mount(source);
    act(() => got.watch!.watch({ ruleIds: ["r1"], done: () => undefined }));
    cleanup();
    expect(source.listening()).toBe(0);
  });
});
