/** @vitest-environment jsdom */
import { describe, expect, it, afterEach } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FirstRun } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import { FocusFollows } from "../app/shell/focus-follows";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import type { OnboardingFacts, OnboardingMailbox } from "@ohmail/app-logic/doors/onboarding";

/**
 * ═══ ↵ DOES WHAT THE ↵ BADGE SAYS, ON SETUP'S LAST STEP ════════════════════════════════════
 *
 * "Just read it here" → Continue reaches "What this computer does". Continue was the focused
 * control and the step took it away, so the shell's focus rule landed in the card at its first
 * control — "Start over", the summary having no Cancel — and ↵ asked to start setup over while
 * "Open ohmail" wore the ↵ badge. Mounted with the shell's `FocusFollows`, as the app mounts it.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const t = messages.onboarding;

const PEEKED: OnboardingMailbox = {
  organizerRole: "reader",
  organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
  organizerState: "held",
  organizeConsentedAt: null,
  initialImportCompletedAt: null,
};

const facts: OnboardingFacts = {
  door: "local",
  mailbox: PEEKED,
  account: { onboardingCompletedAt: null },
  ai: "unset",
  queuedSenders: 0,
};

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => { for (const r of roots.splice(0)) r.unmount(); });
  document.body.innerHTML = "";
});

const flush = async (): Promise<void> => {
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
};

async function mount(): Promise<{ el: HTMLElement; completed: () => number }> {
  let completes = 0;
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  const host: FirstRunHost = {
    door: "local",
    ai: facts.ai,
    probe: async () => ({ host: "h", user: "u", folders: 1 }),
    connect: async () => ({ id: "mb-1" }),
    organize: async () => "stored",
    complete: async () => { completes += 1; },
    setAiEnabled: async () => { /* answered */ },
    probeReason: () => null,
    probeMessage: () => null,
  };
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(KeymapProvider, {
        children: [
          h(FocusFollows, { key: "ff" }),
          h(FirstRun, {
            key: "fr", host, facts, onRefresh: () => {}, onLeave: () => {},
            pull: { screened: 0, history: 0, pulled: 0 }, decide: null,
            mailboxId: "mb-1", organizedSince: "30 Aug 2026",
          }),
        ],
      }),
    }));
  });
  return { el, completed: () => completes };
}

/** ↵ as a browser delivers it: keydown at the focused element, then a focused button's activation. */
async function enter(): Promise<void> {
  await act(async () => {
    const at = (document.activeElement as HTMLElement | null) ?? document.body;
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    at.dispatchEvent(ev);
    if (!ev.defaultPrevented && at instanceof HTMLButtonElement) at.click();
  });
  await flush();
}

const button = (el: HTMLElement, label: string): HTMLButtonElement => {
  const b = [...el.querySelectorAll("button")].find((x) => (x.textContent ?? "").trim().startsWith(label));
  if (!b) throw new Error(`no button ${label}`);
  return b;
};
const heading = (el: HTMLElement): string => (el.querySelector("h1")?.textContent ?? "").trim();

async function toSummary(): Promise<{ el: HTMLElement; completed: () => number }> {
  const s = await mount();
  const read = [...s.el.querySelectorAll<HTMLInputElement>("input[type=radio]")].find((i) => i.value === "read");
  await act(async () => { read!.click(); });
  await act(async () => { button(s.el, t.continue).focus(); });
  await enter();
  expect(heading(s.el), "Continue did not reach the summary").toBe(t.doneReaderTitle);
  return s;
}

describe("↵ on setup's last step does what its badge says", () => {
  it("Continue by ↵, then ↵ on the summary: ohmail opens, setup does not start over", async () => {
    const s = await toSummary();
    const focused = document.activeElement as HTMLElement | null;
    expect(focused?.textContent?.trim().startsWith(t.restart), "focus landed on Start over").toBe(false);
    await enter();
    expect(s.el.textContent, "↵ asked to start setup over").not.toContain(t.restartWhat);
    expect(s.completed(), "↵ on the summary did not open ohmail").toBe(1);
  });

  it("control: Start over focused by the person still asks to start over on ↵", async () => {
    const s = await toSummary();
    await act(async () => { button(s.el, t.restart).focus(); });
    await enter();
    expect(s.completed(), "↵ on a Start over the person chose opened ohmail").toBe(0);
    expect(heading(s.el), "the restart question replaced nothing").toBe(t.doneReaderTitle);
  });
});
