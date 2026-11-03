/** @vitest-environment jsdom */
/**
 * ═══ SETTINGS → DEVICES — THE SELF-HOST ARM OF THE LINK ORIGIN RULE ═════════════════════════
 *
 * One flavor per process (the invites pair's split): the managed suite
 * (`settings-devices-pane.test.tsx`) pins the link's base to `https://api.ohmail.app`; this
 * file inlines the self-host flavor and pins the OTHER branch — the link's base is the PAGE
 * origin, because on the reference compose the Caddyfile routes `/hello`, `/pair*` and
 * `/auth*` at the root of the one origin to the api container, so the address the operator's
 * browser is on IS the address a scanning device can redeem against. A self-host QR minted on
 * `api.ohmail.app` would point a household's phone at the managed service — the wrong server,
 * with somebody else's sign-in — which is the failure this file makes unrepresentable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { decodeQr, matrixFromSvg } from "./fixtures/qr-decode";

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
// THE FLAVOR, before any module under test loads — the test-side twin of the build inlining it.
process.env.NEXT_PUBLIC_OHMAIL_FLAVOR = "selfhost";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = "invite-and-pair-link-fixture-token";

let originalFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url.includes("/api/pair")) {
      return new Response(JSON.stringify({
        id: "pt-9", token: TOKEN, grant: "device-pair", label: "", expiresAt: "2026-08-20T09:05:00.000Z",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/api/devices") || url.includes("/api/pair")) {
      return new Response(JSON.stringify({ items: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe("the self-host devices pane mints on the page origin", () => {
  it("the QR and the typed-entry line both carry `${window.location.origin}/pair#<token>`", async () => {
    const { DevicesSection } = await import("../app/(product)/mailbox/DevicesSection.js");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        h(NextIntlClientProvider, {
          locale: "en", messages, timeZone: "UTC",
          children: h(ThemeProvider, null, h(ToastHost, null, h(DevicesSection))),
        }),
      );
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const add = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add a device");
    expect(add, "the add-a-device verb").toBeTruthy();
    await click(add!);

    const link = `${window.location.origin}/pair#${TOKEN}`;
    const svg = host.querySelector<SVGSVGElement>(".join-qr svg");
    expect(svg, "the QR rendered").toBeTruthy();
    expect(decodeQr(matrixFromSvg(svg!))).toBe(link);
    expect(host.querySelector('[data-testid="pair-link"]')!.textContent).toBe(link);
  });
});
