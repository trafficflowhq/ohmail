/** @vitest-environment jsdom */
import { describe, expect, it, afterEach } from "vitest";
import { act, cleanup } from "@testing-library/react";
import type { OnboardingMailbox } from "@ohmail/app-logic/doors/onboarding";
import type { FirstRunRow } from "@ohmail/app-logic/mailboxes/first-run/ground";
import { O, id } from "../../../packages/app/test/mailboxes/connect/support.js";
import { mountStage, type MountedStage } from "./_first-run-stage.js";

/**
 * ═══ ↵ DOES WHAT THE ↵ BADGE SAYS, ON SETUP'S LAST STEP ════════════════════════════════════
 *
 * "Just read it here" → Continue reaches "What this computer does". Continue was the focused
 * control and the step took it away, so the shell's focus rule landed in the card at its first
 * control — "Start over", the summary having no Cancel — and ↵ asked to start setup over while
 * "Open ohmail" wore the ↵ badge. Mounted with the shell's `FocusFollows`, as the app mounts it.
 *
 * RE-POINTED (the switch's older tests, sorted once): the run is the new frame's first-run stage
 * (`_first-run-stage.tsx`), whose own focus rule replaces the shell's `FocusFollows`; the mailbox is
 * the ground's row, the holder's date its `holderSince`; a choice is the step's radio by its name; the words the
 * stage's catalogue. Every expectation is as it stood.
 */
const t = O;

const PEEKED: OnboardingMailbox = {
  organizerRole: "reader",
  organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
  organizerState: "held",
  organizeConsentedAt: null,
  initialImportCompletedAt: null,
};

const ROW = { id: id("mb-1"), address: "me@example.invalid", ...PEEKED, holderSince: "30 Aug 2026" } as FirstRunRow;

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const flush = async (): Promise<void> => {
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
};

async function mount(): Promise<{ el: HTMLElement; st: MountedStage; completed: () => number }> {
  let completes = 0;
  const st = await mountStage({
    rows: [ROW],
    door: "local",
    verbs: {
      ai: "unset",
      organize: async () => "stored",
      complete: async () => { completes += 1; },
      setAiEnabled: async () => { /* answered */ },
    },
  });
  await flush();
  return { el: st.el, st, completed: () => completes };
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
  await s.st.pick(t.elsewhereChoiceRead);
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
