/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import deMessages from "../messages/de.json";
import { FirstRun, type FirstRunDecideSubject } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import { FocusFollows } from "../app/shell/focus-follows";
import { resetModalGateForTests } from "../app/shell/modal-gate";
import type { FirstRunHost, FirstRunOrganizeOutcome } from "../app/shell/first-run-host";
import type { OnboardingFacts } from "../app/shell/onboarding";

/**
 * ↵ ON EVERY SETUP STEP IS THE STEP'S OWN VERB. On 0.25.22 the card took focus
 * itself when it opened and kept it while the steps changed under it; ↵ there reached no form, so
 * the last step's ↵ (the badge on "Open ohmail") did nothing. Focus now lands inside each step's
 * form on its ↵ control — on open, on every step change, around the code prompt — and ↵ on the
 * card itself is the step's implicit submission. And the first decision names the Screener's
 * count, pluralised (the shell's half is `setup-first-decision-count-is-the-rail`).
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const t = messages.onboarding;

class StepUpRequired extends Error { code = "step_up_required"; }

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => { for (const r of roots.splice(0)) r.unmount(); });
  document.body.innerHTML = "";
  resetModalGateForTests();
});

const flush = async (): Promise<void> => {
  await act(async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
};

interface StageOpts {
  facts: OnboardingFacts;
  answers?: Array<"step_up" | FirstRunOrganizeOutcome>;
  rerun?: boolean;
  add?: boolean;
  waiting?: number;
  locale?: "en" | "de";
}

async function mount(o: StageOpts) {
  let current = o.facts;
  const answers = [...(o.answers ?? [])];
  const counts = { completed: 0, connected: 0, organized: 0, left: 0, decided: [] as string[] };
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  let bump: (() => void) | null = null;
  const host: FirstRunHost = {
    door: "selfhost", ai: current.ai,
    probe: async () => ({ host: "h", user: "u", folders: 1 }),
    connect: async () => { counts.connected += 1; return { id: "mb-1" }; },
    organize: async () => {
      counts.organized += 1;
      const a = answers.shift() ?? "stored";
      if (a === "step_up") throw new StepUpRequired("step-up required");
      if (a === "stored") current = { ...current, mailbox: { ...current.mailbox!, organizeConsentedAt: "2026-10-12T00:21:20.000Z" } };
      return a;
    },
    complete: async () => { counts.completed += 1; },
    setAiEnabled: async (on: boolean) => { current = { ...current, ai: on ? "on" : "off" }; },
    probeReason: () => null,
    probeMessage: () => null,
    stepUp: {
      required: (err) => (err as { code?: string })?.code === "step_up_required",
      prompt: (p) => h("form", { className: "prompt", onSubmit: (e: Event) => e.preventDefault() },
        h("input", { type: "text", "aria-label": "Code" }),
        h("button", { type: "button", onClick: p.onVerified }, "Verify code"),
        h("button", { type: "button", onClick: p.onCancel }, "Cancel code")),
    },
  };
  const decide: FirstRunDecideSubject = {
    name: "Rig Sender Finch", address: "finch@rig.invalid", held: 2, waiting: o.waiting ?? 3, since: "2 held",
    onDecide: (dest) => { counts.decided.push(dest); },
  };
  const Stage = () => {
    const [, set] = React.useState(0);
    bump = () => set((n) => n + 1);
    return h(FirstRun, {
      host, facts: current, onRefresh: () => bump?.(), onLeave: () => { counts.left += 1; },
      pull: { screened: 0, history: 0, pulled: 0 },
      decide: current.queuedSenders > 0 ? decide : null,
      mailboxId: current.mailbox === null ? null : "mb-1",
      rerun: o.rerun, add: o.add,
    });
  };
  const locale = o.locale ?? "en";
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale, messages: locale === "de" ? deMessages : messages, timeZone: "UTC",
      children: h(KeymapProvider, {
        children: [
          h(FocusFollows, { key: "ff" }),
          h("button", { key: "opener", type: "button", className: "opener" }, "Run setup"),
          h(Stage, { key: "stage" }),
        ],
      }),
    }));
  });
  await flush();
  const card = (): HTMLElement => el.querySelector<HTMLElement>('.ob-card[aria-modal="true"]')!;
  return {
    el, counts, card,
    set: async (next: (f: OnboardingFacts) => OnboardingFacts) => { current = next(current); await act(async () => { bump?.(); }); await flush(); },
    heading: (): string => (el.querySelector("h1")?.textContent ?? "").trim(),
    lead: (): string => (el.querySelector(".ob-card .sub")?.textContent ?? "").trim(),
    button: (label: string): HTMLButtonElement => {
      const b = [...el.querySelectorAll("button")].find((x) => (x.textContent ?? "").trim().startsWith(label));
      if (!b) throw new Error(`no button ${label}`);
      return b;
    },
  };
}

/** Where focus stands, in words a failure can print. */
function focusWord(): string {
  const a = document.activeElement as HTMLElement | null;
  if (a === null || a === document.body) return "the page root";
  if (a.matches(".ob-card")) return "the dialog card";
  if (a instanceof HTMLFormElement) return "FORM";
  if (a instanceof HTMLInputElement) return `input ${a.type} ${a.value}${a.checked ? " (checked)" : ""}`;
  return `${a.tagName} "${(a.textContent ?? "").trim().slice(0, 40)}"`;
}

/** Focus stands inside the step's form, on a control: the only place a browser's ↵ submits from. */
function inStepForm(s: { card: () => HTMLElement }): boolean {
  const form = s.card().querySelector("form");
  const a = document.activeElement;
  return form !== null && a !== null && a !== form && form.contains(a);
}

/**
 * ↵ AS CHROMIUM DELIVERS IT: keydown at the focused element; then a focused button activates, and a
 * field in a form submits it through the form's first submit button unless that one is disabled.
 * On anything else (a div, the card) nothing follows the keydown.
 */
async function enter(): Promise<void> {
  await act(async () => {
    const at = (document.activeElement as HTMLElement | null) ?? document.body;
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    at.dispatchEvent(ev);
    if (ev.defaultPrevented) return;
    if (at instanceof HTMLButtonElement) { at.click(); return; }
    if (at instanceof HTMLInputElement && at.form) {
      const submit = at.form.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (submit !== null && !submit.disabled) at.form.requestSubmit(submit);
    }
  });
  await flush();
}

async function letter(k: string): Promise<void> {
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
  await flush();
}

const FIRST_RUN: OnboardingFacts = {
  door: "selfhost",
  mailbox: {
    organizerRole: "reader", organizedBy: null, organizerState: null,
    organizeConsentedAt: null, initialImportCompletedAt: null,
  },
  account: { onboardingCompletedAt: null }, ai: "unset", queuedSenders: 3,
};
const SETTLED: OnboardingFacts = {
  ...FIRST_RUN,
  mailbox: { ...FIRST_RUN.mailbox!, organizerRole: "organizer", organizeConsentedAt: "2026-10-12T00:21:20.000Z",
    initialImportCompletedAt: "2026-10-12T00:22:00.000Z" },
  ai: "off", queuedSenders: 0,
};

describe("R33-01: ↵ on every setup step does what the step's ↵ button does", () => {
  it("a first run, ↵ from wherever focus lands, through every step to Open ohmail", async () => {
    const s = await mount({ facts: FIRST_RUN });
    expect(s.heading()).toBe(t.consentTitle);
    expect(inStepForm(s), `opened with focus on ${focusWord()}`).toBe(true);
    await enter();

    expect(s.heading()).toBe(t.windowTitle);
    expect(inStepForm(s), `the window step left focus on ${focusWord()}`).toBe(true);
    expect(focusWord(), "a radio group is entered on its checked choice").toBe("input radio 365 (checked)");
    await enter();
    expect(s.counts.organized, "↵ on the window step did not agree").toBe(1);

    expect(s.heading()).toBe(t.aiTitle);
    expect(inStepForm(s), `the AI step left focus on ${focusWord()}`).toBe(true);
    await enter();

    expect(s.heading()).toBe(t.pullTitle);
    expect(inStepForm(s), `the pull step left focus on ${focusWord()}`).toBe(true);
    expect(focusWord()).toBe(`BUTTON "${t.pullLeave}"`);
    // The import ends; ↵ here would leave setup, which is this step's verb.
    await s.set((f) => ({ ...f, mailbox: { ...f.mailbox!, initialImportCompletedAt: "2026-10-12T00:22:00.000Z" } }));

    expect(s.heading()).toBe(t.decideTitle);
    expect(focusWord(), "the decision has no ↵ verb: focus holds on the card").toBe("the dialog card");
    await enter();
    expect(s.heading(), "↵ on the decision did something").toBe(t.decideTitle);
    expect(s.counts.decided).toEqual([]);
    await letter("r");
    expect(s.counts.decided).toEqual(["reads"]);

    // A reader until its first pass claims the mailbox: the tester's "What this computer does".
    expect(s.heading()).toBe(t.doneReaderTitle);
    expect(inStepForm(s), `the last step left focus on ${focusWord()}`).toBe(true);
    expect(focusWord()).toBe(`BUTTON "${t.doneOpen}↵"`);
    await enter();
    expect(s.counts.completed, "↵ on the last step did not open ohmail").toBe(1);
    expect(s.counts.left).toBe(1);
  });

  it("while the holder check holds the consent step, focus waits on the step itself, never Cancel; then it moves to the step's verb", async () => {
    const s = await mount({
      facts: { ...FIRST_RUN, mailbox: { ...FIRST_RUN.mailbox!, organizerChecked: false } },
    });
    expect(s.heading()).toBe(t.resumeCheckingTitle);
    expect(s.button(t.continue).disabled, "the check is not pending").toBe(true);
    expect(focusWord(), "focus took the foot's Cancel while the step was shut").toBe("FORM");
    await enter();
    expect(s.el.textContent, "↵ asked to cancel setup").not.toContain(t.cancelConfirm);
    expect(s.heading(), "↵ walked past the check").toBe(t.resumeCheckingTitle);
    await s.set((f) => ({ ...f, mailbox: { ...f.mailbox!, organizerChecked: true } }));
    expect(s.heading()).toBe(t.consentTitle);
    expect(focusWord(), "the check answered and focus stayed put").toBe(`BUTTON "${t.continue}↵"`);
    await enter();
    expect(focusWord()).toBe("input radio 365 (checked)");
    await enter();
    expect(s.counts.organized, "↵ did not agree once the check answered").toBe(1);
  });

  it("a click on the dialog's text focuses the card: focus goes on to the ↵ control, and ↵ opens ohmail", async () => {
    const s = await mount({ facts: SETTLED });
    expect(s.heading()).toBe(t.doneTitle);
    await act(async () => { s.card().focus(); });
    expect(focusWord(), "focus stayed on the card, where ↵ reaches no form").toBe(`BUTTON "${t.doneOpen}↵"`);
    await enter();
    expect(s.counts.completed, "↵ after a click on the text did nothing").toBe(1);
  });

  it("control: while the ↵ control is shut (Connect before a test passed), focus on the card goes to the first field and ↵ connects nothing", async () => {
    const s = await mount({ facts: { ...FIRST_RUN, mailbox: null }, add: true });
    expect(s.heading()).toBe(t.mailboxTitle);
    expect(s.button(t.connect).disabled).toBe(true);
    await act(async () => { s.card().focus(); });
    expect(inStepForm(s), `focus on ${focusWord()}`).toBe(true);
    await enter();
    expect(s.counts.connected).toBe(0);
    expect(s.heading()).toBe(t.mailboxTitle);
  });

  it("a place the person chose stays theirs: the next render does not pull focus back to the entry", async () => {
    const s = await mount({ facts: FIRST_RUN });
    expect(focusWord()).toBe(`BUTTON "${t.continue}↵"`);
    await act(async () => { s.button(t.back).focus(); });
    await s.set((f) => ({ ...f, queuedSenders: 4 }));
    expect(focusWord(), "a render took focus from where the person put it").toBe(`BUTTON "${t.back}"`);
  });

  it("while setup asks whether to cancel, a render leaves focus in the question", async () => {
    const s = await mount({ facts: FIRST_RUN });
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await flush();
    const close = s.button(t.cancelConfirm);
    await act(async () => { close.focus(); });
    await s.set((f) => ({ ...f, queuedSenders: 4 }));
    expect(document.activeElement, `the question lost focus to ${focusWord()}`).toBe(close);
  });

  it("Run setup again opens with focus on its first step's ↵ control, not the card", async () => {
    const s = await mount({
      facts: { ...SETTLED, account: { onboardingCompletedAt: "2026-10-12T00:23:10.000Z" } }, rerun: true,
    });
    expect(s.heading()).toBe(t.consentTitle);
    expect(focusWord()).toBe(`BUTTON "${t.continue}↵"`);
    await enter();
    expect(s.heading()).toBe(t.windowTitle);
  });

  it("the code prompt takes focus; Cancel and Verify each put it back in a step's form", async () => {
    const s = await mount({
      facts: { ...SETTLED, mailbox: { ...SETTLED.mailbox!, organizerRole: "reader", organizeConsentedAt: null } },
      answers: ["step_up", "step_up", "stored"],
    });
    expect(s.heading()).toBe(t.consentTitle);
    await enter();
    await enter();
    expect(s.el.querySelector(".prompt"), "no code prompt").not.toBeNull();
    expect(s.el.querySelector(".prompt")!.contains(document.activeElement),
      `the prompt opened with focus on ${focusWord()}`).toBe(true);

    await act(async () => { s.button("Cancel code").click(); });
    await flush();
    expect(s.el.querySelector(".prompt")).toBeNull();
    expect(inStepForm(s), `Cancel left focus on ${focusWord()}`).toBe(true);

    await enter();
    expect(s.el.querySelector(".prompt")).not.toBeNull();
    await act(async () => { s.button("Verify code").click(); });
    await flush();
    expect(s.heading()).toBe(t.doneReaderTitle);
    expect(inStepForm(s), `after the code focus stood on ${focusWord()}`).toBe(true);
    await enter();
    expect(s.counts.completed).toBe(1);
  });
});

describe("R33-02: the first decision names how many senders wait", () => {
  const AT_DECIDE: OnboardingFacts = { ...SETTLED, queuedSenders: 3 };

  it("three wait: it says three, in English and in German", async () => {
    const en = await mount({ facts: AT_DECIDE, waiting: 3 });
    expect(en.heading()).toBe(t.decideTitle);
    expect(en.lead()).toMatch(/^3 senders are waiting\. /);
    const de = await mount({ facts: AT_DECIDE, waiting: 3, locale: "de" });
    expect(de.lead()).toMatch(/^3 Absender warten\. /);
  });

  it("forty wait: forty", async () => {
    const s = await mount({ facts: AT_DECIDE, waiting: 40 });
    expect(s.lead()).toMatch(/^40 senders are waiting\. /);
  });

  it("control: one waits, and the singular stays; a count that has not caught up with the card says one", async () => {
    const one = await mount({ facts: AT_DECIDE, waiting: 1 });
    expect(one.lead()).toMatch(/^One sender is waiting\. /);
    const lag = await mount({ facts: AT_DECIDE, waiting: 0, locale: "de" });
    expect(lag.lead()).toMatch(/^Ein Absender wartet\. /);
  });
});
