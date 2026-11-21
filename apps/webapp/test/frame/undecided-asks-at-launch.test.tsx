/** @vitest-environment jsdom */
/**
 * A MAILBOX NOBODY DECIDED ABOUT ASKS THE ORGANIZE QUESTION AT LAUNCH, over the shell the hosts mount (the frame over
 * the mail ground; the tests' door `_mail-shell.tsx`): the first run's decision stands over the app for that mailbox,
 * once per launch and account; a decided mailbox asks nothing. The stage is found by its heading.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { resetDecisionAskedForTests } from "@ohmail/app-logic/mailboxes/first-run/decision-asked";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import messages from "../../messages/en.json";
import { NOW, S, act, consentTransport, engineOver, setup, storeWith, teardown, waitFor } from "../_view-shell";

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

const firstRun = (): FirstRunHost => ({
  door: "selfhost", ai: "off",
  probe: async () => ({ host: "h", user: "u", folders: 1 }),
  connect: async () => ({ id: "mb1" }),
  organize: async () => "stored",
  complete: async () => undefined,
  probeReason: () => null,
  probeMessage: () => null,
});

async function launch(roster: MailboxFacts[], hash: string): Promise<void> {
  const { MailShell } = await import("../_mail-shell");
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
          demo: false, engine, consentTransport, mailboxFacts: async () => roster, firstRun: firstRun(),
        } as never),
      }) }),
    }));
  });
}

const theQuestion = (): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>("h1, h2, [role=heading]")].find((el) => el.textContent?.trim() === t.consentTitle) ?? null;
const settle = async (n = 40): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
};

beforeEach(() => {
  setup();
  resetDecisionAskedForTests();
});
afterEach(teardown);

describe("an undecided mailbox, at launch over the new shell", () => {
  it("asks the organize question for that mailbox at launch", async () => {
    await launch([UNDECIDED], "#/ohbox");
    await waitFor(() => theQuestion() !== null, "the organize question at launch");
    expect(window.location.hash).toContain("mailbox=mb1");
  });

  it("asks once per launch: walked away, it does not come back; the next launch asks again", async () => {
    await launch([UNDECIDED], "#/ohbox");
    await waitFor(() => theQuestion() !== null, "the organize question at launch");
    await act(async () => {
      window.location.hash = "#/ohbox";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await settle();
    expect(theQuestion()).toBeNull();
    await teardown();
    setup();
    resetDecisionAskedForTests();
    await launch([UNDECIDED], "#/ohbox");
    await waitFor(() => theQuestion() !== null, "the organize question at the next launch");
  });

  it("CONTROL: a decided mailbox asks nothing", async () => {
    await launch([DECIDED], "#/ohbox");
    await settle(60);
    expect(theQuestion()).toBeNull();
    expect(window.location.hash).toBe("#/ohbox");
  });
});
