/** @vitest-environment jsdom */
/**
 * THE MAILBOX STEP HAS WAYS OUT. It used to end only in a connected mailbox, so somebody without the
 * right password could only close the tab. "Do this later" opens the app with the setup marked as
 * offered (`/?setup=later`), and on ohmail Cloud "or write to us" opens a mail to support whose subject
 * carries the provider picked and the last refusal's code, never anything typed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { launchRefused } from "@trafficflow/services/mail";
import { mailboxProbes } from "./join-mailbox-probes.js";

const FULL = {
  user: {
    userId: "u1", accountId: "a1", email: "pat@family.example", displayName: "Pat", emailVerified: true,
    twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true },
  },
  scope: "full",
};

let unmount: (() => Promise<void>) | null = null;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/auth/session")) return json(200, FULL);
    if (url.includes("/oauth/microsoft/availability")) return json(200, { available: false, device: false });
    if (url.includes("/mailboxes") && method === "POST") {
      const r = launchRefused("auth", false) as unknown as { httpStatus: number; code: string; message: string; details: unknown };
      return json(r.httpStatus, { error: { code: r.code, message: r.message, details: r.details } });
    }
    if (url.includes("/mailboxes")) return json(200, { items: [] });
    return json(200, {});
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (unmount) await unmount();
  unmount = null;
  globalThis.fetch = originalFetch;
  delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
  vi.restoreAllMocks();
});

async function atTheMailboxStep(flavor: "managed" | "selfhost") {
  vi.resetModules();
  process.env.NEXT_PUBLIC_API_BASE = "/api";
  if (flavor === "selfhost") process.env.NEXT_PUBLIC_OHMAIL_FLAVOR = "selfhost";
  else delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { NextIntlClientProvider } = await import("next-intl");
  const { JoinRoute: JoinScreen } = await import("../app/(product)/join/JoinRoute.js");
  (globalThis as unknown as { React: unknown }).React = React;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(NextIntlClientProvider, {
      locale: "en", messages: en, timeZone: "UTC",
      children: React.createElement(JoinScreen, { initialCode: "", publicSignup: true }),
    }));
  });
  await settle();
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  expect(host.querySelector("h1")?.textContent?.trim()).toBe(en.onboarding.providerFirst);
  /* The step is the one connect form: its two ways out are presses, and where each leads is where the browser is sent. */
  const probes = mailboxProbes(host, en, act);
  /** Where a press of this exit sends the browser, or `null` where the exit is not offered. */
  const leadsTo = async (label: string): Promise<string | null> => {
    const exit = probes.button(label);
    if (exit === null) return null;
    const real = window.location;
    let went: string | null = null;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { get href() { return document.URL; }, assign: (url: string) => { went = url; } },
    });
    try {
      await act(async () => { exit.click(); });
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: real });
    }
    return went;
  };
  const subject = async (): Promise<string | null> => {
    const href = await leadsTo(en.join.mailboxWriteUs);
    if (href === null) return null;
    expect(href.startsWith("mailto:support@ohmail.app?subject=")).toBe(true);
    return decodeURIComponent(href.slice("mailto:support@ohmail.app?subject=".length));
  };
  const refusedGmail = async () => {
    await probes.choose("Gmail");
    await probes.type("join-mb-address", "pat@gmail.test");
    await probes.type("join-mb-pass", "the-google-password");
    await act(async () => { probes.button(en.join.connectMailbox)!.click(); });
    await settle();
  };
  return { host, probes, leadsTo, subject, refusedGmail };
}

const subjectFor = (preset: string, reason: string) =>
  en.join.mailboxHelpSubject.replace("{preset}", preset).replace("{reason}", reason);

describe("the mailbox step's exits", () => {
  it("the form stands in the door's stage, the new design's own: no root of today's design stands around its tiles", async () => {
    const ui = await atTheMailboxStep("managed");
    const tile = ui.probes.tiles()[0] ?? null;
    expect(tile, "no provider tile").not.toBeNull();
    expect(tile!.closest(".oh-root"), "the form stands outside the door's stage").not.toBeNull();
    expect(tile!.closest(".today"), "a root of today's design stands around the form").toBeNull();
    expect(ui.host.querySelector(".today"), "a root of today's design on the page").toBeNull();
  });

  it("Do this later opens the app with the setup marked as offered", async () => {
    const ui = await atTheMailboxStep("managed");
    expect(await ui.leadsTo(en.onboarding.providerLater)).toBe("/?setup=later");
  });

  it("on ohmail Cloud, a mail to support names the provider and the refusal's code, nothing typed", async () => {
    const ui = await atTheMailboxStep("managed");
    expect(await ui.subject()).toBe(subjectFor("none", "none"));

    await ui.refusedGmail();
    expect(ui.probes.alerts(), "the refusal is on screen").toHaveLength(1);
    expect(await ui.subject()).toBe(subjectFor("gmail", "auth"));
    const href = (await ui.leadsTo(en.join.mailboxWriteUs))!;
    expect(href).not.toContain("gmail.test");
    expect(href.split("@")).toHaveLength(2);
  });

  it("a self-hosted server has no ohmail support to write to, so that exit is not offered", async () => {
    const ui = await atTheMailboxStep("selfhost");
    expect(await ui.leadsTo(en.onboarding.providerLater)).toBe("/?setup=later");
    expect(ui.probes.button(en.join.mailboxWriteUs)).toBeNull();
    expect(ui.host.querySelector('a[href^="mailto:"]')).toBeNull();
  });
});
