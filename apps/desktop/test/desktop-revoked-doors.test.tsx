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
 * ═══ A REVOKED PAIRING'S TWO BUTTONS LEAD TO THEIR TWO DOORS ═════════════════════════════════
 *
 * The card a revoked pairing lands on offers opposite remedies — pair with that computer again,
 * or stop depending on it — and each one only means anything if pressing it opens the door it
 * names. Both set overlay state, and the overlay is rendered at the END of the gate, under the
 * mail client; this branch RETURNS before it. So both buttons left the person on the same
 * notice with nothing on screen having changed: a press that reports nothing, which is the
 * state this window exists to make impossible.
 *
 * Read from RENDERED OUTPUT, never from the state a press set: the defect is precisely a state
 * change nobody renders.
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

/** A paired install: the cloud door's `desktop-host` flavour, reading through another computer. */
const PAIRED: EngineStatus = {
  state: "serving",
  mode: "cloud",
  flavor: "desktop-host",
  address: "someone@example.com",
  mailboxId: "mbx-1",
  baseUrl: "https://kestrel.tail1234.ts.net",
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

/** The shell behind the bridge: a paired engine whose hosted session was revoked. */
function fakeShell(status: EngineStatus): void {
  const callbacks = new Map<number, (payload: unknown) => void>();
  let next = 1;
  host.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => {
      const id = next++;
      callbacks.set(id, cb);
      return id;
    },
    invoke: async (command, payload) => {
      if (command === "engine_status") return status;
      if (command === "mailto_claim") return null;
      if (command === "plugin:event|listen") return null;
      if (command === "engine_request") {
        const url = String(payload?.url ?? "");
        /* REVOKED: the engine learnt the pairing was removed on the other computer. */
        if (url === "/health") return encode(200, JSON.stringify({ sessionExpired: true, signedIn: false }));
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

function buttonSaying(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")].filter((b) => (b.textContent ?? "").includes(label));
  if (found.length !== 1) throw new Error(`${found.length} buttons say "${label}", expected one`);
  return found[0]!;
}

async function press(el: HTMLElement, label: string): Promise<void> {
  await act(async () => {
    buttonSaying(el, label).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
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
  fakeShell(PAIRED);
});

describe("a revoked pairing's card", () => {
  it("says what happened, in its own sentence, with both remedies offered", async () => {
    /* The POSITIVE control for the two below: the notice itself must keep rendering. A fix that
       made the doors reachable by dropping the card would pass both of those and be worse. */
    const el = await render();
    expect(el.textContent ?? "").toContain(DOOR_COPY.gateUnpaired(machineWord(), "kestrel"));
    expect(buttonSaying(el, DOOR_COPY.gatePairAgain)).toBeTruthy();
    expect(buttonSaying(el, DOOR_COPY.gateOwn)).toBeTruthy();
  });

  it("Pair again opens the pairing door, on screen", async () => {
    const el = await render();
    await press(el, DOOR_COPY.gatePairAgain);
    /* THE DOOR'S OWN FIRST SENTENCE and its one field — read from the DOM, because the defect
       is a press that moves state nothing renders. */
    expect(el.textContent ?? "", "the pairing door's lead is not on screen")
      .toContain(DOOR_COPY.hostAskLead);
    expect(el.querySelector("#host-link"), "the pairing door has no link field on screen")
      .not.toBeNull();
  });

  it("Set up on its own opens the takeover card, on screen", async () => {
    const el = await render();
    await press(el, DOOR_COPY.gateOwn);
    expect(el.textContent ?? "", "the takeover card's lead is not on screen")
      .toContain(DOOR_COPY.takeoverLabel(machineWord()));
    expect(el.textContent ?? "").toContain("open your mail server itself and organize it");
  });
});
