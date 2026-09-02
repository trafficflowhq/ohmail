/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { DesktopGate } from "../src/DesktopGate.js";
import en from "../../webapp/messages/en.json";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE STANDALONE DOOR OPENS GUIDED SETUP — driven through the chooser, not described
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE FAILURE THIS FILE PINS SHUT, measured on a released build by somebody walking the product
 * as a stranger: choose "On this computer", pick a provider, type the password — and the mail
 * client appears with nothing having asked anything. No welcome, no consent, no window, no
 * question about a model, no progress screen. The release notes said "a first run walks from 'I
 * installed ohmail' to a mailbox that is being organized"; on the main customer door it did not,
 * and the guided flow existed only behind Settings → Mailboxes → "Run setup".
 *
 * The stage itself was there and correct. What was missing was an ENTRY POINT: `AppShell` renders
 * it only at `#/first-run` — deliberately, *"the stage never opens itself"* — and on this door
 * nothing ever put that route on the window.
 *
 * ── WHY THIS IS DRIVEN THROUGH `DesktopGate` AND NOT ASSERTED ON THE SOURCE ─────────────────
 *
 * The seam is one line inside a callback three components deep, and the previous slice's own
 * tests for this flow assert on file TEXT (`toMatch(/goFirstRun\(\{ rerun: true \}\)/)`). Text
 * assertions cannot tell "the call is in the file" from "the call runs when somebody connects" —
 * which is exactly the distinction that was lost here, because the pane's entry point was written
 * and the door's was not, and the flow's own suite was green throughout. So this file presses the
 * real buttons against the real `enterLocalDoor`, over a stand-in shell, and reads the WINDOW'S
 * OWN ROUTE afterwards. Nothing about the assertion survives deleting the navigation.
 *
 * ── AND THE HOSTED DOOR IS THE NEGATIVE CONTROL ────────────────────────────────────────────
 *
 * `firstRunDoorFor` is the one door rule and it answers `null` for a cloud engine, so a cloud
 * entry must leave the route alone. Without that case the fix could be "navigate on every
 * connect", which would put a setup stage over an account whose setup belongs to the account.
 *
 * ── HOW TO WATCH IT FAIL ───────────────────────────────────────────────────────────────────
 *
 * Delete the `openSetupOnStandalone(r.status ?? null);` line from the `gate.kind === "choose"`
 * chooser in `DesktopGate.tsx` and the first case goes red with the route still `""` — which is
 * the released behaviour exactly. Change the guard inside `openSetupOnStandalone` to navigate
 * unconditionally and the cloud case goes red instead. Both mutations were run.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

function encode(status: number, body = "", statusText = "OK"): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText, h: [] }));
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
const EMPTY_SNAPSHOT = JSON.stringify({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } });

/**
 * An install with no door yet — `not_configured`, which is what `gateFor` turns into the chooser.
 *
 * `engine_configure` moves it to `serving` under whichever mode it was handed, which is the whole
 * of what this test needs the shell to model: the door's own sequence (configure → settle → seal
 * → configure → settle) then runs for real against it.
 */
function freshInstall(): { urls: string[] } {
  const urls: string[] = [];
  let status: Record<string, unknown> = { state: "not_configured", mode: null };

  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      if (command === "engine_configure") {
        const config = payload!.config as { mode: string; address?: string };
        status = {
          state: "serving",
          mode: config.mode === "cloud" ? "cloud" : "local",
          address: config.address ?? "",
          mailboxId: "mbx-fresh",
          credentialState: "ready",
        };
        return status;
      }
      if (command === "engine_status") return status;
      if (command === "mailto_claim") return null;
      if (command === "plugin:event|listen") return null;
      if (command === "engine_request") {
        const url = String(payload!.url ?? "");
        urls.push(url);
        if (url === "/health") return encode(200, '{"signedIn":true}');
        if (url === "/cloud/probe") {
          return encode(200, JSON.stringify({ ok: true, target: "https://ohmail.app/hello", flavor: "cloud" }));
        }
        if (url === "/cloud/signin") return encode(200, '{"status":"signed_in"}');
        if (url.startsWith("/sync/snapshot")) return encode(200, EMPTY_SNAPSHOT);
        /* THE SETTLED ROW, read by the first-connect order before it seals. It has to carry the
           ADDRESS that was configured: the door refuses to seal onto a row that names a different
           mailbox, which is what stops a first connect over a populated install from putting a
           newly typed password on the mailbox that install was already opening. */
        if (/^\/mailboxes\/[^/]+$/.test(url) && (payload!.method ?? "GET") === "GET") {
          return encode(200, JSON.stringify({
            id: "mbx-fresh", address: (status as { address?: string }).address ?? "",
          }));
        }
        // The credential seal, and every read the mounted client makes. A permissive 200 here is
        // right: this file is about the ROUTE the window ends on, and a refusal anywhere would
        // only ever make the assertion easier to pass by accident.
        if (url.startsWith("/mailboxes")) return encode(200, JSON.stringify({ items: [] }));
        if (url.startsWith("/consent")) return encode(200, JSON.stringify({ dormancyDays: 60 }));
        if (url.startsWith("/local/ai")) return encode(200, JSON.stringify({ provider: null }));
        return encode(200, EMPTY_PAGE);
      }
      return null;
    },
  };
  return { urls };
}

let root: Root | null = null;
let mount: HTMLElement | null = null;

async function render(): Promise<HTMLElement> {
  mount = document.createElement("div");
  document.body.append(mount);
  root = createRoot(mount);
  await act(async () => {
    root!.render(
      h(
        NextIntlClientProvider,
        { locale: "en", messages: en as never, timeZone: "Europe/Zurich" },
        h(ThemeProvider, { storageKey: "ohmail.theme" }, h(ToastHost, null, h(DesktopGate, null))),
      ),
    );
  });
  await settle();
  return mount!;
}

/** Enough turns for the status reads, the door's two configures and the mount to land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}

async function type(el: HTMLElement, id: string, value: string): Promise<void> {
  const input = el.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`no field #${id} on screen`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * Open one of the three doors BY ITS NAME, never by a substring of the card.
 *
 * The self-hosted tile's own sentence is "Self-hosted ohmail Cloud." — so a `textContent`
 * search for "ohmail Cloud" finds the SERVER tile first and the test walks the wrong door with
 * no error until a field is missing. Matching `.door-name` exactly is what keeps the three
 * distinguishable.
 */
async function openDoor(el: HTMLElement, name: string): Promise<void> {
  const tile = [...el.querySelectorAll<HTMLButtonElement>(".door-tile")]
    .find((t) => (t.querySelector(".door-name")?.textContent ?? "").trim() === name);
  if (!tile) {
    throw new Error(
      `no door named "${name}" — found: ${
        [...el.querySelectorAll(".door-tile")].map((t) => t.querySelector(".door-name")?.textContent).join(" | ")
      }`,
    );
  }
  await act(async () => {
    tile.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

async function press(el: HTMLElement, label: string): Promise<void> {
  const found = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label));
  if (!found) {
    throw new Error(
      `no button saying "${label}" — found: ${[...el.querySelectorAll("button")].map((b) => b.textContent).join(" | ")}`,
    );
  }
  await act(async () => {
    found.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

beforeEach(() => {
  window.location.hash = "";
  localStorage.clear();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  mount?.remove();
  root = null;
  mount = null;
  delete host.__TAURI_INTERNALS__;
  window.location.hash = "";
  localStorage.clear();
});

describe("connecting on the standalone door opens guided setup", () => {
  it("THE MAIN CUSTOMER DOOR — provider, address, password, and the window is at #/first-run", async () => {
    freshInstall();
    const el = await render();

    // The chooser is what a fresh install lands on. If this throws, the test is asserting
    // against a screen that is not the one the defect was reported on.
    expect(el.textContent).toContain("Which mailbox is this?");
    expect(window.location.hash, "nothing has been asked for yet").toBe("");

    await openDoor(el, "On this computer");
    await press(el, "Any other IMAP mailbox");
    await type(el, "door-address", "peter@example.test");
    await type(el, "door-password", "a-mailbox-password");
    await type(el, "door-imap-host", "imap.example.test");
    await press(el, "Open this mailbox");

    /* THE WHOLE ASSERTION. `#/first-run` is the only route at which `AppShell` renders the stage
       at all, so this is "the guided flow opened" stated in the one term the shell reads. On the
       released build this was `""` — the mail client, and nothing having asked anything. */
    expect(window.location.hash).toBe("#/first-run");
  });

  it("NOT A RE-RUN. The route is the first run's, so the flow opens where the facts say", async () => {
    /* `#/first-run/again` pre-fills from what the account stored and — by design — takes its
       navigation from the cursor rather than from the derivation, because a finished account
       derives to "nothing to do". Sending a FIRST run down that route would put somebody who has
       consented to nothing on a screen written for somebody who has. One character apart in the
       hash, and the two behave differently at every write. */
    freshInstall();
    const el = await render();
    await openDoor(el, "On this computer");
    await press(el, "Any other IMAP mailbox");
    await type(el, "door-address", "peter@example.test");
    await type(el, "door-password", "a-mailbox-password");
    await type(el, "door-imap-host", "imap.example.test");
    await press(el, "Open this mailbox");

    expect(window.location.hash).not.toBe("#/first-run/again");
    expect(window.location.hash).toBe("#/first-run");
  });

  it("THE HOSTED DOOR NAVIGATES NOWHERE — that account's setup is not this install's", async () => {
    freshInstall();
    const el = await render();

    await openDoor(el, "ohmail Cloud");
    await type(el, "cloud-address", "someone@ohmail.app");
    await type(el, "cloud-password", "a-password-long-enough");
    await type(el, "cloud-totp", "123456");
    await press(el, "Sign in");

    /* `firstRunDoorFor` answers `null` on a cloud engine, so `useLocalFirstRun` hands `AppShell`
       no host and `#/first-run` would draw nothing whatever the route said. Navigating there
       anyway would be a dead route on a working install. */
    expect(window.location.hash).toBe("");
  });
});
