/** @vitest-environment jsdom */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import en from "../../webapp/messages/en.json";

/**
 * THE DESKTOP'S OWN-SERVER DOOR TELLS A REFUSAL WHERE THE PRESS WAS. "Open this mailbox" sits at the
 * bottom of a card that scrolls past the provider grid, and the refusal used to be drawn at the
 * top of the card with focus on nothing. jsdom has no layout, so the page is a model: one row per
 * element in document order, the viewport on the button as it is after a press there.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const ROW = 40;
const VIEW = 400;
let scrollY = 0;
const topOf = (el: Element): number => [...document.querySelectorAll("*")].indexOf(el) * ROW;
const inView = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= VIEW;
};
const realRect = Element.prototype.getBoundingClientRect;
const realScroll = Element.prototype.scrollIntoView;

const REFUSED = JSON.stringify({
  error: {
    code: "mailbox_probe_failed",
    message: "We could not reach that mail server. Check the IMAP host and port and try again.",
    details: { reason: "connect", transport: "imap" },
  },
});

function encode(status: number, body = "", statusText = "OK"): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText, h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

/** The standalone door's shell: the row read succeeds, the credential write is refused. */
function refusingShell(): void {
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      if (command === "engine_configure") return { state: "starting", mode: "local" };
      if (command === "engine_status") {
        return { state: "serving", mode: "local", address: "mila@example.com", mailboxId: "mbx-1", credentialState: "absent" };
      }
      if (command === "engine_request") {
        const req = payload as { method?: string } | undefined;
        if ((req?.method ?? "GET") === "GET") return encode(200, JSON.stringify({ id: "mbx-1", address: "mila@example.com" }));
        return encode(400, REFUSED, "Bad Request");
      }
      throw new Error(`unexpected command ${command}`);
    },
  };
}

let root: Root | null = null;
let mount: HTMLElement | null = null;

beforeEach(() => {
  scrollY = 0;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const top = topOf(this) - scrollY;
    return { top, bottom: top + ROW, height: ROW, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} } as DOMRect;
  };
  Element.prototype.scrollIntoView = function (this: Element) {
    const t = topOf(this);
    if (t < scrollY) scrollY = t;
    else if (t + ROW > scrollY + VIEW) scrollY = t + ROW - VIEW;
  };
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  mount?.remove();
  root = null;
  mount = null;
  delete host.__TAURI_INTERNALS__;
  Element.prototype.getBoundingClientRect = realRect;
  Element.prototype.scrollIntoView = realScroll;
});

const set = async (el: HTMLElement, id: string, value: string): Promise<void> => {
  const input = el.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`no field #${id} on screen`);
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
  await act(async () => { input.dispatchEvent(new Event("input", { bubbles: true })); });
};

const button = (el: HTMLElement, label: string): HTMLButtonElement => {
  const found = [...el.querySelectorAll("button")].filter((b) => (b.textContent ?? "").startsWith(label));
  expect(found.length, `"${label}" matched ${found.length} controls`).toBe(1);
  return found[0]!;
};

describe("the desktop's own-server door", () => {
  it("puts the refusal beside Open, in view and focused, press after press", async () => {
    refusingShell();
    const { DoorChooser } = await import("../src/DoorChooser.js");
    mount = document.createElement("div");
    document.body.append(mount);
    root = createRoot(mount);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages: en as never, timeZone: "Europe/Zurich",
        children: h(DoorChooser, { start: "local", onEntered: () => {} }),
      }));
    });
    await act(async () => { button(mount!, "Any other IMAP mailbox").click(); });
    await set(mount, "door-address", "mila@example.com");
    await set(mount, "door-password", "app-password-fixture");
    await set(mount, "door-imap-host", "mail.example.org");
    await set(mount, "door-smtp-host", "smtp.example.org");

    const open = () => button(mount!, "Open this mailbox");
    scrollY = topOf(open()) + ROW - VIEW;
    expect(inView(mount.querySelector("h1")!), "the modelled card does not scroll").toBe(false);

    for (const attempt of [1, 2]) {
      scrollY = topOf(open()) + ROW - VIEW;
      open().focus();
      await act(async () => { open().click(); });
      for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      const said = mount.querySelector<HTMLElement>(".join-error");
      expect(said?.textContent ?? "", `press ${attempt}: no refusal`).toContain("could not reach");
      expect(inView(said!), `press ${attempt}: the refusal is off screen`).toBe(true);
      expect(document.activeElement, `press ${attempt}: focus is not on the refusal`).toBe(said);
    }
  });
});
