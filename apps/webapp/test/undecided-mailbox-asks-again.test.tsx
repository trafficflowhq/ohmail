/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { NOW, S, act, consentTransport, engineOver, setup, storeWith, teardown, waitFor } from "./_view-shell";
import type { MailboxFacts } from "../app/shell/mail-state";
import type { FirstRunHost } from "../app/shell/first-run-host";

/**
 * AN UNDECIDED MAILBOX ASKS AGAIN (FIRST-RUN-STAGE-NEVER-REOPENS-ON-AN-UNDECIDED-MAILBOX) — the whole
 * shell over a memory mirror. While a mailbox has no consent and no live holder, the organize decision
 * opens once per launch; behind it the shell is inert and its keys do nothing, so `g s` (measured on
 * the rig: it unmounted the stage for good) cannot dismiss it. Controls: a decided mailbox never opens
 * it, and a second close in one launch is final. The last case is K109's wiring row
 * (NOT-ORGANIZING-YET-SHELL-WIRING-HAS-NO-TEST): the shell itself hands both views the fact.
 */

const h = React.createElement;
const t = messages.onboarding;

const UNDECIDED: MailboxFacts = {
  id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-09-16T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  organizerRole: "reader", organizedBy: null, organizerState: null, organizeConsentedAt: null,
} as MailboxFacts;
const DECIDED: MailboxFacts = {
  ...UNDECIDED, organizerRole: "organizer", organizeConsentedAt: "2026-09-01T00:00:00.000Z",
} as MailboxFacts;

const host = (): FirstRunHost => ({
  door: "selfhost", ai: "off",
  probe: async () => ({ host: "h", user: "u", folders: 1 }),
  connect: async () => ({ id: "mb1" }),
  organize: async () => "stored",
  complete: async () => { /* stamped */ },
  probeReason: () => null,
  probeMessage: () => null,
});

async function launch(roster: MailboxFacts[], hash: string, withStage = true, consent = consentTransport): Promise<HTMLElement> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const s = await storeWith([]);
  const engine = engineOver(s);
  S.store = s; S.engine = engine;
  window.location.hash = hash;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  S.roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, { children: h(ToastHost, {
        children: h(AppShell as never, {
          demo: false, engine, consentTransport: consent, mailboxFacts: async () => roster,
          ...(withStage ? { firstRun: host() } : {}),
        } as never),
      }) }),
    }));
  });
  return container;
}

const stageHeading = (): string => (document.querySelector(".ob-stage h1")?.textContent ?? "").trim();
const settle = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
};
const key = async (k: string): Promise<void> => {
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
};

beforeEach(async () => {
  setup();
  const { resetDecisionAskedForTests } = await import("../app/shell/decision-reopen.js");
  resetDecisionAskedForTests();
});
afterEach(teardown);

describe("an undecided mailbox asks the organize decision again", () => {
  it("opens it at launch, over an inert shell", async () => {
    const el = await launch([UNDECIDED], "#/ohbox");
    await waitFor(() => window.location.hash.startsWith("#/first-run"), "the decision to open at launch");
    await waitFor(() => stageHeading() === t.consentTitle, "the consent statement on the stage");
    expect(window.location.hash).toContain("mailbox=mb1");
    expect(el.querySelector(".shell")?.hasAttribute("inert")).toBe(true);
  });

  it("a key behind it does not dismiss it: `g s` stays on the stage", async () => {
    await launch([UNDECIDED], "#/ohbox");
    await waitFor(() => stageHeading() === t.consentTitle, "the stage");
    await key("g");
    await key("s");
    await settle();
    expect(window.location.hash.startsWith("#/first-run")).toBe(true);
    expect(stageHeading()).toBe(t.consentTitle);
  });

  it("once per launch: closed, it does not come back until the next launch", async () => {
    await launch([UNDECIDED], "#/ohbox");
    await waitFor(() => stageHeading() === t.consentTitle, "the stage");
    await act(async () => {
      window.location.hash = "#/screener";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await settle(40);
    expect(window.location.hash).toBe("#/screener");
    expect(stageHeading()).toBe("");
    // The next launch asks again.
    await teardown();
    setup();
    const { resetDecisionAskedForTests } = await import("../app/shell/decision-reopen.js");
    resetDecisionAskedForTests();
    await launch([UNDECIDED], "#/screener");
    await waitFor(() => stageHeading() === t.consentTitle, "the stage at the next launch");
  });

  /* A connect on a finished install (Remove, then the same mailbox again) opens a plain run, which
     has nothing to draw and hands the route back; the decision must still be asked in this launch. */
  it("a plain run on a finished install that draws nothing still leads to the decision", async () => {
    const finished = { ...consentTransport, state: async () => ({
      ...(await consentTransport.state()), onboardingCompletedAt: "2026-09-02T00:00:00.000Z" }) };
    await launch([UNDECIDED], "#/first-run?mailbox=mb1", true, finished as typeof consentTransport);
    await waitFor(() => window.location.hash.startsWith("#/first-run/again"), "the decision as a re-run");
    await waitFor(() => stageHeading() === t.consentTitle, "the consent statement on the stage");
    expect(window.location.hash).toContain("mailbox=mb1");
  });

  it("CONTROL — a decided mailbox never opens it", async () => {
    const el = await launch([DECIDED], "#/ohbox");
    await settle(60);
    expect(window.location.hash).toBe("#/ohbox");
    expect(stageHeading()).toBe("");
    expect(el.querySelector(".shell")?.hasAttribute("inert")).toBe(false);
  });

  it("the shell hands the Screener and the Ohbox the not-organizing fact (K109's wiring)", async () => {
    const el = await launch([UNDECIDED], "#/screener", false);
    await waitFor(() => (el.textContent ?? "").includes("ohmail is not organizing this mailbox yet."),
      "the Screener saying nothing organizes the mailbox");
    await act(async () => {
      window.location.hash = "#/ohbox";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => (el.textContent ?? "").includes("Not organizing yet"),
      "the Ohbox doorbell saying so");
  });
});
