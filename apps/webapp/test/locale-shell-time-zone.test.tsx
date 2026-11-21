/** @vitest-environment jsdom */
import { WithReport } from "../../../packages/app/test/support/with-report.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";

/**
 * THE PROVIDER STATES A TIME ZONE, SO FORMATTING A DATE IS NOT AN ERROR.
 *
 * `useFormatter().dateTime` under a provider with no `timeZone` throws `IntlError
 * ENVIRONMENT_FALLBACK` — caught by next-intl, which then formats in the environment's zone. The
 * dates were right and the cost was one thrown-and-caught error per date per render: Settings →
 * Devices formats two per row. Every other harness in this suite passes `timeZone: "UTC"` by hand,
 * which is why no test ever saw it; this one mounts the REAL shell.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

/** Two rows, each carrying the two dates the pane formats — added and last seen. */
const ROWS = [
  {
    id: "dev-1", kind: "web", label: "Web", createdAt: "2026-08-01T09:00:00.000Z",
    lastSeenAt: "2026-08-20T09:00:00.000Z", ip: "", current: true, pushToken: null,
  },
  {
    id: "dev-2", kind: "desktop-linux", label: "Desk", createdAt: "2026-08-10T09:00:00.000Z",
    lastSeenAt: "2026-08-19T09:00:00.000Z", ip: "", current: false, pushToken: null,
  },
];

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let originalFetch: typeof globalThis.fetch;
let errors: string[] = [];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
  });
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    const body = url.includes("/devices") ? { items: ROWS }
      : url.includes("/pair") ? { items: [] }
      : { product: "ohmail", flavor: "managed", apiVersion: "0.0.0", needsSetup: false,
          auth: { password: true, totp: true, webauthn: true, publicSignup: false },
          features: { sse: true, staging: true, ai: true, pairing: true } };
    return new Response(JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json" },
    });
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

async function mountUnderTheRealShell(): Promise<HTMLElement> {
  const { LocaleShell } = await import("../app/(product)/LocaleShell");
  const { DevicesSection } = await import("../app/(product)/mailbox/DevicesSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(LocaleShell, {
      initialLocale: "en", initialMessages: messages,
      children: h(ThemeProvider, null, h(ToastHost, null, h(WithReport, { view: DevicesSection }))),
    }));
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return host;
}

const intlErrors = (): string[] =>
  errors.filter((e) => e.includes("ENVIRONMENT_FALLBACK") || e.includes("IntlError"));

describe("dates under the app's own locale provider", () => {
  it("renders the dated rows — otherwise a count of zero errors is a count of nothing", async () => {
    const el = await mountUnderTheRealShell();
    // The positive control this case exists to carry: the pane really did format dates.
    const rows = el.querySelectorAll('.oh-settingline[role="group"]');
    expect(rows.length, "no device row rendered").toBeGreaterThanOrEqual(2);
    // Both rows carry a formatted year, so a later count of zero errors is a count of something.
    expect((el.textContent ?? "").match(/2026/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("formats them without a single thrown IntlError", async () => {
    await mountUnderTheRealShell();
    expect(
      intlErrors(),
      "the provider states no time zone, so every formatted date throws and is caught",
    ).toEqual([]);
  });
});
