/** @vitest-environment jsdom */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it } from "vitest";
import { launchRefused } from "@trafficflow/services/mail";

import en from "../../webapp/messages/en.json";

/**
 * THE DESKTOP'S OWN-SERVER DOOR ON GMAIL: the note before the press, and Google's refusal with its
 * links. The engine answers the credential write with the envelope the service builds for a hinted
 * refusal (`launchRefused`); the sentence is the engine's own, and the App Password links sit under
 * it for the two password kinds only. Control: the same refusal with no hint carries no links.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const HELP = "https://myaccount.google.com/apppasswords";
const PREREQ = "https://myaccount.google.com/signinoptions/twosv";

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

/** The engine refuses the credential write with the service's envelope for `hint`. */
function refusingShell(hint?: string): string {
  const r = launchRefused("auth", false, hint as never) as unknown as { code: string; message: string; details: unknown };
  const body = JSON.stringify({ error: { code: r.code, message: r.message, details: r.details } });
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      if (command === "engine_configure") return { state: "starting", mode: "local" };
      if (command === "engine_status") {
        return { state: "serving", mode: "local", address: "mila@gmail.test", mailboxId: "mbx-1", credentialState: "absent" };
      }
      if (command === "engine_request") {
        const req = payload as { method?: string } | undefined;
        if ((req?.method ?? "GET") === "GET") return encode(200, JSON.stringify({ id: "mbx-1", address: "mila@gmail.test" }));
        return encode(400, body, "Bad Request");
      }
      throw new Error(`unexpected command ${command}`);
    },
  };
  return r.message;
}

let root: Root | null = null;
let mount: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  mount?.remove();
  root = null;
  mount = null;
  delete host.__TAURI_INTERNALS__;
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
const count = (el: HTMLElement, href: string): number =>
  [...el.querySelectorAll("a")].filter((a) => a.getAttribute("href") === href).length;

async function gmailDoor(): Promise<HTMLElement> {
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
  await act(async () => { button(mount!, "Gmail").click(); });
  await set(mount, "door-address", "mila@gmail.test");
  await set(mount, "door-password", "the-google-password");
  return mount;
}
async function open(el: HTMLElement): Promise<void> {
  await act(async () => { button(el, "Open this mailbox").click(); });
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("the desktop's own-server door on Gmail", () => {
  it("says App Password, with both links, before the press", async () => {
    refusingShell();
    const el = await gmailDoor();
    expect(el.textContent).toContain(en.providerPicker.note_gmail);
    expect(count(el, PREREQ)).toBe(1);
    expect(count(el, HELP)).toBe(1);
  });

  for (const [hint, linked] of [["app_password_required", true], ["invalid", true], ["web_login", false], ["imap_disabled", false]] as const) {
    it(`${hint}: the engine's sentence, and the links ${linked ? "under it" : "only in the note"}`, async () => {
      const said = refusingShell(hint);
      const el = await gmailDoor();
      await open(el);
      expect(el.querySelector(".join-error")?.textContent).toBe(said);
      expect(said).toBe((en.mailboxes as Record<string, string>)[`probe_auth_gmail_${hint}`]);
      expect(count(el, HELP)).toBe(linked ? 2 : 1);
      expect(count(el, PREREQ)).toBe(linked ? 2 : 1);
    });
  }

  it("control: a refusal with no hint carries no links", async () => {
    const said = refusingShell();
    const el = await gmailDoor();
    await open(el);
    expect(el.querySelector(".join-error")?.textContent).toBe(said);
    expect(count(el, HELP)).toBe(1);
  });
});
