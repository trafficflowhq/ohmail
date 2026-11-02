/** @vitest-environment jsdom */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it } from "vitest";
import { launchRefused } from "@trafficflow/services/mail";

import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";
import { DEFAULT_LOCALE, fillFrom, setActiveCatalog } from "../../webapp/app/shell/locale";

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

async function gmailDoor(locale: "en" | "de" = "en"): Promise<HTMLElement> {
  const { DoorChooser } = await import("../src/DoorChooser.js");
  mount = document.createElement("div");
  document.body.append(mount);
  root = createRoot(mount);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: (locale === "de" ? de : en) as never, timeZone: "Europe/Zurich",
      children: h(DoorChooser, { start: "local", onEntered: () => {} }),
    }));
  });
  await act(async () => { button(mount!, "Gmail").click(); });
  await set(mount, "door-address", "mila@gmail.test");
  await set(mount, "door-password", "the-google-password");
  return mount;
}
async function open(el: HTMLElement, label = "Open this mailbox"): Promise<void> {
  await act(async () => { button(el, label).click(); });
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

  /* A GERMAN WINDOW SAYS THE ENGINE'S REFUSAL IN GERMAN: the engine writes English, and the door
     words the refusal from its code and details through the catalogue the window set. */
  it("in a German window, the engine's refusal is the catalogue's German sentence", async () => {
    const said = refusingShell();
    setActiveCatalog("de", fillFrom(en as never, de as never));
    try {
      const el = await gmailDoor("de");
      await open(el, "Dieses Postfach öffnen");
      expect(el.querySelector(".join-error")?.textContent).toBe((de.mailboxes as Record<string, string>).probe_auth);
      expect(el.textContent).not.toContain(said);
    } finally {
      setActiveCatalog(DEFAULT_LOCALE, null);
    }
  });
});

/* A SERVER ON THIS COMPUTER WITH ITS OWN CERTIFICATE (Proton Mail Bridge) on the same door: the
   engine's refusal offers that certificate, the line names its fingerprint unticked, and only a
   press made with the tick carries it — on both blocks, one host on both legs. */
describe("the desktop's own-server door and a server on this computer with its own certificate", () => {
  const PRINT = ["4A", ...Array.from({ length: 31 }, (_, i) => (i + 16).toString(16).toUpperCase())].join(":");
  const LINE = en.mailboxes.trustCertificateLabelBoth.replace("{fingerprint}", PRINT);

  /** The engine refuses every seal with the offer; the fingerprints each seal claimed, nothing else. */
  function bridgeShell(): Array<{ imap?: unknown; smtp?: unknown }> {
    const claimed: Array<{ imap?: unknown; smtp?: unknown }> = [];
    const body = JSON.stringify({ error: {
      code: "mailbox_probe_failed", message: "The server on this computer uses its own certificate.",
      details: { reason: "tls", transport: "imap", localServer: true, tls: { kind: "self_signed", certificate: { sha256: PRINT } } },
    } });
    host.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, payload) => {
        if (command === "engine_configure") return { state: "starting", mode: "local" };
        if (command === "engine_status") {
          return { state: "serving", mode: "local", address: "mila@bridge.test", mailboxId: "mbx-1", credentialState: "absent" };
        }
        if (command === "engine_request") {
          const req = payload as { method?: string; body?: number[] };
          if ((req.method ?? "GET") === "GET") return encode(200, JSON.stringify({ id: "mbx-1", address: "mila@bridge.test" }));
          const sent = JSON.parse(new TextDecoder().decode(new Uint8Array(req.body ?? []))) as {
            imap?: { trustCertificate?: unknown }; smtp?: { trustCertificate?: unknown };
          };
          claimed.push({ imap: sent.imap?.trustCertificate, smtp: sent.smtp?.trustCertificate });
          return encode(400, body, "Bad Request");
        }
        throw new Error(`unexpected command ${command}`);
      },
    };
    return claimed;
  }
  const line = (el: HTMLElement): HTMLInputElement | null =>
    [...el.querySelectorAll("label")].find((l) => (l.textContent ?? "").includes(LINE))?.querySelector("input") ?? null;

  it("names the fingerprint unticked, and the tick's press claims it on both blocks", async () => {
    const claimed = bridgeShell();
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
    await act(async () => { button(mount!, en.providerPicker.otherLabel).click(); });
    await set(mount, "door-address", "mila@bridge.test");
    await set(mount, "door-password", "the-bridge-password");
    await set(mount, "door-imap-host", "127.0.0.1");
    await set(mount, "door-imap-port", "1143");
    await set(mount, "door-smtp-host", "127.0.0.1");
    await set(mount, "door-smtp-port", "1025");
    await open(mount);
    expect(line(mount), "no trust line naming the fingerprint").not.toBeNull();
    expect(line(mount)!.checked).toBe(false);
    expect(claimed[0]).toEqual({ imap: undefined, smtp: undefined });

    await act(async () => { line(mount!)!.click(); });
    await open(mount);
    expect(claimed[1]).toEqual({ imap: PRINT, smtp: PRINT });
  });
});
