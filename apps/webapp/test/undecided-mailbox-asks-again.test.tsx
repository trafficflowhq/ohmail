/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { NOW, S, act, consentTransport, engineOver, setup, storeWith, teardown, waitFor } from "./_view-shell";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import { resetDecisionAskedForTests } from "@ohmail/app-logic/mailboxes/first-run/decision-asked";

/**
 * AN UNDECIDED MAILBOX ASKS AGAIN (FIRST-RUN-STAGE-NEVER-REOPENS-ON-AN-UNDECIDED-MAILBOX) — the whole
 * shell over a memory mirror. While a mailbox has no consent and no live holder, the organize decision
 * opens once per launch; behind it the shell is inert and its keys do nothing, so `g s` (measured on
 * the rig: it unmounted the stage for good) cannot dismiss it. Controls: a decided mailbox never opens
 * it, and a second close in one launch is final. The last case is K109's wiring row
 * (NOT-ORGANIZING-YET-SHELL-WIRING-HAS-NO-TEST): the shell itself hands both views the fact.
 *
 * RE-POINTED (the switch's older tests, sorted once): the shell is the one the hosts mount, through the tests' door
 * (`_mail-shell.tsx`: the frame over the mail ground, whose `first-run-owed.ts` asks the question once per launch);
 * the launch's mark is the first run's own (`@ohmail/app-logic/mailboxes/first-run/decision-asked`). The stage is the
 * frame's modal dialog and its heading is its level-1 sentence; the shell behind it is inert when the app's
 * navigation stands inside an inert part; Close setup is a button by its name; a key is pressed at the focused control. Every expectation is as it stood.
 * The Screener cases use the registered place to check the route and the mailbox's organizing status.
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

/* The server's completion stamp: `complete` writes it, the next consent read returns it. */
const server = { completedAt: null as string | null };
const stampedConsent = { ...consentTransport, state: async () => ({
  ...(await consentTransport.state()), onboardingCompletedAt: server.completedAt }) };

const host = (): FirstRunHost => ({
  door: "selfhost", ai: "off",
  probe: async () => ({ host: "h", user: "u", folders: 1 }),
  connect: async () => ({ id: "mb1" }),
  organize: async () => "stored",
  complete: async () => { server.completedAt = "2026-09-16T09:00:00.000Z"; },
  probeReason: () => null,
  probeMessage: () => null,
});

async function launch(roster: MailboxFacts[], hash: string, withStage = true, consent = consentTransport): Promise<HTMLElement> {
  const { MailShell } = await import("./_mail-shell.js");
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
        children: h(MailShell as never, {
          demo: false, engine, consentTransport: consent, mailboxFacts: async () => roster,
          ...(withStage ? { firstRun: host() } : {}),
        } as never),
      }) }),
    }));
  });
  return container;
}

const organizeHeading = t.organizeLast.replace("<window></window>.", t.windowYear);
const stageHeading = (): string =>
  (document.querySelector("[role=dialog][aria-modal=true] h1")?.textContent ?? "").trim();
/** The app's own navigation stands in an inert part: nothing behind the stage takes a press or a key. */
const appInert = (el: HTMLElement): boolean | undefined => {
  const nav = [...el.querySelectorAll("nav")].find((n) => n.closest("[role=dialog]") === null);
  return nav === undefined ? undefined : nav.closest("[inert]") !== null;
};
const settle = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
};
/** A key as a person presses it: at the focused control, heard on its way up (the stage hears Escape there). */
const key = async (k: string): Promise<void> => {
  const at: EventTarget = document.activeElement ?? document;
  await act(async () => { at.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
};

beforeEach(() => {
  setup();
  server.completedAt = null;
  resetDecisionAskedForTests();
});
afterEach(teardown);

describe("an undecided mailbox asks the organize decision again", () => {

  it("a key behind it does not dismiss it: `g s` stays on the stage", async () => {
    await launch([UNDECIDED], "#/ohbox");
    await waitFor(() => stageHeading() === organizeHeading, "the stage");
    await key("g");
    await key("s");
    await settle();
    expect(window.location.hash.startsWith("#/first-run")).toBe(true);
    expect(stageHeading()).toBe(organizeHeading);
  });

  it("once per launch: closed, it does not come back until the next launch", async () => {
    await launch([UNDECIDED], "#/ohbox");
    await waitFor(() => stageHeading() === organizeHeading, "the stage");
    await act(async () => {
      window.location.hash = "#/screener";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await settle(40);
    expect(window.location.hash).toBe("#/screener");
    expect(stageHeading()).toBe("");

    await teardown();
    setup();
    resetDecisionAskedForTests();
    await launch([UNDECIDED], "#/screener");
    await waitFor(() => stageHeading() === organizeHeading, "the stage at the next launch");
  });

  /* Close setup says the app opens as it is and setup runs again from Settings. The server's stamp
     keeps that, so a load in another browser, door or device (nothing in its storage) agrees. */
  it("Close setup stays closed: a later load anywhere opens the app, a mailbox added after it is still asked", async () => {
    await launch([UNDECIDED], "#/ohbox", true, stampedConsent as typeof consentTransport);
    await waitFor(() => stageHeading() === organizeHeading, "the stage");
    await key("Escape");
    /* A button's name is its words; the key hint beside them is drawn in a `kbd` of its own. */
    const close = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => [...b.childNodes].filter((c) => c.nodeName !== "KBD").map((c) => c.textContent ?? "").join("").trim() === t.cancelConfirm);
    await act(async () => { close!.click(); });
    await waitFor(() => window.location.hash === "#/ohbox", "Close setup to open the app");
    const elsewhere = async (roster: MailboxFacts[]): Promise<void> => {
      await teardown();
      setup();
      window.localStorage.clear();
      resetDecisionAskedForTests();
      await launch(roster, "#/ohbox", true, stampedConsent as typeof consentTransport);
    };
    await elsewhere([UNDECIDED]);
    await settle(60);
    expect(window.location.hash).toBe("#/ohbox");
    expect(stageHeading()).toBe("");
    await elsewhere([UNDECIDED, { ...UNDECIDED, id: "mb2", address: "two@example.invalid", createdAt: "2026-09-16T10:00:00.000Z" }]);
    await waitFor(() => stageHeading() === organizeHeading, "the stage for the mailbox added after Close setup");
    expect(window.location.hash).toContain("mailbox=mb2");
  });

  /* The boot cache marks consent known before the live read, with no completion stamp in it. */
  it("the boot cache's consent is not the stamp: nothing opens before the live read", async () => {
    const { bootCacheKey } = await import("@ohmail/app-logic/session/boot-cache");
    const { CONSENT_BOOT_SCOPE } = await import("@ohmail/app-logic/consent/consent-state");
    document.cookie = "tf_owner=acct_cached";
    window.localStorage.setItem(bootCacheKey(CONSENT_BOOT_SCOPE, "acct_cached"),
      JSON.stringify({ v: 1, seedConfirmedAt: "2026-09-01T00:00:00.000Z", dormancyDays: 90, screeningBaselineAt: null }));
    const pending = { ...consentTransport, state: () => new Promise<never>(() => {}) };
    try {
      await launch([UNDECIDED], "#/ohbox", true, pending as unknown as typeof consentTransport);
      await settle(60);
      expect(window.location.hash).toBe("#/ohbox");
    } finally {
      document.cookie = "tf_owner=; max-age=0";
    }
  });

  /* A connect on a finished install (Remove, then the same mailbox again: a new row, newer than the
     stamp) opens a plain run, which has nothing to draw and hands the route back; the decision must
     still be asked in this launch. */
  it("a plain run on a finished install that draws nothing still leads to the decision", async () => {
    const finished = { ...consentTransport, state: async () => ({
      ...(await consentTransport.state()), onboardingCompletedAt: "2026-09-02T00:00:00.000Z" }) };
    const readded = { ...UNDECIDED, createdAt: "2026-09-03T00:00:00.000Z" };
    await launch([readded], "#/first-run?mailbox=mb1", true, finished as typeof consentTransport);
    await waitFor(() => window.location.hash.startsWith("#/first-run/again"), "the decision as a re-run");
    await waitFor(() => stageHeading() === organizeHeading, "the consent statement on the stage");
    expect(window.location.hash).toContain("mailbox=mb1");
  });

  it("the shell hands the Screener and the Ohbox the not-organizing fact (K109's wiring)", async () => {
    const el = await launch([UNDECIDED], "#/screener", false);
    await waitFor(() => (el.textContent ?? "").includes("Not organizing yet")
      && (el.textContent ?? "").includes("New senders go straight to the Ohbox."),
      "the Screener explaining that new senders go straight to the Ohbox");
    await act(async () => {
      window.location.hash = "#/ohbox";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => (el.textContent ?? "").includes("Not organizing yet"),
      "the Ohbox doorbell saying so");
  });

  it("opens it at launch, over an inert shell", async () => {
    const el = await launch([UNDECIDED], "#/ohbox");
    await waitFor(() => window.location.hash.startsWith("#/first-run"), "the decision to open at launch");
    await waitFor(() => stageHeading() === organizeHeading, "the consent statement on the stage");
    expect(window.location.hash).toContain("mailbox=mb1");
    expect(appInert(el)).toBe(true);
  });

  it("CONTROL — a decided mailbox never opens it", async () => {
    const el = await launch([DECIDED], "#/ohbox");
    await settle(60);
    expect(window.location.hash).toBe("#/ohbox");
    expect(stageHeading()).toBe("");
    expect(appInert(el)).toBe(false);
  });
});
