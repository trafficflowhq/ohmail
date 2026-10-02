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
 * A SIGN-OUT THE SERVER DID NOT CONFIRM IS SAID ONCE, WHERE THE PRESS LANDS. The window asks the
 * engine to end the session before the shell's own sign-out (whose answer the shell drops), and a
 * press whose server did not confirm leaves one line on the chooser: signed out here, maybe still
 * listed there. A refused or unanswered first step never refuses the press, and a pending switch
 * is left wholly to the shell, which refuses it.
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
const LOCAL: EngineStatus = {
  state: "serving", mode: "local", address: "someone@example.com", mailboxId: "mbx-1", credentialState: "ready",
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

/** What the engine's `DELETE /cloud/session` answers, or `"throw"` for an engine that cannot be asked. */
type DeleteAnswer = Record<string, unknown> | "throw";

/** The stand-in shell: a serving door that `engine_logout` turns into an install with no door. */
function fakeShell(start: EngineStatus, del: DeleteAnswer = { status: "signed_out", revokedAtHost: true }) {
  let current = start;
  const asked: string[] = [];
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      const method = String(payload?.method ?? "GET");
      const url = String(payload?.url ?? "");
      asked.push(command === "engine_request" ? `${method} ${url}` : command);
      if (command === "engine_status") return current;
      if (command === "engine_logout") { current = SIGNED_OUT; return current; }
      if (command === "engine_request") {
        if (method === "DELETE" && url === "/cloud/session") {
          if (del === "throw") throw new Error("the engine went away before it answered");
          return encode(200, JSON.stringify(del));
        }
        if (url === "/health") return encode(200, JSON.stringify({ signedIn: true, sessionExpired: false }));
        if (url.startsWith("/sync/snapshot")) return encode(200, EMPTY_SNAPSHOT);
        if (url.startsWith("/mailboxes")) return encode(200, JSON.stringify({ items: [] }));
        return encode(200, EMPTY_PAGE);
      }
      return null;
    },
  };
  return { asked, deletes: () => asked.filter((a) => a === "DELETE /cloud/session").length };
}

describe("engineLogout(press)", () => {
  afterEach(() => { delete host.__TAURI_INTERNALS__; });

  it("asks the engine to end the session BEFORE the shell's sign-out, and hears the server's answer", async () => {
    const shell = fakeShell(MANAGED, { status: "signed_out", revokedAtHost: true });
    const out = await engineLogout({ status: MANAGED, session: "live" });
    expect(shell.asked).toEqual(["DELETE /cloud/session", "engine_logout"]);
    expect(out).toEqual({ status: SIGNED_OUT, stillListedFrom: null, waiting: null });
  });

  it("a server that did not confirm keeps the press's door for the sentence", async () => {
    fakeShell(MANAGED, { status: "signed_out", revokedAtHost: false });
    expect((await engineLogout({ status: MANAGED, session: "live" })).stillListedFrom).toEqual(MANAGED);
  });

  it("nothing held is nothing to say", async () => {
    fakeShell(MANAGED, { status: "signed_out" });
    expect((await engineLogout({ status: MANAGED, session: "live" })).stillListedFrom).toBeNull();
  });

  it("an engine that cannot be asked never refuses the press: the shell still signs out, and it is said", async () => {
    const shell = fakeShell(MANAGED, "throw");
    const out = await engineLogout({ status: MANAGED, session: "live" });
    expect(shell.asked).toEqual(["DELETE /cloud/session", "engine_logout"]);
    expect(out.status).toEqual(SIGNED_OUT);
    expect(out.stillListedFrom).toEqual(MANAGED);
  });

  it("THE FENCE: a press over a pending switch or a pending door asks the engine nothing first", async () => {
    for (const pending of [{ switchPending: true }, { identityPending: true }]) {
      const shell = fakeShell(MANAGED);
      await engineLogout({ status: { ...MANAGED, ...pending } as EngineStatus, session: "live" });
      expect(shell.deletes(), `a DELETE crossed over ${Object.keys(pending)[0]}`).toBe(0);
      expect(shell.asked).toEqual(["engine_logout"]);
    }
  });

  it("no hosted session, a local door, or no press: the shell's sign-out alone", async () => {
    for (const press of [{ status: MANAGED, session: "out" as const }, { status: LOCAL, session: "unknown" as const }, null]) {
      const shell = fakeShell(press?.status ?? MANAGED);
      const out = await engineLogout(press);
      expect(shell.asked).toEqual(["engine_logout"]);
      expect(out.stillListedFrom).toBeNull();
    }
  });
});

describe("Settings → Desktop → Sign out, read where it lands", () => {
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

  /** Mount the gate on Settings → Desktop, press Sign out and its confirmation, wait for the doors. */
  async function signOutFromSettings(locale: "en" | "de"): Promise<void> {
    if (locale === "de") setActiveCatalog("de", de as never);
    window.location.hash = "#/settings/desktop";
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
    await until("the Settings pane's Sign out", () => buttons(DOOR_COPY.signOut).length === 1);
    await press(DOOR_COPY.signOut);
    await until("the confirmation", () => text().includes(DOOR_COPY.installSignOutConfirm));
    await press(DOOR_COPY.signOut);
    await until("the doors the press lands on", () => (el?.querySelectorAll(".door-tile").length ?? 0) > 0);
  }

  /** The German sentence, from the catalogue itself, with this build's machine word. */
  const german = (where: string): string => {
    const door = de.desktopDoor as unknown as Record<string, string>;
    const machine = MACHINE_WORD === "Mac" ? door.machineMac! : MACHINE_WORD === "PC" ? door.machinePc! : door.machineComputer!;
    return door.signedOutStillListed!.replace("{machine}", machine).replace("{where}", where);
  };

  it("a server that did not confirm: one line naming where the account's own list lives", { timeout: 30_000 }, async () => {
    const shell = fakeShell(MANAGED, { status: "signed_out", revokedAtHost: false });
    await signOutFromSettings("en");
    expect(shell.deletes(), "the press never asked the engine to end the session").toBe(1);
    expect(shell.asked.indexOf("DELETE /cloud/session")).toBeLessThan(shell.asked.indexOf("engine_logout"));
    const line = el!.querySelector(".door-grid")?.parentElement?.querySelector("[role=status]");
    expect(line?.textContent).toBe(DOOR_COPY.signedOutStillListed(machineWord(), "ohmail.app"));
    expect(text()).not.toContain("api.ohmail.app");
  });

  it("the same line in German, from the German catalogue", { timeout: 30_000 }, async () => {
    fakeShell(MANAGED, { status: "signed_out", revokedAtHost: false });
    await signOutFromSettings("de");
    expect(text()).toContain(german("ohmail.app"));
    expect(text()).not.toContain("signedOutStillListed");
  });

  it("a paired door names the other computer", { timeout: 30_000 }, async () => {
    fakeShell(PAIRED, { status: "signed_out", revokedAtHost: false });
    await signOutFromSettings("en");
    expect(text()).toContain(DOOR_COPY.signedOutStillListed(machineWord(), "kestrel"));
  });

  it("a server that ended the session: the chooser says nothing", { timeout: 30_000 }, async () => {
    const shell = fakeShell(MANAGED, { status: "signed_out", revokedAtHost: true });
    await signOutFromSettings("en");
    expect(shell.deletes()).toBe(1);
    expect(el!.querySelector("[role=status]")?.textContent ?? "").not.toContain("Settings → Devices");
    expect(text()).not.toContain(DOOR_COPY.signedOutStillListed(machineWord(), "ohmail.app"));
  });
});
