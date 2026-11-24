/** @vitest-environment jsdom */
/**
 * THE ROUTING WINDOW KEEPS ITS HELD PRESSES IN ITS OWN SCOPE: its journal and the channel it claims them on are the
 * scope its mount hands in, never the storage owner of the moment the window is built. A press journalled under
 * another account is replayed at that account's launch, and a claim heard on another account's channel withholds
 * that account's own rows.
 */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryMirrorStore, routingIntentsKey, type SyncChange } from "@ohmail/client-engine";
import { createIntentWindows, intentWindowsChannel } from "@ohmail/app-logic/press/intent-windows";
import { useRoutingUndo, type RoutingUndo } from "@ohmail/app-logic/press/routing-undo";
import { resetStorageOwnerForTest, setStorageOwner } from "@ohmail/app-logic/storage/storage-owner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = "acc-A1";
const B = "acc-B2";
const ADDR = "lena@atelier.example";
const WINDOW_MS = 60_000;
const msg = (id: string): EngineMessage => ({
  id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: `Subject ${id}`,
  from: { name: null, address: ADDR }, to: [], cc: [], date: "2026-08-02T09:00:00.000Z", folder: "INBOX",
  snippet: "s", unread: true, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
} as EngineMessage);

let root: Root | null = null;

/** One routing window, mounted under a scope, over a mirror that holds the press's letter. */
async function mountWindow(scope: string): Promise<{ hold: (id: string) => void }> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    { type: "message", op: "create", id: "m1", seq: 1, updatedAt: "2026-08-02T09:00:00.000Z", entity: msg("m1") },
  ] as SyncChange[]);
  let latest: RoutingUndo | null = null;
  function Probe(): null {
    latest = useRoutingUndo({
      scope,
      read: () => store,
      send: async () => ({ status: "confirmed" }),
      toast: () => {},
      copy: { gone: "gone", expired: () => "expired", correction: (key) => key },
      windowMs: WINDOW_MS,
      now: () => Date.now(),
    });
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => { root!.render(React.createElement(Probe)); });
  return {
    hold: (id) => {
      latest!.hold({
        id, seedId: "m1", address: ADDR, dest: "reads", messageIds: ["m1"],
        note: { sender: ADDR, place: "News", count: 1 },
      });
    },
  };
}
/** Whether one scope's journal holds a press. */
const journals = (scope: string, id: string): boolean =>
  (window.localStorage.getItem(routingIntentsKey(scope)) ?? "").includes(id);
const delivered = async (): Promise<void> => {
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
};

beforeEach(() => {
  window.localStorage.clear();
  resetStorageOwnerForTest();
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  window.localStorage.clear();
  resetStorageOwnerForTest();
});

describe("a routing window keeps its held presses in its own scope", () => {
  it("journals a held press under A while the storage owner names B", async () => {
    setStorageOwner(B);
    const window_ = await mountWindow(A);
    window_.hold("press-1");
    expect({ a: journals(A, "press-1"), b: journals(B, "press-1") }).toEqual({ a: true, b: false });
  });

  it("claims a held press on A's channel: a tab of A's hears it, a tab of B's does not", async () => {
    setStorageOwner(B);
    const tabOfB = createIntentWindows({ channel: `${intentWindowsChannel(B)}.routing`, askMs: 1 });
    const tabOfA = createIntentWindows({ channel: `${intentWindowsChannel(A)}.routing`, askMs: 1 });
    try {
      const window_ = await mountWindow(A);
      window_.hold("press-2");
      await delivered();
      expect({
        heardByB: [...tabOfB.elsewhere(Date.now(), WINDOW_MS)],
        heardByA: [...tabOfA.elsewhere(Date.now(), WINDOW_MS)],
      }).toEqual({ heardByB: [], heardByA: ["press-2"] });
    } finally {
      tabOfB.close();
      tabOfA.close();
    }
  });

  it("mounted again under A after the storage owner moved to B, still journals under A", async () => {
    setStorageOwner(A);
    await mountWindow(A);
    await act(async () => { root!.unmount(); });
    root = null;
    setStorageOwner(B);
    const window_ = await mountWindow(A);
    window_.hold("press-3");
    expect({ a: journals(A, "press-3"), b: journals(B, "press-3") }).toEqual({ a: true, b: false });
  });

  it("refuses to mount with no scope handed in, and journals nothing", async () => {
    const errors: string[] = [];
    const quiet = console.error;
    console.error = () => {};
    class Catch extends React.Component<{ children?: React.ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
      }
      componentDidCatch(e: Error): void {
        errors.push(e.message);
      }
      render(): React.ReactNode {
        return this.state.failed ? null : this.props.children;
      }
    }
    function Probe(): null {
      useRoutingUndo({
        scope: undefined as unknown as string,
        read: () => new MemoryMirrorStore(),
        send: async () => ({ status: "confirmed" }),
        toast: () => {},
        copy: { gone: "gone", expired: () => "expired", correction: (key) => key },
      });
      return null;
    }
    try {
      root = createRoot(document.createElement("div"));
      await act(async () => { root!.render(React.createElement(Catch, null, React.createElement(Probe))); });
    } finally {
      console.error = quiet;
    }
    expect({ errors, kept: window.localStorage.length }).toEqual({
      errors: ["ohmail: a stored key was asked for with no storage scope"],
      kept: 0,
    });
  });
});
