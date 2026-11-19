/** @vitest-environment jsdom */
/**
 * THE DELETE JOURNAL KEEPS A PRESS UNDER THE SCOPE ITS MOUNT HANDS IN: at the press, at Undo, at the settle that runs
 * after the window's mount is gone, and at the boot replay. Never under whatever the storage owner says at that
 * moment: a row left in one account's journal is replayed at that account's next launch, and a row cleared out of
 * another's is a delete that account asked for, lost.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderHook, waitFor } from "@testing-library/react";
import type { EngineAdapter } from "@ohmail/client-engine";
import { useShellDispatch } from "@ohmail/app-logic/press/shell-dispatch";
import { engineOver, msg, storeWith } from "./_view-shell";
import { deleteIntentsKey } from "@ohmail/app-logic/press/delete-intents";
import {
  createDeleteUndo,
  replayDeleteIntents,
  useDeleteUndo,
  type DeleteTarget,
  type DeleteUndoCopy,
  type HeldOutcome,
} from "@ohmail/app-logic/press/delete-undo";
import { resetStorageOwnerForTest, setStorageOwner } from "@ohmail/app-logic/storage/storage-owner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = "acc-A1";
const B = "acc-B2";
const COPY: DeleteUndoCopy = { deleted: "Deleted", undo: "Undo", undone: "Undone", failed: "Failed", noUndo: "No undo" };
const TARGET: DeleteTarget = { id: "m1", mailboxId: "mb1" };

/** The press ids one scope's journal holds. */
const rowsOf = (scope: string): string[] => {
  const raw = window.localStorage.getItem(deleteIntentsKey(scope));
  return raw === null ? [] : (JSON.parse(raw) as Array<{ id: string }>).map((row) => row.id);
};
/** A row another account's window left in its own journal. */
const journal = (scope: string, id: string, messageId: string): void =>
  window.localStorage.setItem(deleteIntentsKey(scope), JSON.stringify([{ id, messageIds: [messageId], at: 1_000_000 }]));
const settled = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

beforeEach(() => {
  window.localStorage.clear();
  resetStorageOwnerForTest();
});
afterEach(() => {
  window.localStorage.clear();
  resetStorageOwnerForTest();
});

describe("a delete window keeps its press in its own scope's journal", () => {
  it("journals a press under A while the storage owner names B, and B's journal holds nothing", () => {
    setStorageOwner(B);
    const queue = createDeleteUndo({
      scope: A, mutate: async () => ({ status: "confirmed" }), toast: () => {}, copy: COPY, onHeld: () => {},
      refusal: () => null, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => {},
      now: () => 1_000_000, pressId: () => "press-1",
    });
    expect(queue.remove(TARGET)).toBe(true);
    expect({ a: rowsOf(A), b: rowsOf(B) }).toEqual({ a: ["press-1"], b: [] });
  });

  it("takes A's row out of A's journal when Undo is pressed after the storage owner moved", () => {
    setStorageOwner(A);
    let undo: (() => void) | null = null;
    const queue = createDeleteUndo({
      scope: A, mutate: async () => ({ status: "confirmed" }),
      toast: (_sentence, opts) => { if (opts?.onAction) undo = opts.onAction; },
      copy: COPY, onHeld: () => {}, refusal: () => null,
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => {},
      now: () => 1_000_000, pressId: () => "press-1",
    });
    queue.remove(TARGET);
    expect(rowsOf(A)).toEqual(["press-1"]);
    journal(B, "b-press", "m9");
    setStorageOwner(B);
    undo!();
    expect({ a: rowsOf(A), b: rowsOf(B) }).toEqual({ a: [], b: ["b-press"] });
  });

  it("clears A's row when a window its unmount flushed settles after the storage owner names B, and leaves B's journal", async () => {
    setStorageOwner(A);
    let answer: (outcome: HeldOutcome) => void = () => {};
    let press: ((target: DeleteTarget) => boolean) | null = null;
    function Window(): null {
      const window_ = useDeleteUndo({
        scope: A,
        mutate: () => new Promise<HeldOutcome>((resolve) => { answer = resolve; }),
        toast: () => {}, copy: COPY, refusal: () => null, now: () => 1_000_000,
      });
      press = window_.remove;
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => { root.render(React.createElement(Window)); });
    await act(async () => { press!(TARGET); });
    expect(rowsOf(A)).toHaveLength(1);
    journal(B, "b-press", "m9");
    /* Leaving commits the open window; its dispatch is still on the wire when the next account's shell comes. */
    await act(async () => { root.unmount(); });
    setStorageOwner(B);
    answer({ status: "confirmed" });
    await settled();
    expect({ a: rowsOf(A), b: rowsOf(B) }).toEqual({ a: [], b: ["b-press"] });
  });
});

describe("a delete left on disk while its answer is in flight", () => {
  it("retries each message under the identity its original request used", async () => {
    const targets = [TARGET, { ...TARGET, id: "m2" }];
    const requests = new Map<string, string[]>();
    const applied = new Set<string>();
    let release!: () => void;
    const lostReply = new Promise<void>((resolve) => { release = resolve; });

    // The local service has accepted both deletes. The last answer never reaches the first tab.
    const mount = async (interrupted: boolean) => {
      const mutate: EngineAdapter["mutate"] = async (mutation, { idempotencyKey }) => {
        if (mutation.kind !== "message_delete") throw new Error("expected a delete");
        const keys = requests.get(mutation.messageId) ?? [];
        keys.push(idempotencyKey);
        requests.set(mutation.messageId, keys);
        applied.add(idempotencyKey);
        if (interrupted && mutation.messageId === "m2") await lostReply;
        return { changes: [], seq: null };
      };
      const store = await storeWith(targets.map(({ id }) => msg(id)));
      const engine = engineOver(store, { adapter: { mutate } });
      return renderHook(() => useShellDispatch({
        engine,
        reader: engine.read(),
        scope: A,
        demo: false,
        toast: () => {},
        t: (key) => key,
        placeLabel: (place) => place,
        refreshFacts: () => {},
      }));
    };

    const first = await mount(true);
    await settled();
    first.result.current.rosterRef.current = { kind: "absent" };
    act(() => { expect(first.result.current.deleting.remove(targets)).toBe(true); });
    const [press] = rowsOf(A);
    expect(press).toBeTruthy();
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    await waitFor(() => expect(requests.size).toBe(2));
    expect(rowsOf(A)).toEqual([press]);
    first.unmount();

    const next = await mount(false);
    try {
      await waitFor(() => expect(rowsOf(A)).toEqual([]));
      for (const { id } of targets) {
        const key = `delete-replay:${press}:${id}`;
        expect(requests.get(id)).toEqual([key, key]);
      }
      expect(applied.size).toBe(2);
    } finally {
      next.unmount();
      release();
      await settled();
    }
  });
});

describe("the boot replay takes and clears its own scope's rows", () => {
  it("takes A's rows only when it runs under A while the storage owner names B", async () => {
    journal(A, "a-press", "m1");
    journal(B, "b-press", "m9");
    setStorageOwner(B);
    const sent: string[] = [];
    const taken = replayDeleteIntents(async (messageId) => { sent.push(messageId); return { status: "confirmed" }; }, 1_000_001, A);
    await settled();
    expect({ taken, sent, a: rowsOf(A), b: rowsOf(B) }).toEqual({ taken: 1, sent: ["m1"], a: [], b: ["b-press"] });
  });

  it("clears A's row at its settle though the storage owner moved to B meanwhile", async () => {
    journal(A, "a-press", "m1");
    journal(B, "b-press", "m9");
    setStorageOwner(A);
    let answer: () => void = () => {};
    const taken = replayDeleteIntents(
      () => new Promise<HeldOutcome>((resolve) => { answer = () => resolve({ status: "confirmed" }); }), 1_000_001, A,
    );
    setStorageOwner(B);
    answer();
    await settled();
    expect({ taken, a: rowsOf(A), b: rowsOf(B) }).toEqual({ taken: 1, a: [], b: ["b-press"] });
  });
});
