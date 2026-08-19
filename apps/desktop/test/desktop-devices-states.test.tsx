/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import en from "../../webapp/messages/en.json";
import { DesktopDevices } from "../src/DesktopDevices.js";

/**
 * ═══ EVERY DESIGNED STATE OF THE DEVICES PANE, RENDERED ═══════════════════════════════════════
 *
 * One walk over the pane's whole state space — each state mounted against a stubbed shell and
 * held to its headline sentence, so a state that stops rendering (or renders another state's
 * words) is a red test rather than a screenshot review finding.
 *
 * DOUBLES AS THE VISUAL CAPTURE HARNESS. With `OHMAIL_DEVICES_PANE_CAPTURE_DIR` set, each
 * state's rendered markup is written to `<dir>/<name>.html` — the fragments a capture script
 * wraps in the app's stylesheets and screenshots for design review. Without the variable the
 * walk is an ordinary suite member and writes nothing.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

const CAPTURE_DIR = process.env.OHMAIL_DEVICES_PANE_CAPTURE_DIR;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
const globe = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } };

function framed(status: number, body: unknown): Uint8Array {
  const meta = new TextEncoder().encode(
    JSON.stringify({ status, statusText: "", h: [["content-type", "application/json"]] }),
  );
  const bytes = body === null ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(body));
  const out = new Uint8Array(4 + meta.length + bytes.length);
  new DataView(out.buffer).setUint32(0, meta.length, false);
  out.set(meta, 4);
  out.set(bytes, 4 + meta.length);
  return out;
}

function shell(world: {
  hostState: unknown;
  tailscale: unknown;
  routes?: Record<string, { status: number; body: unknown }>;
}): void {
  globe.__TAURI_INTERNALS__ = {
    invoke: (command, payload) => {
      switch (command) {
        case "host_state":
          return Promise.resolve(world.hostState);
        case "tailscale_status":
          return Promise.resolve(world.tailscale);
        case "open_tailscale_download":
          return Promise.resolve(undefined);
        case "engine_request": {
          const p = payload as { method: string; url: string };
          const hit = world.routes?.[`${p.method} ${p.url}`];
          return Promise.resolve(framed(hit?.status ?? 404, hit?.body ?? { error: { code: "not_found" } }));
        }
        default:
          return Promise.resolve(undefined);
      }
    },
  };
}

let hostEl: HTMLDivElement;
let root: Root;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  hostEl?.remove();
  delete globe.__TAURI_INTERNALS__;
});

async function mount(): Promise<void> {
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, { locale: "en", messages: en as never, timeZone: "Europe/Zurich" },
        h(ThemeProvider, null, h(ToastHost, null, h(DesktopDevices)))),
    );
  });
  await act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

const click = async (label: string): Promise<void> => {
  const found = [...hostEl.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button "${label}"`);
  await act(async () => {
    found.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
};

function capture(name: string): void {
  if (!CAPTURE_DIR) return;
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CAPTURE_DIR, `${name}.html`), hostEl.innerHTML);
}

// ── Fixtures — a real minted-shape token, a real MagicDNS origin ───────────────────────────────

const ORIGIN = "https://sonoma.tail1234.ts.net";
const TOKEN = "dpt_4be6f0a92d3c41e78a51c07b9e2d8f13";
const OFF = { enabled: false, port: null, origin: null, state: "off", problem: null, autostart: null };
const RUNNING = { state: "running", dnsName: "sonoma.tail1234.ts.net", version: "1.66.0" };
const SERVING = { enabled: true, port: 47800, origin: ORIGIN, state: "serving", problem: null, autostart: true };

const LISTS = {
  "GET /pair": {
    status: 200,
    body: {
      items: [
        { id: "pt-1", grant: "device-pair", status: "live", label: "Mara's phone", createdAt: "2026-08-19T12:00:00Z", expiresAt: "2026-08-19T12:05:00Z", consumedAt: null, revokedAt: null },
      ],
    },
  },
  "GET /devices": {
    status: 200,
    body: {
      items: [
        { id: "sess-self", kind: "web", label: "", createdAt: "2026-08-19T09:00:00Z", lastSeenAt: "2026-08-19T12:00:00Z", ip: "", current: true, pushToken: null },
        { id: "dev-1", kind: "web", label: "Jonas' phone", createdAt: "2026-08-15T09:00:00Z", lastSeenAt: "2026-08-19T08:12:00Z", ip: "", current: false, pushToken: null },
        { id: "dev-2", kind: "web", label: "Kitchen tablet", createdAt: "2026-08-10T18:00:00Z", lastSeenAt: "2026-08-18T21:40:00Z", ip: "", current: false, pushToken: null },
      ],
    },
  },
};

const hostCopy = (en as { host: Record<string, string> }).host;

describe("every designed state renders — and is captured for the design review", () => {
  it("OFF, ready: the explainer, the one-sentence Tailscale story, the enable ceremony", async () => {
    shell({ hostState: OFF, tailscale: RUNNING });
    await mount();
    expect(hostEl.textContent).toContain(hostCopy.lead!);
    expect(hostEl.textContent).toContain(hostCopy.story!);
    expect(hostEl.textContent).toContain(hostCopy.autostart!);
    capture("1-off-ready");
  });

  it("OFF, advanced open: the port, defaulted, for whoever asks", async () => {
    shell({ hostState: OFF, tailscale: RUNNING });
    await mount();
    await click(hostCopy.advanced!);
    expect(hostEl.querySelector(`input[aria-label="${hostCopy.port}"]`)).not.toBeNull();
    capture("2-off-advanced");
  });

  it("OFF, guided: Tailscale missing — the friendly install step with the deep-link", async () => {
    shell({ hostState: OFF, tailscale: { state: "no-cli" } });
    await mount();
    expect(hostEl.textContent).toContain(hostCopy.guideNoCli!);
    expect(hostEl.textContent).toContain(hostCopy.getTailscale!);
    capture("3-off-no-cli");
  });

  it("ON, serving: the awake-qualified status line, add-a-device, the lists", async () => {
    shell({ hostState: SERVING, tailscale: RUNNING, routes: LISTS });
    await mount();
    expect(hostEl.textContent).toContain("while this computer is awake");
    expect(hostEl.textContent).toContain(ORIGIN);
    expect(hostEl.textContent).toContain("Jonas' phone");
    expect(hostEl.textContent).toContain("Kitchen tablet");
    capture("4-on-serving");
  });

  it("ON, the QR moment: a real minted-shape token, shown as a code and a copy button only", async () => {
    shell({
      hostState: SERVING,
      tailscale: RUNNING,
      routes: {
        ...LISTS,
        "POST /pair": {
          status: 200,
          body: { id: "pt-2", token: TOKEN, grant: "device-pair", label: "Mara's phone", expiresAt: "2026-08-19T12:05:00.000Z" },
        },
      },
    });
    await mount();
    await click(hostCopy.addAction!);
    expect(hostEl.querySelector("svg")).not.toBeNull();
    expect(hostEl.textContent).not.toContain(TOKEN);
    capture("5-on-qr");
  });

  it("ON, degraded: the guided sentence for a refused serve — never a code", async () => {
    shell({
      hostState: { ...SERVING, state: "degraded", problem: "serve-refused" },
      tailscale: RUNNING,
      routes: LISTS,
    });
    await mount();
    expect(hostEl.textContent).toContain(hostCopy.guideServeRefused!);
    expect(hostEl.textContent).not.toContain("serve-refused");
    capture("6-on-degraded");
  });

  it("ON, the turn-off question: what stops, said before it is taken", async () => {
    shell({ hostState: SERVING, tailscale: RUNNING, routes: LISTS });
    await mount();
    await click(hostCopy.off!);
    expect(hostEl.textContent).toContain(hostCopy.offWhat!);
    capture("7-off-confirm");
  });
});
