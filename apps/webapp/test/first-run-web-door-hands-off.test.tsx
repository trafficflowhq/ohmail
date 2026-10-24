/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FirstRun } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import type { FirstRunHost } from "../app/shell/first-run-host";
import type { OnboardingFacts } from "../app/shell/onboarding";

/**
 * ON A WEB DOOR THE SETUP STAGE HANDS THE FIRST CONNECT TO THE SETUP PAGE. Its own Connect and Test
 * have no step-up prompt, so a person who took longer than the step-up window met a refusal they
 * could not answer there; `/join` has the provider tiles and the in-place prompt. The desktop's
 * stage keeps its form.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const t = messages.onboarding;

const roots: Root[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.unmount();
  document.body.innerHTML = "";
});

const firstRun = (door: OnboardingFacts["door"]): OnboardingFacts => ({
  door, mailbox: null, account: { onboardingCompletedAt: null }, ai: "on", queuedSenders: 0,
});

async function mount(o: { door: OnboardingFacts["door"]; web: boolean; add?: boolean }) {
  let resumes = 0;
  let connects = 0;
  const host: FirstRunHost = {
    door: o.door,
    ai: "on",
    probe: async () => ({ host: "h", user: "u", folders: 1 }),
    connect: async () => { connects += 1; return { id: "mb-new" }; },
    organize: async () => "stored",
    complete: async () => {},
    probeReason: () => null,
    probeMessage: () => null,
    ...(o.web ? { setupHref: "/join", resume: () => { resumes += 1; }, oauthPending: () => false } : {}),
  };
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(KeymapProvider, {
        children: h(FirstRun, {
          host,
          facts: firstRun(o.door),
          onRefresh: () => {},
          onLeave: () => {},
          pull: { screened: 0, history: 0, pulled: 0 },
          decide: null,
          mailboxId: null,
          ...(o.add ? { add: true } : {}),
        }),
      }),
    }));
  });
  const press = async (label: string) => {
    const b = [...el.querySelectorAll("button")].find((x) => (x.textContent ?? "").includes(label));
    expect(b, `no "${label}" button`).toBeTruthy();
    await act(async () => { b!.click(); });
  };
  // A first run opens on the welcome; its one verb walks on to the mailbox step.
  if (!o.add) await press(t.welcomeStart);
  return { el, press, resumes: () => resumes, connects: () => connects };
}

describe("the mailbox step with no mailbox", () => {
  it("on the Cloud door is a hand-off to the setup page, not a form", async () => {
    const s = await mount({ door: "cloud", web: true });
    expect(s.el.querySelector("h1")?.textContent).toBe(t.mailboxTitle);
    expect(s.el.textContent).toContain(t.mailboxHandoffLead);
    expect(s.el.querySelector("input[type=password]"), "the connect form is still here").toBeNull();
    await s.press(t.mailboxHandoffGo);
    expect(s.resumes()).toBe(1);
    expect(s.connects()).toBe(0);
  });

  it("on a self-hosted server too", async () => {
    const s = await mount({ door: "selfhost", web: true });
    expect(s.el.textContent).toContain(t.mailboxHandoffLead);
  });

  it("the desktop's stage keeps its form", async () => {
    const s = await mount({ door: "local", web: false });
    expect(s.el.textContent).not.toContain(t.mailboxHandoffLead);
    expect(s.el.querySelector("input[type=password]")).not.toBeNull();
  });

  it("an add run keeps its form: the setup page is for a first mailbox", async () => {
    const s = await mount({ door: "cloud", web: true, add: true });
    expect(s.el.textContent).not.toContain(t.mailboxHandoffLead);
    expect(s.el.querySelector("input[type=password]")).not.toBeNull();
  });
});
