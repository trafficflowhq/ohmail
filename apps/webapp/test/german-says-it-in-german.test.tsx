/** @vitest-environment jsdom */
/**
 * A GERMAN SCREEN SAYS IT IN GERMAN (tester A, round 20). Mounted under the app's own locale
 * shell, which hands the catalogue to the non-hook register the way a browser tab does:
 *
 *  · a sentence this client writes itself — "could not reach ohmail" when a request never got an
 *    answer — reads in German in Settings → Account and → About (R20-01);
 *  · the device a desktop paired without naming is shown in German, a name somebody typed is not
 *    touched; Settings' face row and About's version row carry German labels (R20-02).
 * English is the control in each case.
 */
import { WithReport } from "../../../packages/app/test/support/with-report.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { DEFAULT_LOCALE, fillFrom, setActiveCatalog } from "../app/shell/locale";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const GERMAN = fillFrom(en as never, de as never) as typeof en;

const HELLO = {
  product: "ohmail", flavor: "managed", apiVersion: "0.0.0", needsSetup: false,
  auth: { password: true, totp: true, webauthn: true, publicSignup: false },
  features: { sse: true, staging: true, ai: true, pairing: true },
};
const device = (id: string, kind: string, label: string, current = false) => ({
  id, kind, label, current, ip: "", pushToken: null,
  createdAt: "2026-09-01T09:00:00.000Z", lastSeenAt: "2026-09-20T09:00:00.000Z",
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => { document.cookie = "tf_owner=; path=/; max-age=0"; });

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  /* The register is module state; the next file in this worker must not inherit German. */
  setActiveCatalog(DEFAULT_LOCALE, null);
});

/** Every request fails the way a browser with no network fails: `fetch` itself throws. */
const offline = (): void => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
};

const answering = (devices: unknown[]): void => {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    const body = url.includes("/devices") ? { items: devices }
      : url.includes("/pair") || url.includes("/mailboxes") ? { items: [] }
      : HELLO;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
};

async function underTheShell(locale: "en" | "de", node: React.ReactElement): Promise<HTMLElement> {
  const { LocaleShell } = await import("../app/(product)/LocaleShell");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(LocaleShell, {
      initialLocale: locale, initialMessages: (locale === "de" ? GERMAN : en) as never,
      children: h(ThemeProvider, { storageKey: null, children: h(ToastHost, null, node) }),
    }));
  });
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
  return host;
}

describe("a request that got no answer is said in the reader's language (R20-01)", () => {
  it("Settings → Account, offline, in German", async () => {
    offline();
    const { AccountSection } = await import("../app/(product)/mailbox/AccountSection.js");
    const text = (await underTheShell("de", h(AccountSection))).textContent ?? "";
    expect(text).toContain(de.session.refusedOffline);
    expect(text).not.toContain(en.session.refusedOffline);
  });

  it("Settings → About, offline, in German", async () => {
    offline();
    const { AboutSection } = await import("../app/(product)/mailbox/AboutSection.js");
    const text = (await underTheShell("de", h(AboutSection))).textContent ?? "";
    expect(text).toContain(de.session.refusedOffline);
    expect(text).not.toContain(en.session.refusedOffline);
    expect(text).toContain("UID CHE\u2011");
  });

  it("control: in English the same panes say the English sentence", async () => {
    offline();
    const { AccountSection } = await import("../app/(product)/mailbox/AccountSection.js");
    expect((await underTheShell("en", h(AccountSection))).textContent).toContain(en.session.refusedOffline);
  });

  it("control: with no catalogue handed over yet, the client's own words are the catalogue's English", async () => {
    offline();
    const { AboutSection } = await import("../app/(product)/mailbox/AboutSection.js");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages: en, timeZone: "UTC", children: h(AboutSection) }));
    });
    for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain(en.session.refusedOffline);
  });
});

describe("ohmail's own names on German screens are German (R20-02)", () => {
  const ROWS = [
    device("me", "web", "", true),
    device("d1", "desktop-linux", "ohmail for Linux"),
    device("d2", "desktop-windows", "Arbeitsrechner"),
  ];

  it("Settings → Devices: an unnamed desktop is 'ohmail für Linux'; a typed name stays as typed", async () => {
    answering(ROWS);
    const { DevicesSection } = await import("../app/(product)/mailbox/DevicesSection.js");
    const text = (await underTheShell("de", h(WithReport, { view: DevicesSection }))).textContent ?? "";
    expect(text).toContain("ohmail für Linux");
    expect(text).not.toContain("ohmail for Linux");
    expect(text).toContain("Arbeitsrechner");
  });

  it("control: in English the unnamed desktop reads exactly as the server named it", async () => {
    answering(ROWS);
    const { DevicesSection } = await import("../app/(product)/mailbox/DevicesSection.js");
    expect((await underTheShell("en", h(WithReport, { view: DevicesSection }))).textContent).toContain("ohmail for Linux");
  });

  it("Settings → About: the version row is labelled in German", async () => {
    answering([]);
    const { AboutSection } = await import("../app/(product)/mailbox/AboutSection.js");
    const el = await underTheShell("de", h(AboutSection));
    const row = [...el.querySelectorAll<HTMLElement>('[role="group"]')].find(
      (group) => (group.querySelector(".oh-settingline-text")?.textContent ?? "").includes(" · "),
    );
    const labelId = row?.getAttribute("aria-labelledby");
    const label = labelId ? el.ownerDocument.getElementById(labelId)?.textContent : null;
    expect(label).toBe(de.about.buildLabel);
    expect(label).not.toBe(en.about.buildLabel);
  });
});
