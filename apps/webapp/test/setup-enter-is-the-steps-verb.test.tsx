/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { resetModalGateForTests } from "@ohmail/app-logic/session/modal-gate";
import type { FirstRunOrganizeOutcome } from "@ohmail/app-logic/doors/first-run-host";
import type { OnboardingAi, OnboardingMailbox } from "@ohmail/app-logic/doors/onboarding";
import type { FirstRunRow, FirstRunSender } from "@ohmail/app-logic/mailboxes/first-run/ground";
import { O, P, fakeDoor, id } from "../../../packages/app/test/mailboxes/connect/support.js";
import { StepUpDialog, type StepUpDoor } from "../../../packages/app/src/doors/step-up/index.js";
import { RUNGS } from "../../../packages/app/src/mailboxes/first-run/words.js";
import { mountStage } from "./_first-run-stage.js";

/**
 * ↵ ON EVERY SETUP STEP IS THE STEP'S OWN VERB. On 0.25.22 the card took focus
 * itself when it opened and kept it while the steps changed under it; ↵ there reached no form, so
 * the last step's ↵ (the badge on "Open ohmail") did nothing. Focus now lands inside each step's
 * form on its ↵ control — on open, on every step change, around the code prompt — and ↵ on the
 * card itself is the step's implicit submission. And the first decision names the Screener's
 * count, pluralised (the shell's half is `setup-first-decision-count-is-the-rail`).
 *
 * RE-POINTED (the switch's older tests, sorted once): the run is the new frame's first-run stage
 * (`packages/app/src/mailboxes/first-run`, where the keys stand as a step opens: `focus.ts`) over a ground the case
 * moves (`_first-run-stage.tsx`), its words the stage's catalogues; the card is the stage's dialog;
 * a choice is a radio by its name; the code prompt is the stage's factor slot, the same form; the decision's sender
 * is the ground's. Every expectation is as it stood.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const t = O;

/** The step's second-factor refusal, as the door throws it. */
const stepUp = (): Error => Object.assign(new Error("step-up required"), {
  status: 403, code: "step_up_required", message: "Confirm it is you.", details: {},
});

/** The second factor's door: an authenticator code, and every code verifies. */
const STEP_UP_DOOR: StepUpDoor = {
  factors: async () => ({ ok: true, factors: { passkey: false, code: true, recovery: false } }),
  verify: async () => ({ ok: true }),
} as StepUpDoor;
/** The code prompt while it stands: the dialog that holds the code's field. */
const prompt = (el: HTMLElement): HTMLElement | null =>
  [...el.querySelectorAll<HTMLElement>("label")].find((l) => l.textContent === CODE_LABEL)?.closest<HTMLElement>('[role="dialog"]') ?? null;
const CODE_LABEL = "Six-digit code from your authenticator app";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  resetModalGateForTests();
});

const flush = async (): Promise<void> => {
  await act(async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
};

/** What the ground hands: the mailbox (or none), the account's AI answer and how many senders wait. */
interface OnboardingFacts {
  mailbox: OnboardingMailbox | null;
  account: { onboardingCompletedAt: string | null };
  ai: OnboardingAi;
  queuedSenders: number;
}

interface StageOpts {
  facts: OnboardingFacts;
  answers?: Array<"step_up" | FirstRunOrganizeOutcome>;
  rerun?: boolean;
  add?: boolean;
  waiting?: number;
  locale?: "en" | "de";
}

const rowOf = (mailbox: OnboardingMailbox): FirstRunRow =>
  ({ id: id("mb-1"), address: "me@example.invalid", ...mailbox }) as FirstRunRow;

async function mount(o: StageOpts) {
  let current = o.facts;
  const answers = [...(o.answers ?? [])];
  const counts = { completed: 0, connected: 0, organized: 0, left: 0, decided: [] as string[] };
  const door = fakeDoor();
  const connect = door.door;
  const sender = (): FirstRunSender => ({
    name: "Rig Sender Finch", address: "finch@rig.invalid", held: 2, waiting: o.waiting ?? 3, many: false, since: "2 held",
    decide: (dest) => { counts.decided.push(dest); },
  });
  const rows = (): FirstRunRow[] => (current.mailbox === null ? [] : [rowOf(current.mailbox)]);
  const st = await mountStage({
    rows: rows(),
    at: o.rerun ? "#/first-run/again?mailbox=mb-1" : o.add ? "#/first-run/add" : "#/first-run",
    door: "selfhost",
    locale: o.locale,
    connect,
    live: rows,
    about: {
      get queuedSenders() { return current.queuedSenders; },
      get sender() { return current.queuedSenders > 0 ? sender() : null; },
    } as never,
    /* The code prompt: the second factor's dialog as the web hands it, over a door that reads a code and verifies it. */
    factor: (ask) => h(StepUpDialog, { door: STEP_UP_DOOR, ...ask }),
    verbs: {
      ai: current.ai,
      organize: async () => {
        counts.organized += 1;
        const a = answers.shift() ?? "stored";
        if (a === "step_up") throw stepUp();
        if (a === "stored") current = { ...current, mailbox: { ...current.mailbox!, organizeConsentedAt: "2026-10-12T00:21:20.000Z" } };
        return a;
      },
      complete: async () => { counts.completed += 1; },
      setAiEnabled: async (on: boolean) => { current = { ...current, ai: on ? "on" : "off" }; },
    },
  });
  const el = st.el;
  await flush();
  const at = st.address();
  /* The card: the stage itself, the outermost dialog over the app. */
  const card = (): HTMLElement => el.querySelector<HTMLElement>('[role="dialog"]')!;
  const counted = {
    get completed() { return counts.completed; },
    get connected() { return door.calls.filter((c) => c.verb === "connect").length; },
    get organized() { return counts.organized; },
    get left() { return st.address() !== at && !st.address().includes("first-run") ? 1 : 0; },
    get decided() { return counts.decided; },
  };
  /* EVERY STEP THE STAGE DREW, in order. Today's harness kept the card drawn after it left (the shell unmounted it);
     the frame takes the stage away as it leaves, so a step read after that is the last one it drew. */
  const drawn: string[] = [st.heading()];
  const watch = new MutationObserver(() => {
    const now = st.heading();
    if (now !== "" && drawn.at(-1) !== now) drawn.push(now);
  });
  watch.observe(el, { subtree: true, childList: true, characterData: true });
  return {
    el, counts: counted, card,
    set: async (next: (f: OnboardingFacts) => OnboardingFacts) => { current = next(current); await st.move(rows()); await flush(); },
    heading: (): string => st.heading() || (counted.left === 1 ? drawn.at(-1) ?? "" : ""),
    lead: (): string => (el.querySelector("h1")?.closest("main")?.querySelector(".oh-page-line")?.textContent ?? "").trim(),
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
  if (a.matches('[role="dialog"]')) return "the dialog card";
  /* The decision's card: the group named for its sender, which holds the decision's letter keys and has no ↵ verb. */
  if (a.matches('[role="group"][tabindex="0"]') && a.closest(".mbx-run") !== null) return "the dialog card";
  if (a.getAttribute("role") === "radio") {
    /* The window's choices by their names, said as the rung each one is (`words.ts` RUNGS). */
    const name = (a.querySelector(".oh-radioline-word")?.textContent ?? "").trim();
    const rung = RUNGS.find((r) => name.startsWith(t[r.label.slice("onboarding.".length) as keyof typeof t] as string));
    return `input radio ${rung?.value ?? name}${a.getAttribute("aria-checked") === "true" ? " (checked)" : ""}`;
  }
  if (a instanceof HTMLFormElement) return "FORM";
  if (a instanceof HTMLInputElement) return `input ${a.type} ${a.value}${a.checked ? " (checked)" : ""}`;
  return `${a.tagName} "${(a.textContent ?? "").trim().slice(0, 40)}"`;
}

/** Focus stands inside the step's form, on a control: the only place a browser's ↵ submits from. */
function inStepForm(s: { card: () => HTMLElement }): boolean {
  /* The step's form: the stage's own (the mailbox step's is the connect form), never the code prompt's dialog. */
  const a = document.activeElement;
  const form = a?.closest("form") ?? null;
  return form !== null && a !== form && form.closest('[role="dialog"]') === s.card();
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

/** A key as a browser delivers it: at the element that has the keys. */
async function letter(k: string): Promise<void> {
  await act(async () => { ((document.activeElement as HTMLElement | null) ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
  await flush();
}

const FIRST_RUN: OnboardingFacts = {
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
    /* The mailbox step is the one connect form: its fields stand once a provider is chosen. */
    await act(async () => { s.button(P.otherLabel).click(); });
    await flush();
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
    await act(async () => { ((document.activeElement as HTMLElement | null) ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await flush();
    const close = s.button(t.cancelConfirm);
    await act(async () => { close.focus(); });
    await s.set((f) => ({ ...f, queuedSenders: 4 }));
    expect(document.activeElement, `the question lost focus to ${focusWord()}`).toBe(close);
  });

  it("Escape asks whether to cancel with focus on Close setup: ↵ there closes setup, and the step's ↵ never runs", async () => {
    const s = await mount({ facts: FIRST_RUN });
    await act(async () => { ((document.activeElement as HTMLElement | null) ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await flush();
    /* The kit draws ↵ on a question's first verb (its look): the name the keys stand on is the same. */
    expect(focusWord(), "the question opened with focus left in the step").toBe(`BUTTON "${t.cancelConfirm}↵"`);
    await enter();
    expect(s.counts, "↵ in the question did not close setup").toMatchObject({ completed: 1, left: 1, organized: 0 });
    expect(s.heading(), "↵ in the question moved the step behind it").toBe(t.consentTitle);
  });

  it("Start over asks with focus on its first verb, and taking the question back puts focus in the step's form", async () => {
    const s = await mount({ facts: FIRST_RUN });
    await act(async () => { s.button(t.restart).click(); });
    await flush();
    /* The kit draws ↵ on a question's first verb (its look): the name the keys stand on is the same. */
    expect(focusWord(), "the question opened with focus left in the step").toBe(`BUTTON "${t.restartKeep}↵"`);
    const backs = [...s.card().querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === t.back);
    await act(async () => { backs[backs.length - 1]!.click(); });
    await flush();
    expect(inStepForm(s), `the question closed and left focus on ${focusWord()}`).toBe(true);
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
    expect(prompt(s.el), "no code prompt").not.toBeNull();
    expect(prompt(s.el)!.contains(document.activeElement),
      `the prompt opened with focus on ${focusWord()}`).toBe(true);

    await act(async () => { [...prompt(s.el)!.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith("Cancel"))!.click(); });
    await flush();
    expect(prompt(s.el)).toBeNull();
    expect(inStepForm(s), `Cancel left focus on ${focusWord()}`).toBe(true);

    await enter();
    expect(prompt(s.el)).not.toBeNull();
    await act(async () => { fireEvent.change(prompt(s.el)!.querySelector("input")!, { target: { value: "123456" } }); });
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
