/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineDraft, PressVerdict } from "@ohmail/client-engine";
import { useDiscardWindow, type DiscardWords, type DraftsDoor } from "@ohmail/app-logic/drafts";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import type { UndoToastOptions } from "@ohmail/app-logic/press/undo-door";

const WORDS: DiscardWords = {
  discarded: "Discarded",
  undo: "Undo",
  notSent: "Discarded, not sent",
  refused: (reason) => (reason ? `Refused: ${reason}` : "Refused"),
  queued: (wait) => `Queued ${wait}`,
};

interface World {
  door: DraftsDoor;
  discards: string[];
  withdraws: string[];
  said: { message: string; options?: UndoToastOptions }[];
  answer: { withdraw: "none" | "withdrawn" | "already_sent" | "unknown"; verdict: PressVerdict };
  released: string[];
  holds: Set<string>;
}

function world(): World {
  const w: World = {
    discards: [],
    withdraws: [],
    said: [],
    answer: { withdraw: "none", verdict: { kind: "applied" } },
    released: [],
    holds: new Set(),
    door: null as unknown as DraftsDoor,
  };
  w.door = {
    open: () => undefined,
    decide: (id) => (id === "running" ? { kind: "refuse", why: "still-sending" } : { kind: "go" }),
    withdrawWaiting: async (id) => {
      w.withdraws.push(id);
      return w.answer.withdraw;
    },
    discard: async (id) => {
      w.discards.push(id);
      // The seat releases a held row's send record only on a confirmed answer.
      if (w.answer.verdict.kind === "applied" && w.holds.has(id)) w.released.push(id);
      return w.answer.verdict;
    },
    cancelSchedule: () => undefined,
    editScheduled: () => undefined,
    resolve: () => undefined,
    sendAgain: () => undefined,
    repliesHere: () => false,
    heldHere: w.holds,
    waiting: new Set(),
    notSent: new Map(),
  };
  return w;
}

function mount(w: World) {
  return renderHook(() =>
    useDiscardWindow(w.door, (message, options) => w.said.push({ message, options }), WORDS),
  );
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Discard is one press, with Undo", () => {
  it("hides the row at the press and sends the delete only when the window closes", async () => {
    const w = world();
    const h = mount(w);
    act(() => h.result.current.discard("d1"));
    await flush();
    expect(h.result.current.hidden.has("d1")).toBe(true);
    expect(w.said.at(-1)?.message).toBe("Discarded");
    expect(w.said.at(-1)?.options?.undo).toBe(true);
    expect(w.said.at(-1)?.options?.duration).toBe(UNDO_MS);
    await act(async () => {
      vi.advanceTimersByTime(UNDO_MS - 1);
    });
    expect(w.discards).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(w.discards).toEqual(["d1"]);
  });

  it("Undo brings the row back and sends nothing, even after the window would have closed", async () => {
    const w = world();
    const h = mount(w);
    act(() => h.result.current.discard("d1"));
    await flush();
    act(() => w.said.at(-1)?.options?.onAction?.());
    expect(h.result.current.hidden.has("d1")).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(UNDO_MS * 2);
    });
    await flush();
    expect(w.discards).toEqual([]);
  });

  it("a second press inside the window is no second delete", async () => {
    const w = world();
    const h = mount(w);
    act(() => h.result.current.discard("d1"));
    act(() => h.result.current.discard("d1"));
    await flush();
    act(() => h.result.current.discard("d1"));
    await act(async () => {
      vi.advanceTimersByTime(UNDO_MS);
    });
    await flush();
    expect(w.discards).toEqual(["d1"]);
    expect(w.withdraws).toEqual(["d1"]);
  });

  it("leaving the place sends what is open, at once", async () => {
    const w = world();
    const h = mount(w);
    act(() => h.result.current.discard("d1"));
    await flush();
    h.unmount();
    await flush();
    expect(w.discards).toEqual(["d1"]);
  });
});

describe("a send on the row", () => {
  it("a waiting send is taken back before the window opens, and the row says it was not sent", async () => {
    const w = world();
    w.answer.withdraw = "withdrawn";
    const h = mount(w);
    act(() => h.result.current.discard("d1"));
    expect(w.withdraws).toEqual(["d1"]);
    expect(h.result.current.hidden.has("d1")).toBe(false);
    await flush();
    expect(h.result.current.hidden.has("d1")).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(UNDO_MS);
    });
    await flush();
    expect(w.said.map((s) => s.message)).toEqual(["Discarded", "Discarded, not sent"]);
  });

  it("a send already gone, or one nobody could take back, refuses in the row and hides nothing", async () => {
    for (const [answer, why] of [
      ["already_sent", "still-sending"],
      ["unknown", "cancel-unknown"],
    ] as const) {
      const w = world();
      w.answer.withdraw = answer;
      const h = mount(w);
      act(() => h.result.current.discard("d1"));
      await flush();
      expect(h.result.current.hidden.size).toBe(0);
      expect(h.result.current.refusal).toMatchObject({ draftId: "d1", why });
      await act(async () => {
        vi.advanceTimersByTime(UNDO_MS);
      });
      await flush();
      expect(w.discards).toEqual([]);
      h.unmount();
    }
  });

  it("a running send is refused at the press: nothing is withdrawn and nothing hides", async () => {
    const w = world();
    const h = mount(w);
    act(() => h.result.current.discard("running"));
    await flush();
    expect(w.withdraws).toEqual([]);
    expect(h.result.current.refusal).toMatchObject({ draftId: "running", why: "still-sending" });
    expect(h.result.current.hidden.size).toBe(0);
  });

  it("a held row keeps its send record through Undo, and loses it only on the confirmed delete", async () => {
    const w = world();
    w.holds.add("held");
    const h = mount(w);
    act(() => h.result.current.discard("held"));
    await flush();
    act(() => w.said.at(-1)?.options?.onAction?.());
    await act(async () => {
      vi.advanceTimersByTime(UNDO_MS);
    });
    await flush();
    expect(w.released).toEqual([]);
    act(() => h.result.current.discard("held"));
    await flush();
    expect(w.released).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(UNDO_MS);
    });
    await flush();
    expect(w.released).toEqual(["held"]);
  });
});

describe("what the server answers", () => {
  it("a refusal brings the row back with the server's sentence", async () => {
    const w = world();
    w.answer.verdict = { kind: "refused", refusal: { message: "  the row is frozen " } as never };
    const h = mount(w);
    act(() => h.result.current.discard("d1"));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(UNDO_MS);
    });
    await flush();
    expect(h.result.current.hidden.has("d1")).toBe(false);
    expect(w.said.at(-1)?.message).toBe("Refused: the row is frozen");
  });

  it("the organizer's wait shows the row again; this client's retry keeps it gone", async () => {
    for (const wait of ["organizer", "retry"] as const) {
      const w = world();
      w.answer.verdict = { kind: "queued", wait, holder: null };
      const h = mount(w);
      act(() => h.result.current.discard("d1"));
      await flush();
      await act(async () => {
        vi.advanceTimersByTime(UNDO_MS);
      });
      await flush();
      expect(h.result.current.hidden.has("d1")).toBe(wait === "retry");
      expect(w.said.at(-1)?.message).toBe(`Queued ${wait}`);
      h.unmount();
    }
  });
});
