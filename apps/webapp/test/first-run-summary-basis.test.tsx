/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FirstRun } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import type { OnboardingFacts } from "@ohmail/app-logic/doors/onboarding";

/**
 * "What ohmail did" stated the device's projection as what ohmail did.
 *
 * A self-hosted install over a large mailbox with a 365-day window: setup's last step read
 * two counts, "N messages screened" and "M listed under History", summing to the
 * browser window's ceiling — and not what the server had screened or lists under History.
 * The pull screen says its counters count this device; this step said nothing. No server count of
 * either exists on this base, so the step says the same thing, unless the store has said the device
 * holds the whole mailbox, when the pair is the mailbox's.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/** Consented, imported, nobody waiting — `deriveOnboardingStep` row 9, "summary". */
const done: OnboardingFacts = {
  door: "cloud",
  mailbox: {
    organizerRole: "organizer",
    organizedBy: null,
    organizerState: null,
    organizeConsentedAt: "2026-09-27T01:53:12.000Z",
    initialImportCompletedAt: "2026-09-27T02:20:00.000Z",
  },
  account: { onboardingCompletedAt: null },
  ai: "off",
  queuedSenders: 0,
};

const roots: Root[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.unmount();
  document.body.innerHTML = "";
});

async function mountSummary(whole: boolean | undefined): Promise<HTMLElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  const host: FirstRunHost = {
    door: "cloud",
    ai: "off",
    probe: async () => ({ host: "h", user: "u", folders: 1 }),
    connect: async () => ({ id: "mb-1" }),
    organize: async () => "stored",
    complete: async () => {},
    setAiEnabled: async () => {},
    probeReason: () => null,
    probeMessage: () => null,
  };
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(KeymapProvider, {
        children: h(FirstRun, {
          host,
          facts: done,
          onRefresh: () => {},
          onLeave: () => {},
          // The window's pair: it sums to the ceiling while the mailbox holds seven times that.
          pull: { screened: 6_012, history: 3_988, pulled: 74_004, ...(whole === undefined ? {} : { whole }) },
          serverMessageCount: 74_004,
          decide: null,
          mailboxId: "mb-1",
        }),
      }),
    }));
  });
  return el;
}

const textOf = (el: HTMLElement): string => (el.textContent ?? "").replace(/\s+/g, " ");

describe("the summary's counts name their basis", () => {
  it("over a store past the window, the step says it counts this device", async () => {
    const el = await mountSummary(false);
    expect(textOf(el), "the screen under test").toContain(messages.onboarding.doneTitle);
    expect(textOf(el)).toContain("6,012" + " messages screened");
    // MUTATION: render the basis line unconditionally-off — the device's pair reads as the mailbox's.
    expect(el.querySelector(".ob-basis")?.textContent, "the summary states a window projection as what ohmail did")
      .toBe(messages.onboarding.counterBasis);
  });

  it("a host that states nothing about the store reads as this device, never as the mailbox", async () => {
    const el = await mountSummary(undefined);
    expect(el.querySelector(".ob-basis")?.textContent).toBe(messages.onboarding.counterBasis);
  });

  it("when the store has said the device holds everything, the pair is the mailbox's and says no basis", async () => {
    const el = await mountSummary(true);
    expect(textOf(el)).toContain("6,012" + " messages screened");
    expect(el.querySelector(".ob-basis")).toBeNull();
  });
});
