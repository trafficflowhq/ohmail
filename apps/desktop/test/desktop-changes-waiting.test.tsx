/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { DesktopGate } from "../src/DesktopGate.js";
import { engineLogout, type EngineStatus } from "../src/bridge-fetch.js";
import { DOOR_COPY, machineWord } from "../src/door-copy.js";
import { MACHINE_WORD } from "../src/platform.js";
import { setActiveCatalog } from "../../webapp/app/shell/locale.js";
import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";

/**
 * THE PERSON IS TOLD HOW MANY OF THE WINDOW'S CHANGES WAIT ON THIS COMPUTER, AND FOR WHOM. A
 * sign-out answers the count its engine still keeps for the account, and the chooser the press
 * lands on says it first; the sign-in card says it from `/health`, across a restart. Nothing the
 * window holds about it is written anywhere.
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
const SIGNED_OUT = { state: "not_configured", mode: null, missing: ["config.json"] } as unknown as EngineStatus;

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

/** A cloud engine whose `/health` answers `health` and whose `DELETE /cloud/session` answers `del`. */
function fakeShell(start: EngineStatus, opts: { health?: Record<string, unknown>; del?: Record<string, unknown> } = {}) {
  let current = start;
  const writes: string[] = [];
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      if (command === "engine_status") return current;
      if (command === "engine_logout") { current = SIGNED_OUT; return current; }
      if (command === "mailto_claim" || command === "plugin:event|listen") return null;
      if (command === "engine_request") {
        const method = String(payload?.method ?? "GET");
        const url = String(payload?.url ?? "");
        if (method !== "GET") writes.push(`${method} ${url}`);
        if (method === "DELETE" && url === "/cloud/session") {
          return encode(200, JSON.stringify(opts.del ?? { status: "signed_out", revokedAtHost: true, queued: 0 }));
        }
        if (url === "/health") return encode(200, JSON.stringify(opts.health ?? { signedIn: true, sessionExpired: false }));
        if (url.startsWith("/sync/snapshot")) return encode(200, EMPTY_SNAPSHOT);
        if (url.startsWith("/mailboxes")) return encode(200, JSON.stringify({ items: [] }));
        return encode(200, EMPTY_PAGE);
      }
      return null;
    },
  };
  return { writes };
}

/** The German sentence for one change, from the catalogue's own `one` branch. */
function germanOne(who: string): string {
  const message = (de.desktopDoor as unknown as Record<string, string>).changesWaiting!;
  const at = message.indexOf("one {") + "one {".length;
  let depth = 1;
  let end = at;
  while (depth > 0) {
    const c = message[end++];
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  const door = de.desktopDoor as unknown as Record<string, string>;
  const machine = MACHINE_WORD === "Mac" ? door.machineMac! : MACHINE_WORD === "PC" ? door.machinePc! : door.machineComputer!;
  return message.slice(at, end - 1).replaceAll("{who}", who).replaceAll("{machine}", machine);
}

describe("engineLogout(press) carries what still waits", () => {
  afterEach(() => { delete host.__TAURI_INTERNALS__; });

  it("the count the engine answered, for the account's address", async () => {
    fakeShell(MANAGED, { del: { status: "signed_out", revokedAtHost: true, queued: 2 } });
    const out = await engineLogout({ status: MANAGED, session: "live" });
    expect(out).toEqual({ status: SIGNED_OUT, stillListedFrom: null, waiting: { count: 2, who: "someone@ohmail.app" } });
  });

  it("on a paired door, for the other computer", async () => {
    fakeShell(PAIRED, { del: { status: "signed_out", revokedAtHost: true, queued: 1 } });
    expect((await engineLogout({ status: PAIRED, session: "live" })).waiting).toEqual({ count: 1, who: "kestrel" });
  });

  it("said whether or not the server confirmed the sign-out", async () => {
    fakeShell(MANAGED, { del: { status: "signed_out", revokedAtHost: false, queued: 1 } });
    const out = await engineLogout({ status: MANAGED, session: "live" });
    expect(out.waiting).toEqual({ count: 1, who: "someone@ohmail.app" });
    expect(out.stillListedFrom).toEqual(MANAGED);
  });

  it("nothing waiting, or an engine that says nothing about it, is nothing to say", async () => {
    for (const del of [{ status: "signed_out", revokedAtHost: true, queued: 0 }, { status: "signed_out", revokedAtHost: true }]) {
      fakeShell(MANAGED, { del });
      expect((await engineLogout({ status: MANAGED, session: "live" })).waiting, JSON.stringify(del)).toBeNull();
    }
  });
});

describe("where the person reads it", () => {
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
    setActiveCatalog("en", null);
  });

  const text = (): string => el?.textContent ?? "";
  const statusLines = (): string[] => [...(el?.querySelectorAll("[role=status]") ?? [])].map((n) => n.textContent ?? "");
  const buttons = (label: string): HTMLButtonElement[] =>
    [...(el?.querySelectorAll("button") ?? [])].filter((b) => (b.textContent ?? "").trim() === label) as HTMLButtonElement[];
  async function until(what: string, ok: () => boolean, ms = 15_000): Promise<void> {
    const t0 = Date.now();
    while (!ok()) {
      if (Date.now() - t0 > ms) throw new Error(`waited ${ms} ms for ${what}; the window read: ${text().slice(0, 300)}`);
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    }
  }
  async function press(label: string): Promise<void> {
    const found = buttons(label);
    if (found.length !== 1) throw new Error(`expected one button saying "${label}", found ${found.length}`);
    await act(async () => { found[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  }
  async function mount(locale: "en" | "de", hash = ""): Promise<void> {
    if (locale === "de") setActiveCatalog("de", de as never);
    window.location.hash = hash;
    el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => {
      root!.render(
        <IntlProvider locale={locale} messages={(locale === "de" ? de : en) as never} timeZone="UTC">
          <ThemeProvider storageKey="ohmail.theme"><ToastHost><DesktopGate /></ToastHost></ThemeProvider>
        </IntlProvider>,
      );
    });
  }
  /** Settings → Desktop → Sign out and its confirmation, then the doors the press lands on. */
  async function signOut(locale: "en" | "de"): Promise<void> {
    await mount(locale, "#/settings/desktop");
    await until("the Settings pane's Sign out", () => buttons(DOOR_COPY.signOut).length === 1);
    await press(DOOR_COPY.signOut);
    await until("the confirmation", () => text().includes(DOOR_COPY.installSignOutConfirm));
    await press(DOOR_COPY.signOut);
    await until("the doors the press lands on", () => (el?.querySelectorAll(".door-tile").length ?? 0) > 0);
  }
  const chooserLine = (): string | null =>
    el!.querySelector(".door-grid")?.parentElement?.querySelector("[role=status]")?.textContent ?? null;

  it("(9) the press: one change for the account, said where the press lands", { timeout: 30_000 }, async () => {
    fakeShell(MANAGED, { del: { status: "signed_out", revokedAtHost: true, queued: 1 } });
    await signOut("en");
    expect(chooserLine()).toBe(DOOR_COPY.changesWaiting(1, "someone@ohmail.app", machineWord()));
    expect(chooserLine()).toBe(`One change for someone@ohmail.app waiting on this ${machineWord()}. `
      + "Sent when someone@ohmail.app signs in again here.");
  });

  it("(9) the same in German, from the German catalogue", { timeout: 30_000 }, async () => {
    fakeShell(MANAGED, { del: { status: "signed_out", revokedAtHost: true, queued: 1 } });
    await signOut("de");
    expect(chooserLine()).toBe(germanOne("someone@ohmail.app"));
    expect(text()).not.toContain("changesWaiting");
  });

  it("(9) both outcomes: what waits first, then where the session may still be listed", { timeout: 30_000 }, async () => {
    fakeShell(MANAGED, { del: { status: "signed_out", revokedAtHost: false, queued: 2 } });
    await signOut("en");
    expect(chooserLine()).toBe(`${DOOR_COPY.changesWaiting(2, "someone@ohmail.app", machineWord())} `
      + DOOR_COPY.signedOutStillListed(machineWord(), "ohmail.app"));
  });

  it("(9) nothing waiting: the chooser says nothing about changes", { timeout: 30_000 }, async () => {
    const shell = fakeShell(MANAGED, { del: { status: "signed_out", revokedAtHost: true, queued: 0 } });
    await signOut("en");
    expect(shell.writes, "control: the press asked the engine").toContain("DELETE /cloud/session");
    expect(statusLines().join(" ")).not.toContain("waiting on this");
  });

  it("(10) the refused card says what waits, from /health", { timeout: 30_000 }, async () => {
    fakeShell(MANAGED, {
      health: { signedIn: false, sessionExpired: true, session: { state: "refused", code: "refresh_revoked", since: new Date().toISOString() }, queued: { count: 2 } },
    });
    await mount("en");
    await until("the sign-in card", () => (el?.querySelector(".session-end") ?? null) !== null);
    const card = el!.querySelector(".session-end")!;
    expect([...card.querySelectorAll("[role=status]")].map((n) => n.textContent))
      .toContain(DOOR_COPY.changesWaiting(2, "someone@ohmail.app", machineWord()));
  });

  it("(10) the plain sign-in after a restart says it too", { timeout: 30_000 }, async () => {
    fakeShell(MANAGED, { health: { signedIn: false, sessionExpired: false, queued: { count: 1 } } });
    await mount("en");
    await until("the sign-in form", () => text().includes(DOOR_COPY.cloudTitle));
    expect(statusLines()).toContain(DOOR_COPY.changesWaiting(1, "someone@ohmail.app", machineWord()));
  });

  it("(10) nothing waiting: the card and the form say nothing about changes", { timeout: 30_000 }, async () => {
    for (const health of [
      { signedIn: false, sessionExpired: true, session: { state: "refused", code: "refresh_revoked", since: new Date().toISOString() }, queued: { count: 0 } },
      { signedIn: false, sessionExpired: false },
    ]) {
      fakeShell(MANAGED, { health });
      await mount("en");
      await until("the sign-in surface", () => text().includes(DOOR_COPY.cloudTitle));
      expect(statusLines().join(" "), JSON.stringify(health)).not.toContain("waiting on this");
      await act(async () => { root!.unmount(); });
      el?.remove();
      root = null;
    }
  });
});
