/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopGate } from "../src/DesktopGate.js";
import { DesktopLocale } from "../src/DesktopLocale.js";
import type { EngineStatus } from "../src/bridge-fetch.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

const CLOUD_SERVING: EngineStatus = {
  state: "serving",
  mode: "cloud",
  flavor: "managed",

  mailboxId: "mbx-1",

  credentialState: "ready",
};

function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

const EMPTY_PAGE = JSON.stringify({
  changes: { creates: [], updates: [], moves: [], deletes: [] },
  cursor: "MA",
  hasMore: false,
  serverTime: "2026-01-01T00:00:00.000Z",
});
const EMPTY_SNAPSHOT = JSON.stringify({
  asOfSeq: 0,
  changes: [],
  nextCursor: null,
  window: { days: 90, minRows: 500 },
});

/** The shell behind the bridge, with a status this test moves and a count of the asks. */
function fakeShell(initial: EngineStatus): {
  set(next: EngineStatus): void;
  asks(): number;
  releaseOld(): void;
} {
  let status = initial;
  let asks = 0;
  let oldReply: (() => void) | undefined;
  const callbacks = new Map<number, (payload: unknown) => void>();
  let next = 1;
  host.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => {
      const id = next++;
      callbacks.set(id, cb);
      return id;
    },
    invoke: async (command, payload) => {
      if (command === "engine_status") {
        asks++;
        const snapshot = status;
        if (asks > 1 && snapshot.state === initial.state && !oldReply) {
          return new Promise((resolve) => { oldReply = () => resolve(snapshot); });
        }
        return snapshot;
      }
      if (command === "mailto_claim") return null;
      if (command === "plugin:event|listen") return null;
      if (command === "engine_request") {
        const url = String(payload?.url ?? "");
        if (url === "/health") {
          return encode(200, JSON.stringify({ signedIn: true }));
        }
        if (url.startsWith("/sync/snapshot")) return encode(200, EMPTY_SNAPSHOT);
        if (url.startsWith("/mailboxes")) return encode(200, JSON.stringify({ items: [] }));
        return encode(200, EMPTY_PAGE);
      }
      return null;
    },
  };
  return {
    set: (n) => { status = n; },
    asks: () => asks,
    releaseOld: () => oldReply?.(),
  };
}

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

async function render(): Promise<HTMLElement> {
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(
      <DesktopLocale>
        <ThemeProvider storageKey="ohmail.theme">
          <ToastHost>
            <DesktopGate />
          </ToastHost>
        </ThemeProvider>
      </DesktopLocale>,
    );
  });
  await advance(0);
  return mountPoint;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const text = (): string => mountPoint?.textContent ?? "";
/** The mail app's unmistakable text — the rail entry only `AppShell` renders. */
const mounted = (): boolean => text().includes("Ohbox");

beforeEach(() => {
  vi.useFakeTimers();
  window.location.hash = "";
  localStorage.clear();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
  vi.useRealTimers();
  window.location.hash = "";
  localStorage.clear();
});


it("waits for an outstanding startup status before asking again", async () => {
  const shell = fakeShell({ state: "starting", mode: "cloud", flavor: "managed" });
  await render();
  await advance(75);
  expect(shell.asks(), "control: the first poll is already in flight").toBe(2);
  shell.set(CLOUD_SERVING);

  await advance(800);
  expect(shell.asks(), "a second poll can overtake the held reply").toBe(2);

  await act(async () => shell.releaseOld());
  await advance(800);
  expect(mounted(), "after the held reply, the next poll opens the mailbox").toBe(true);
});

it("ignores a held poll when Read again has already opened the mailbox", async () => {
  const shell = fakeShell({ state: "absent" });
  const view = await render();
  await advance(5_000);
  expect(shell.asks()).toBe(2);
  const retry = [...view.querySelectorAll("button")].find((button) => button.textContent === "Read again");
  expect(retry).toBeDefined();

  shell.set(CLOUD_SERVING);
  await act(async () => retry!.click());
  await advance(800);
  expect(mounted(), "control: the foreground read opened the mailbox").toBe(true);

  await act(async () => shell.releaseOld());
  expect(mounted(), "the superseded poll withdrew the mailbox").toBe(true);
});
