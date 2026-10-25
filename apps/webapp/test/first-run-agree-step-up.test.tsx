/** @vitest-environment jsdom */
import { describe, expect, it, afterEach } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FirstRun } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import type { FirstRunHost, FirstRunOrganizeOutcome } from "../app/shell/first-run-host";
import type { OnboardingFacts } from "../app/shell/onboarding";

/**
 * AGREE MEETS THE DOOR'S SECOND-FACTOR CHECK. On the self-hosted server the consent
 * route is step-up gated; past the window it answered 403 and setup stepped back to the consent
 * statement with no sentence and no code prompt, and Close setup then said "what you agreed to
 * stays agreed". Now the step stays, says so, asks with the host's prompt and presses once more.
 * HOW TO WATCH IT FAIL: drop `{ stayOnFailure: true }` from the Agree press in `FirstRun.tsx`.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const t = messages.onboarding;

class StepUpRequired extends Error { code = "step_up_required"; }

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => { for (const r of roots.splice(0)) r.unmount(); });
  document.body.innerHTML = "";
});

/** A consented mailbox another install holds: a re-run reaches "Organize here instead" one Back from consent. */
const TAKEN = {
  organizedBy: { kind: "local", name: "Office laptop", since: "2026-09-01T09:00:00.000Z" },
  organizerState: "held", organizeConsentedAt: "2026-09-01T08:00:00.000Z",
} as const;

async function mount(
  answers: Array<"step_up" | FirstRunOrganizeOutcome>,
  opts: {
    mailbox?: Partial<NonNullable<OnboardingFacts["mailbox"]>> | null; rerun?: boolean;
    /** What `probe` and `connect` answer, in order; `ok` once these run out. */
    probe?: Array<"step_up" | "ok">; connect?: Array<"step_up" | "ok">; forget?: Array<"step_up" | "ok">;
    /** Holds every Forget's answer until it settles: a press in flight while the person moves on. */
    forgetHeld?: Promise<void>;
  } = {},
) {
  let current: OnboardingFacts = {
    door: "selfhost",
    mailbox: opts.mailbox === null ? null : {
      organizerRole: "reader", organizedBy: null, organizerState: null,
      organizeConsentedAt: null, initialImportCompletedAt: "2026-09-26T09:29:00.000Z",
      ...opts.mailbox,
    },
    // AI already answered, so Agree walks straight on to Done.
    account: { onboardingCompletedAt: null }, ai: "off", queuedSenders: 0,
  };
  const presses: Array<Record<string, unknown>> = [];
  const tried = { probe: 0, connect: 0, forget: 0 };
  const answer = (name: "probe" | "connect" | "forget"): void => {
    tried[name] += 1;
    if (opts[name]?.shift() === "step_up") throw new StepUpRequired("step-up required");
  };
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  let bump: (() => void) | null = null;
  const host: FirstRunHost = {
    door: "selfhost", ai: current.ai,
    probe: async () => { answer("probe"); return { host: "h", user: "u", folders: 1 }; },
    connect: async () => { answer("connect"); return { id: "mb-1" }; },
    forgetMailbox: async () => {
      if (opts.forgetHeld) await opts.forgetHeld;
      answer("forget");
      current = { ...current, mailbox: null };
    },
    organize: async (_id, body) => {
      presses.push(body as Record<string, unknown>);
      const a = answers.shift() ?? "stored";
      if (a === "step_up") throw new StepUpRequired("step-up required");
      if (a === "stored") {
        current = { ...current, mailbox: { ...current.mailbox!, organizeConsentedAt: "2026-09-26T09:31:00.000Z" } };
      }
      return a;
    },
    complete: async () => { /* stamped */ },
    setAiEnabled: async () => { /* answered */ },
    probeReason: () => null,
    probeMessage: () => null,
    stepUp: {
      required: (err) => (err as { code?: string })?.code === "step_up_required",
      prompt: (p) => h("div", { className: "prompt" },
        h("button", { type: "button", onClick: p.onVerified }, "Verify code"),
        h("button", { type: "button", onClick: p.onCancel }, "Cancel code")),
    },
  };
  const Stage = () => {
    const [, set] = React.useState(0);
    bump = () => set((n) => n + 1);
    return h(FirstRun, {
      host, facts: current, onRefresh: () => bump?.(), onLeave: () => { /* left */ },
      pull: { screened: 0, history: 0, pulled: 0 }, decide: null,
      mailboxId: opts.mailbox === null ? null : "mb-1", rerun: opts.rerun,
    });
  };
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(KeymapProvider, { children: h(Stage, null) }),
    }));
  });
  const button = (label: string) =>
    [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(label));
  return {
    heading: () => (el.querySelector("h1")?.textContent ?? "").trim(),
    text: () => el.textContent ?? "",
    has: (label: string) => button(label) !== undefined,
    /** A press inside Start over's confirm: its Back, not the step foot's. */
    pressInConfirm: async (label: string) => {
      const b = [...el.querySelectorAll(".ob-confirm button")]
        .find((x) => (x.textContent ?? "").trim().startsWith(label)) as HTMLButtonElement | undefined;
      if (!b) throw new Error(`no confirm button labelled ${JSON.stringify(label)}`);
      await act(async () => { b.click(); for (let i = 0; i < 16; i++) await Promise.resolve(); });
    },
    press: async (label: string) => {
      const b = button(label);
      if (!b) throw new Error(`no button labelled ${JSON.stringify(label)}`);
      await act(async () => { b.click(); for (let i = 0; i < 16; i++) await Promise.resolve(); });
    },
    presses, tried,
  };
}

async function toWindow(s: Awaited<ReturnType<typeof mount>>) {
  await s.press(t.continue);
  expect(s.heading()).toBe(t.windowTitle);
}

describe("Agree over the door's second-factor check", () => {
  it("403 step_up_required: the step stays, says so, and asks for the code", async () => {
    const s = await mount(["step_up"]);
    await toWindow(s);
    await s.press(t.agree);
    expect(s.heading(), "setup stepped back in silence").toBe(t.windowTitle);
    expect(s.text()).toContain(t.windowStepUp);
    expect(s.has("Verify code"), "no code prompt").toBe(true);
  });

  it("a verified code presses once more, and setup goes on", async () => {
    const s = await mount(["step_up", "stored"]);
    await toWindow(s);
    await s.press(t.agree);
    await s.press("Verify code");
    expect(s.presses, "the same press ran twice").toHaveLength(2);
    expect(s.presses[1]).toEqual(s.presses[0]);
    expect(s.heading()).not.toBe(t.windowTitle);
    expect(s.heading()).not.toBe(t.consentTitle);
  });

  it("a second refusal after the code is said, and is not asked again", async () => {
    const s = await mount(["step_up", "step_up"]);
    await toWindow(s);
    await s.press(t.agree);
    await s.press("Verify code");
    expect(s.presses).toHaveLength(2);
    expect(s.heading()).toBe(t.windowTitle);
    expect(s.text()).toContain(t.windowStepUp);
    expect(s.has("Verify code"), "a second prompt: the retry is once").toBe(false);
  });

  it("CONTROL: an answer that stores goes on with no prompt", async () => {
    const s = await mount(["stored"]);
    await toWindow(s);
    await s.press(t.agree);
    expect(s.presses).toHaveLength(1);
    expect(s.has("Verify code")).toBe(false);
    expect(s.heading()).not.toBe(t.windowTitle);
  });

  it("Done after Agree on a mailbox nothing holds says organizing is starting, not 'it reads'", async () => {
    const s = await mount(["stored"]);
    await toWindow(s);
    await s.press(t.agree);
    // AI, then the pull or Done: walk forward until Done.
    for (let i = 0; i < 4 && s.heading() !== t.doneReaderTitle && s.heading() !== t.doneTitle; i++) {
      if (s.has(t.continue)) await s.press(t.continue);
      else if (s.has(t.pullLeave)) await s.press(t.pullLeave);
    }
    expect(s.text()).toContain(t.doneStartLands);
    expect(s.text(), "Done said this computer only reads").not.toContain(t.doneReaderReads);
  });

  it("Close setup after a refused Agree does not say anything was agreed", async () => {
    const s = await mount(["step_up"]);
    await toWindow(s);
    await s.press(t.agree);
    await s.press("Cancel code");
    await s.press(t.cancel);
    expect(s.text()).toContain(t.cancelWhatNothingAgreed);
    expect(s.text()).not.toContain(t.cancelWhat);
  });
});

describe("Organize here instead over the door's second-factor check", () => {
  async function toTheTakeover(answers: Array<"step_up" | FirstRunOrganizeOutcome>) {
    const s = await mount(answers, { mailbox: TAKEN, rerun: true });
    expect(s.heading()).toBe(t.consentTitle);
    await s.press(t.back);
    expect(s.heading()).toBe(t.elsewhereTitle);
    await s.press(t.continue);
    return s;
  }

  it("403 step_up_required: the screen stays, says so, and asks for the code", async () => {
    const s = await toTheTakeover(["step_up"]);
    expect(s.presses).toEqual([{ intent: "takeover" }]);
    expect(s.heading(), "the take-over left its screen").toBe(t.elsewhereTitle);
    expect(s.text()).toContain(t.elsewhereStepUp ?? "elsewhereStepUp");
    expect(s.has("Verify code"), "no code prompt").toBe(true);
  });

  it("a verified code takes it over once more; a second refusal is said, not asked again", async () => {
    const s = await toTheTakeover(["step_up", "stored"]);
    await s.press("Verify code");
    expect(s.presses).toEqual([{ intent: "takeover" }, { intent: "takeover" }]);
    expect(s.text()).toContain(t.elsewhereQueued);

    const again = await toTheTakeover(["step_up", "step_up"]);
    await again.press("Verify code");
    expect(again.presses).toHaveLength(2);
    expect(again.has("Verify code"), "a second prompt: the retry is once").toBe(false);
  });

  it("Cancel presses nothing, and the sentence says nothing changed", async () => {
    const s = await toTheTakeover(["step_up"]);
    await s.press("Cancel code");
    expect(s.presses).toHaveLength(1);
    expect(s.has("Verify code")).toBe(false);
    expect(s.text()).toContain(t.elsewhereStepUp ?? "elsewhereStepUp");
  });
});

describe("Test connection and Connect over the door's second-factor check", () => {
  it("each asks for the code, is pressed once more on a verified code, and a cancel stores nothing", async () => {
    const s = await mount([], { mailbox: null, probe: ["step_up"], connect: ["step_up", "step_up"] });
    await s.press(t.welcomeStart);
    await s.press(t.test);
    expect(s.text()).toContain(t.mailboxStepUp ?? "mailboxStepUp");
    await s.press("Verify code");
    expect(s.tried.probe, "the test did not run again").toBe(2);
    expect(s.text()).not.toContain(t.mailboxStepUp ?? "mailboxStepUp");

    await s.press(t.connect);
    expect(s.tried.connect).toBe(1);
    expect(s.text()).toContain(t.mailboxStepUp ?? "mailboxStepUp");
    await s.press("Cancel code");
    expect(s.tried.connect, "Cancel connected").toBe(1);
    expect(s.has("Verify code")).toBe(false);

    await s.press(t.connect);
    await s.press("Verify code");
    expect(s.tried.connect, "the verified code did not connect once more").toBe(3);
  });
});

describe("Start over's Forget over the door's second-factor check", () => {
  async function forgetOnWindow(forget: Array<"step_up" | "ok">) {
    const s = await mount([], { forget });
    await toWindow(s);
    await s.press(t.restart);
    await s.press(t.restartForget);
    return s;
  }

  it("403 step_up_required: the step stays, says so, and asks for the code", async () => {
    const s = await forgetOnWindow(["step_up"]);
    expect(s.tried.forget).toBe(1);
    expect(s.heading(), "setup said it started empty").toBe(t.windowTitle);
    expect(s.text()).toContain(t.forgetStepUp ?? "forgetStepUp");
    expect(s.has("Verify code"), "no code prompt").toBe(true);
  });

  it("a verified code forgets once more and lands on the first step", async () => {
    const s = await forgetOnWindow(["step_up", "ok"]);
    await s.press("Verify code");
    expect(s.tried.forget).toBe(2);
    expect(s.text()).toContain(t.welcomeTitle);
    expect(s.text()).not.toContain(t.forgetStepUp ?? "forgetStepUp");
  });

  it("Keep the mailbox after a refused Forget disarms the prompt: walking back to the step forgets nothing", async () => {
    const s = await forgetOnWindow(["step_up", "ok"]);
    expect(s.has("Verify code")).toBe(true);
    await s.press(t.restartKeep);
    expect(s.has("Verify code"), "the forget prompt stayed armed after Keep").toBe(false);
    for (let i = 0; i < 4 && s.heading() !== t.windowTitle; i++) await s.press(t.continue);
    expect(s.heading()).toBe(t.windowTitle);
    expect(s.has("Verify code"), "the forget prompt came back on How far back").toBe(false);
    expect(s.tried.forget, "the kept mailbox was forgotten").toBe(1);
    expect(s.text()).not.toContain(t.welcomeTitle);
  });

  it("the confirm's Back after a refused Forget closes the forget prompt with it", async () => {
    const s = await forgetOnWindow(["step_up", "ok"]);
    await s.pressInConfirm(t.back);
    expect(s.has("Verify code"), "the forget prompt outlived its confirm").toBe(false);
    expect(s.heading()).toBe(t.windowTitle);
    expect(s.tried.forget).toBe(1);
  });

  it("the confirm's Back while the Forget is in flight: its later step-up refusal opens no prompt", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    // Agree then fails for a reason of its own ("gone"), so the step stays with a sentence up.
    const s = await mount(["gone"], { forget: ["step_up", "ok"], forgetHeld: held });
    await toWindow(s);
    await s.press(t.restart);
    await s.press(t.restartForget);
    await s.pressInConfirm(t.back);
    expect(s.tried.forget, "the Forget answered before Back").toBe(0);
    await act(async () => { release(); for (let i = 0; i < 16; i++) await Promise.resolve(); });
    expect(s.tried.forget).toBe(1);
    expect(s.has("Verify code"), "the withdrawn Forget's refusal opened a code prompt").toBe(false);
    await s.press(t.agree);
    expect(s.has("Verify code"), "a code prompt for the withdrawn Forget").toBe(false);
    if (s.has("Verify code")) await s.press("Verify code");
    expect(s.tried.forget, "a later code forgot the kept mailbox").toBe(1);
    expect(s.text()).not.toContain(t.welcomeTitle);
  });

  it("Escape over Start over's confirm withdraws the Forget, and its prompt with it", async () => {
    const s = await forgetOnWindow(["step_up", "ok"]);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      for (let i = 0; i < 16; i++) await Promise.resolve();
    });
    await s.pressInConfirm(t.back);
    expect(s.has("Verify code"), "the forget prompt outlived Escape").toBe(false);
    expect(s.tried.forget).toBe(1);
  });

  it("Cancel forgets nothing more and the sentence stays", async () => {
    const s = await forgetOnWindow(["step_up"]);
    await s.press("Cancel code");
    expect(s.tried.forget).toBe(1);
    expect(s.has("Verify code")).toBe(false);
    expect(s.heading()).toBe(t.windowTitle);
    expect(s.text()).toContain(t.forgetStepUp ?? "forgetStepUp");
  });
});
