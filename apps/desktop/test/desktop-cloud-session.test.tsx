/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { DesktopGate } from "../src/DesktopGate.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import {
  CLOUD_NOTICE_GRACE_MS, cloudNoticeDue, sessionOf, signInCauseOf, type CloudSessionWire,
} from "../src/cloud-session.js";
import { DOOR_COPY, machineWord } from "../src/door-copy.js";
import messages from "../../webapp/messages/en.json";

/**
 * THE SIGN-IN DIALOG OPENS ON A REFUSAL AND SAYS WHICH ONE; A FAULT IS A NOTICE OVER THE MAIL.
 *
 * The engine's `/health.session` says where the hosted session stands. The gate opens the dialog
 * on `sessionExpired` alone (a coded refusal), names the cause in its first sentence, and while
 * Cloud is renewing or not answering keeps the mail on screen with one line in the rail — after a
 * grace, so a blip the engine retries away in a second says nothing.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const reading = (state: CloudSessionWire["state"], code: string | null, sinceMs = 60_000): CloudSessionWire =>
  ({ state, code, since: ago(sinceMs) });

describe("the window's reading of /health.session", () => {
  it("takes the engine's shape and nothing else — an older engine's absence is null, not a fault", () => {
    expect(sessionOf(undefined)).toBeNull();
    expect(sessionOf({ state: "gone", code: null, since: ago(0) })).toBeNull();
    expect(sessionOf({ state: "renewing", since: 5 })).toBeNull();
    expect(sessionOf({ state: "renewing", code: "http_403", since: "2026-09-23T00:00:00.000Z" }))
      .toEqual({ state: "renewing", code: "http_403", since: "2026-09-23T00:00:00.000Z" });
  });

  it("names a cause only for the two refusals and the unreadable seal", () => {
    expect(signInCauseOf(reading("refused", "refresh_revoked"))).toBe("revoked");
    expect(signInCauseOf(reading("refused", "refresh_expired"))).toBe("expired");
    expect(signInCauseOf(reading("seal_failed", "seal_unreadable"))).toBe("seal");
    // The legacy code does not say which, so the ordinary sentence is said.
    expect(signInCauseOf(reading("refused", "unauthorized"))).toBeNull();
    expect(signInCauseOf(reading("renewing", "refresh_revoked"))).toBeNull();
    expect(signInCauseOf(null)).toBeNull();
  });

  it("a fault is due only after the grace; a live session never is", () => {
    const now = Date.now();
    const at = (ms: number): CloudSessionWire => ({ state: "unreachable", code: "network", since: new Date(now - ms).toISOString() });
    expect(cloudNoticeDue(at(CLOUD_NOTICE_GRACE_MS - 1), now)).toBe(false);
    expect(cloudNoticeDue(at(CLOUD_NOTICE_GRACE_MS), now)).toBe(true);
    expect(cloudNoticeDue({ state: "live", code: null, since: new Date(0).toISOString() }, now)).toBe(false);
    expect(cloudNoticeDue({ state: "seal_failed", code: "seal_write_failed", since: new Date(0).toISOString() }, now)).toBe(true);
    // An unreadable seal is the dialog's, never the rail's.
    expect(cloudNoticeDue({ state: "seal_failed", code: "seal_unreadable", since: new Date(0).toISOString() }, now)).toBe(false);
  });
});

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

const CLOUD_SERVING: EngineStatus = {
  state: "serving", mode: "cloud", address: "someone@ohmail.app", mailboxId: "mbx-1", credentialState: "ready",
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
  changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "MA", hasMore: false,
  serverTime: "2026-01-01T00:00:00.000Z",
});
const EMPTY_SNAPSHOT = JSON.stringify({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } });

/** The stand-in shell: a cloud engine whose `/health` answers `health`. */
function fakeShell(health: Record<string, unknown>): void {
  let next = 1;
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => next++,
    invoke: async (command, payload) => {
      if (command === "engine_status") return CLOUD_SERVING;
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

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

async function render(): Promise<HTMLElement> {
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(h(IntlProvider, { locale: "en", messages: messages as never, timeZone: "UTC" },
      h(ThemeProvider, { storageKey: "ohmail.theme" }, h(ToastHost, null, h(DesktopGate, null)))));
  });
  for (let i = 0; i < 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  return mountPoint;
}

const text = (el: HTMLElement): string => el.textContent ?? "";
const mounted = (el: HTMLElement): boolean => text(el).includes("Ohbox");
const dialog = (el: HTMLElement): boolean => text(el).includes(DOOR_COPY.cloudTitle);

async function press(el: HTMLElement, label: string): Promise<void> {
  const b = [...el.querySelectorAll("button")].find((x) => (x.textContent ?? "").includes(label));
  if (!b) throw new Error(`no button saying "${label}"`);
  await act(async () => { b.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}

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

describe("the gate over each session state", () => {
  it("renewing past the grace: the mail stays, no dialog, and the rail says Cloud is being retried", async () => {
    fakeShell({ signedIn: true, sessionExpired: false, session: reading("renewing", "http_403") });
    const el = await render();
    expect(mounted(el), "the mail app over a session that is only renewing").toBe(true);
    expect(dialog(el), "a firewall's 403 never opens the sign-in dialog").toBe(false);
    expect(text(el)).toContain(DOOR_COPY.cloudUnreachableTitle);
  });

  it("the positive control: inside the grace, and when live, the rail says nothing", async () => {
    fakeShell({ signedIn: true, sessionExpired: false, session: reading("unreachable", "network", 1_000) });
    const early = await render();
    expect(mounted(early)).toBe(true);
    expect(text(early)).not.toContain(DOOR_COPY.cloudUnreachableTitle);
    await act(async () => { root!.unmount(); });
    mountPoint?.remove();
    root = null;
    fakeShell({ signedIn: true, sessionExpired: false, session: reading("live", null) });
    const live = await render();
    expect(mounted(live)).toBe(true);
    expect(text(live)).not.toContain(DOOR_COPY.cloudUnreachableTitle);
  });

  it("a save the disk refused while signed in: the mail stays and the rail names the seal", async () => {
    fakeShell({ signedIn: true, sessionExpired: false, sealed: false, session: reading("seal_failed", "seal_write_failed") });
    const el = await render();
    expect(mounted(el)).toBe(true);
    expect(dialog(el)).toBe(false);
    expect(text(el)).toContain(DOOR_COPY.cloudSealPausedTitle(machineWord()));
  });

  for (const [code, lead] of [
    ["refresh_revoked", () => DOOR_COPY.cloudLeadRevoked(machineWord())],
    ["refresh_expired", () => DOOR_COPY.cloudLeadExpired(machineWord())],
    ["unauthorized", () => DOOR_COPY.cloudLeadSignIn(machineWord())],
  ] as const) {
    it(`a coded refusal (${code}) opens the dialog with the sentence for it`, async () => {
      fakeShell({ signedIn: false, sessionExpired: true, session: reading("refused", code) });
      const el = await render();
      expect(mounted(el)).toBe(false);
      await press(el, DOOR_COPY.signIn);
      expect(dialog(el)).toBe(true);
      expect(text(el)).toContain(lead());
    });
  }

  it("a seal this key cannot open: the dialog at launch says so, not the first-run sentence", async () => {
    fakeShell({ signedIn: false, sessionExpired: false, session: reading("seal_failed", "seal_unreadable") });
    const el = await render();
    expect(dialog(el)).toBe(true);
    expect(text(el)).toContain(DOOR_COPY.cloudLeadSealFailed(machineWord()));
    expect(text(el)).not.toContain(DOOR_COPY.cloudLeadSignIn(machineWord()));
  });
});
