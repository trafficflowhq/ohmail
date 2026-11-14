/** @vitest-environment jsdom */
import { describe, expect, it, afterEach } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FirstRun } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import type { OnboardingFacts } from "@ohmail/app-logic/doors/onboarding";

/**
 * SETUP OFFERS AI ONLY WHERE A MODEL CAN ANSWER.
 *
 * A self-hosted server with no model (`/hello` features.ai = false) was offered "Yes — Runs on this
 * server with the operator's Anthropic key", the press switched AI on, and every Suggest then
 * answered 503. The self-host door now offers "Yes" only when the server says it has a model; with
 * none, the step says so and the answer it stores is "no". Cloud and the desktop are unchanged.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const t = messages.onboarding;

/** A re-run of setup on an organized mailbox whose account switch rests ON, the default. */
const facts = (door: "cloud" | "selfhost"): OnboardingFacts => ({
  door,
  mailbox: {
    organizerRole: "organizer", organizedBy: null, organizerState: null,
    organizeConsentedAt: "2026-03-01T10:00:00.000Z", initialImportCompletedAt: "2026-03-01T11:00:00.000Z",
  },
  account: { onboardingCompletedAt: "2026-03-01T11:30:00.000Z" },
  ai: "on",
  queuedSenders: 0,
} as OnboardingFacts);

const roots: Root[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.unmount();
  document.body.innerHTML = "";
});

async function atTheAiStep(door: "cloud" | "selfhost", selfhostAi?: boolean) {
  const writes: boolean[] = [];
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  const host: FirstRunHost = {
    door,
    ai: "on",
    probe: async () => ({ host: "h", user: "u", folders: 1 }),
    connect: async () => ({ id: "mb-1" }),
    organize: async () => "stored",
    complete: async () => { /* leaves */ },
    setAiEnabled: async (on: boolean) => { writes.push(on); },
    probeReason: () => null,
    probeMessage: () => null,
    ...(selfhostAi === undefined ? {} : { selfhostAi }),
  } as FirstRunHost;
  const Stage = () => {
    const [, bump] = React.useState(0);
    return h(FirstRun, {
      host, facts: facts(door), onRefresh: () => bump((n) => n + 1), onLeave: () => { /* back to the app */ },
      pull: { screened: 0, history: 0, pulled: 0 }, decide: null, mailboxId: "mb-1", rerun: true,
      screening: { dormancyDays: 365, scope: "window" as const },
    });
  };
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(KeymapProvider, { children: h(Stage, null) }),
    }));
  });
  const press = async (label: string) => {
    const button = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(label));
    expect(button, `no button labelled ${label}`).toBeTruthy();
    await act(async () => { button!.click(); for (let i = 0; i < 12; i++) await Promise.resolve(); });
  };
  await press(t.continue);
  await press(t.agree);
  expect((el.querySelector("h1")?.textContent ?? "").trim()).toBe(t.aiTitle);
  const choices = () => [...el.querySelectorAll('[role="radiogroup"] label')].map((r) => (r.textContent ?? "").trim());
  return { el, press, writes, choices };
}

describe("the AI question in setup", () => {
  it("a self-hosted server with no model offers no Yes, says why, and stores no", async () => {
    const s = await atTheAiStep("selfhost", false);
    expect(s.choices().some((c) => c.startsWith(t.aiYesSelfhost) && c.includes(t.aiYesSelfhostWhy))).toBe(false);
    expect(s.choices().some((c) => c.startsWith(t.aiNo))).toBe(true);
    expect(s.el.textContent).toContain(t.providerSelfhostOff);
    await s.press(t.continue);
    // The account rested ON; the answer this step stores is the one it offered.
    expect(s.writes).toEqual([false]);
  });

  it("a server that has not said whether it has a model is not assumed to have one", async () => {
    const s = await atTheAiStep("selfhost");
    expect(s.choices().some((c) => c.includes(t.aiYesSelfhostWhy))).toBe(false);
  });

  it("a self-hosted server with a model offers Yes on the operator's key", async () => {
    const s = await atTheAiStep("selfhost", true);
    expect(s.choices().some((c) => c.includes(t.aiYesSelfhostWhy))).toBe(true);
    expect(s.el.textContent).not.toContain(t.providerSelfhostOff);
    await s.press(t.continue);
    expect(s.writes).toEqual([true]);
  });

  it("Cloud is unchanged: Yes is offered", async () => {
    const s = await atTheAiStep("cloud");
    expect(s.choices().some((c) => c.includes(t.aiYesCloudWhy))).toBe(true);
  });
});
