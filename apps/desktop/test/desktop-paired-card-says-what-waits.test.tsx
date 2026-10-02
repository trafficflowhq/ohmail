/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { DesktopGate } from "../src/DesktopGate.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import { DOOR_COPY, machineWord } from "../src/door-copy.js";
import en from "../../webapp/messages/en.json";

/**
 * A PAIRED COMPUTER SAYS WHAT WAITS TOO. When the other computer ends the pairing, or this one has
 * no session there yet, its card is the not-paired card rather than the hosted sign-in, and it names
 * the changes this computer still keeps for that pairing, from the same `/health` count the hosted
 * card reads. Nothing at zero.
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

const MANAGED: EngineStatus = {
  state: "serving", mode: "cloud", address: "someone@ohmail.app", mailboxId: "mbx-1", credentialState: "ready",
  cloudUrl: "https://api.ohmail.app",
} as EngineStatus;
const PAIRED: EngineStatus = {
  ...MANAGED, flavor: "desktop-host", address: "someone@example.com",
  baseUrl: "http://sidecar", cloudUrl: "https://kestrel.tail1234.ts.net",
} as EngineStatus;

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
  changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "MA", hasMore: false,
  serverTime: "2026-01-01T00:00:00.000Z",
});
const EMPTY_SNAPSHOT = JSON.stringify({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } });

/** An engine whose `/health` answers `health`. */
function fakeShell(start: EngineStatus, health: Record<string, unknown>): void {
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      if (command === "engine_status") return start;
      if (command === "mailto_claim" || command === "plugin:event|listen") return null;
      if (command === "engine_request") {
        const url = String(payload?.url ?? "");
        if (url === "/health") return encode(200, JSON.stringify(health));
        if (url.startsWith("/sync/snapshot")) return encode(200, EMPTY_SNAPSHOT);
        if (url.startsWith("/mailboxes")) return encode(200, JSON.stringify({ items: [] }));
        return encode(200, EMPTY_PAGE);
      }
      return null;
    },
  };
}

const refused = (count: number) => ({
  signedIn: false, sessionExpired: true,
  session: { state: "refused", code: "refresh_revoked", since: new Date().toISOString() }, queued: { count },
});

describe("the paired door's cards say what waits", () => {
  let root: Root | null = null;
  let el: HTMLElement | null = null;

  beforeEach(() => {
    window.location.hash = "";
    localStorage.clear();
  });
  afterEach(async () => {
    if (root) await act(async () => { root!.unmount(); });
    el?.remove();
    root = null;
    el = null;
    delete host.__TAURI_INTERNALS__;
    window.location.hash = "";
    localStorage.clear();
  });

  const text = (): string => el?.textContent ?? "";
  const statusLines = (scope: Element | null | undefined): string[] =>
    [...(scope?.querySelectorAll("[role=status]") ?? [])].map((n) => n.textContent ?? "");
  async function until(what: string, ok: () => boolean, ms = 15_000): Promise<void> {
    const t0 = Date.now();
    while (!ok()) {
      if (Date.now() - t0 > ms) throw new Error(`waited ${ms} ms for ${what}; the window read: ${text().slice(0, 300)}`);
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    }
  }
  async function mount(): Promise<void> {
    el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => {
      root!.render(
        <IntlProvider locale="en" messages={en as never} timeZone="UTC">
          <ThemeProvider storageKey="ohmail.theme"><ToastHost><DesktopGate /></ToastHost></ThemeProvider>
        </IntlProvider>,
      );
    });
  }
  const unpaired = (): string => DOOR_COPY.gateUnpaired(machineWord(), "kestrel");

  it("control: the hosted door's refused card says what waits", { timeout: 30_000 }, async () => {
    fakeShell(MANAGED, refused(2));
    await mount();
    await until("the refused card", () => (el?.querySelector(".session-end") ?? null) !== null);
    expect(statusLines(el?.querySelector(".session-end")))
      .toContain(DOOR_COPY.changesWaiting(2, "someone@ohmail.app", machineWord()));
  });

  it("the paired door's refused card names the changes waiting for the other computer", { timeout: 30_000 }, async () => {
    fakeShell(PAIRED, refused(2));
    await mount();
    await until("the not-paired card", () => text().includes(unpaired()));
    expect(statusLines(el?.querySelector(".session-end")), "the paired card said nothing about two changes waiting")
      .toContain(DOOR_COPY.changesWaiting(2, "kestrel", machineWord()));
  });

  it("the paired door before a session names them too", { timeout: 30_000 }, async () => {
    fakeShell(PAIRED, { signedIn: false, sessionExpired: false, queued: { count: 2 } });
    await mount();
    await until("the not-paired card", () => text().includes(unpaired()));
    expect(statusLines(el?.querySelector(".gate")), "the paired pre-auth card said nothing about two changes waiting")
      .toContain(DOOR_COPY.changesWaiting(2, "kestrel", machineWord()));
  });

  it("nothing waiting: the paired card says nothing about changes", { timeout: 30_000 }, async () => {
    fakeShell(PAIRED, refused(0));
    await mount();
    await until("the not-paired card", () => text().includes(unpaired()));
    expect(statusLines(el).join(" ")).not.toContain("waiting on this");
  });
});
