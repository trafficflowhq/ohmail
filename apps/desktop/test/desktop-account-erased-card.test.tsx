/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { DesktopGate } from "../src/DesktopGate.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import { DOOR_COPY, machineWord } from "../src/door-copy.js";
import messages from "../../webapp/messages/en.json";

/**
 * A DELETED HOSTED ACCOUNT IS SAID, NEVER DRAWN AS AN EMPTY MAILBOX. The engine latches
 * `/health.accountErased` on the hosted `410 account_erased` and discards the session; the
 * window then shows one card with the local-only door on it, before the mail client and before
 * the sign-in surface — a deleted account is neither a mailbox nor a sign-out. Read from the
 * RENDERED output. Watched red: the gate's branch cut — the empty mailbox and the sign-in return.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

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
  address: "someone@ohmail.app",
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
  cursor: "MA", hasMore: false, serverTime: "2026-01-01T00:00:00.000Z",
});
const EMPTY_SNAPSHOT = JSON.stringify({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } });

function fakeShell(health: Record<string, unknown>): void {
  const callbacks = new Map<number, (payload: unknown) => void>();
  let next = 1;
  host.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => {
      const id = next++;
      callbacks.set(id, cb);
      return id;
    },
    invoke: async (command, payload) => {
      if (command === "engine_status") return CLOUD_SERVING;
      if (command === "mailto_claim") return null;
      if (command === "plugin:event|listen") return null;
      if (command === "engine_request") {
        const url = String(payload?.url ?? "");
        if (url === "/health") return encode(200, JSON.stringify(health));
        if (url.startsWith("/sync/snapshot")) return encode(200, EMPTY_SNAPSHOT);
        if (url.startsWith("/sync")) return encode(200, EMPTY_PAGE);
        if (url.startsWith("/mailboxes")) return encode(200, JSON.stringify({ items: [] }));
        return encode(200, "{}");
      }
      return null;
    },
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
      <IntlProvider locale="en" messages={messages as never} timeZone="UTC">
        <ThemeProvider storageKey="ohmail.theme">
          <ToastHost>
            <DesktopGate />
          </ToastHost>
        </ThemeProvider>
      </IntlProvider>,
    );
  });
  await settle();
  return mountPoint;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
}

function buttonsSaying(el: HTMLElement, label: string): HTMLButtonElement[] {
  return [...el.querySelectorAll("button")].filter((b) => (b.textContent ?? "").includes(label));
}

/** The mail app's unmistakable text — the rail's Ohbox entry only `AppShell` renders. */
const mounted = (el: HTMLElement): boolean => (el.textContent ?? "").includes("Ohbox");
const signInSurface = (el: HTMLElement): boolean =>
  (el.textContent ?? "").includes("Sign in to ohmail Cloud");

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
  window.location.hash = "";
  localStorage.clear();
});

beforeEach(() => {
  window.location.hash = "";
  localStorage.clear();
});

describe("a deleted hosted account", () => {
  it("while the engine still holds the session: the card, not the mailbox", async () => {
    fakeShell({ signedIn: true, sessionExpired: false, online: false, accountErased: true });
    const el = await render();
    expect(mounted(el), "the mailbox was drawn behind a deleted account").toBe(false);
    expect(el.textContent ?? "").toContain(DOOR_COPY.gateAccountErased(machineWord()));
    expect(buttonsSaying(el, DOOR_COPY.gateOwn)).toHaveLength(1);
  });

  it("after the engine let the session go: the card, not the sign-in surface", async () => {
    fakeShell({ signedIn: false, sessionExpired: false, online: false, accountErased: true });
    const el = await render();
    expect(signInSurface(el), "a deleted account was offered a sign-in").toBe(false);
    expect(el.textContent ?? "").toContain(DOOR_COPY.gateAccountErased(machineWord()));
  });

  it("its one button opens the local-only door, on screen", async () => {
    fakeShell({ signedIn: false, sessionExpired: false, online: false, accountErased: true });
    const el = await render();
    await act(async () => {
      buttonsSaying(el, DOOR_COPY.gateOwn)[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(el.textContent ?? "", "the local door's lead is not on screen")
      .toContain(DOOR_COPY.localLead(machineWord()));
  });
});

describe("CONTROLS — the other states keep their cards", () => {
  it("a live account mounts the mail client", async () => {
    fakeShell({ signedIn: true, sessionExpired: false, online: true, accountErased: false });
    const el = await render();
    expect(mounted(el)).toBe(true);
  });

  it("a coded sign-out offers the sign-in, and says nothing about a deletion", async () => {
    fakeShell({ signedIn: false, sessionExpired: true, online: false, accountErased: false });
    const el = await render();
    expect(signInSurface(el)).toBe(true);
    expect(el.textContent ?? "").not.toContain("deleted");
  });
});
