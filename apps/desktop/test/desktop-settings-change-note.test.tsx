/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { waitFor, within } from "@testing-library/react";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { DesktopGate } from "../src/DesktopGate.js";
import { CLOUD_URL } from "../src/doors.js";
import { IntlProvider } from "use-intl";

import en from "../../webapp/messages/en.json";

/**
 * THE AWAY ROW, THE DORMANCY DIAL AND THE SIGNATURE EDITORS SAY A READER'S REFUSED CHANGE on the
 * desktop, over the wires both doors take: `awayOverBridge` (both), `consentOverBridge` (hosted)
 * and `consentOverBridgeStandalone`. A scripted engine answers as a reader's server does, and the
 * shared components render from what those wires carried.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  })) as never;

function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}
type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
const shellHost = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } };

const REFUSED = { state: "refused", holder: "work-laptop", refusal: "unreadable" };
const REFUSED_TEXT = en.settings.screening.refusedUnreadable.replace("{name}", "work-laptop");

const mailbox = {
  id: "mbx-1", address: ["reader", "example.invalid"].join("@"),
  status: "connected", organizerRole: "reader", organizerState: "held",
  initialImportCompletedAt: "2026-09-01T08:00:00.000Z",
};

let door: "hosted" | "standalone";
beforeEach(() => {
  door = "hosted";
  shellHost.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      if (command === "engine_status") return {
        state: "serving", mode: door === "hosted" ? "cloud" : "local",
        cloudUrl: door === "hosted" ? CLOUD_URL : undefined,
        address: mailbox.address, mailboxId: mailbox.id, credentialState: "ready",
      };
      if (command !== "engine_request") return null;
      const url = String(payload?.url ?? "");
      if (url === "/health") return encode(200, '{"signedIn":true}');
      if (url.startsWith("/mailboxes")) return encode(200, JSON.stringify({ items: [mailbox] }));
      if (url === "/away-responder") {
        return encode(200, JSON.stringify({
          enabled: false, body: "Back Monday.", startsAt: null, endsAt: null, audience: "screened_in",
          throttle: "per_day", piles: ["INBOX"], updatedAt: "2026-09-26T08:00:00.000Z", change: REFUSED,
        }));
      }
      if (url === "/consent") {
        return encode(200, JSON.stringify({
          seedConfirmedAt: "2026-09-01T08:00:00.000Z", screeningResetAt: null, dormancyDays: 90,
          signatures: {}, signaturesHtml: {}, signatureSources: {},
          dormancyChange: REFUSED, signatureChanges: { "mbx-1": REFUSED },
        }));
      }
      return encode(404, "{}");
    },
  };
});

let hostEl: HTMLDivElement;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  hostEl?.remove();
  delete shellHost.__TAURI_INTERNALS__;
  window.location.hash = "";
  vi.restoreAllMocks();
});
const settle = async (): Promise<void> => {
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
};
async function mount(node: React.ReactElement): Promise<void> {
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root!.render(h(IntlProvider, { locale: "en", messages: en as never, timeZone: "UTC", children: node }));
  });
  await settle();
}

async function pane(section: "away" | "screener" | "signatures") {
  const name = section === "signatures" ? en.settings.signatures.nav : en.settings[section];
  return within(hostEl).findByRole("region", { name });
}

async function mountSettings(section: "away" | "screener") {
  window.location.hash = `#/settings/${section}`;
  await mount(h(ThemeProvider, { children: h(ToastHost, { children: h(DesktopGate) }) }));
}

describe("the desktop's away row", () => {
  it("says the refusal the engine's read carries", async () => {
    await mountSettings("away");
    const away = await pane("away");
    await waitFor(() => expect(away.textContent, "the refusal reached no surface").toContain(REFUSED_TEXT));
  });
});

describe.each(["hosted", "standalone"] as const)("the %s door's dial and signature editors", (mode) => {
  it("say the refusals the consent read carries", async () => {
    door = mode;
    if (mode === "standalone") vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await mountSettings("screener");
    const screener = await pane("screener");
    await waitFor(() => expect(screener.textContent, "the dial's refusal reached no surface").toContain(REFUSED_TEXT));

    const menu = within(hostEl).getByRole("navigation", { name: en.settings.navAria });
    await act(async () => { within(menu).getByRole("button", { name: en.settings.signatures.nav }).click(); });
    const signatures = await pane("signatures");
    await waitFor(() => expect(signatures.textContent, "the signature's refusal reached no surface").toContain(REFUSED_TEXT));
  });
});
