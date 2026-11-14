/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FirstRun, firstRunStep } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import { firstRunSubject } from "@ohmail/app-logic/doors/first-run-subject";
import type { FirstRunHost, FirstRunMailboxInput } from "@ohmail/app-logic/doors/first-run-host";
import type { OnboardingFacts, OnboardingStep } from "@ohmail/app-logic/doors/onboarding";

/**
 * A RUN THAT NAMES NO MAILBOX ON AN INSTALL WITH SEVERAL ASKS WHICH. The stage took the install's
 * first row, so after a refused first door under one address and a successful one under another,
 * the consent landed on the refused attempt's bare row and the connected mailbox stayed
 * unconsented. Read off the rendered screen: the choice, each press naming its own mailbox, no
 * connect form and no consent. The one-row run keeps its row (the control).
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const t = messages.onboarding;

const ROWS = [
  { id: "mb-refused", address: "box1@home.arpa" },
  { id: "mb-connected", address: "box2@home.arpa" },
];

/** What the shell hands the stage for a `choose` run: no mailbox, the account never set up. */
const unnamed = (): OnboardingFacts => ({
  door: "local",
  mailbox: null,
  account: { onboardingCompletedAt: null },
  ai: "unset",
  queuedSenders: 0,
});

const roots: Root[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.unmount();
  document.body.innerHTML = "";
});

async function mount(o: { choices?: typeof ROWS }) {
  const connects: Array<{ input: FirstRunMailboxInput; mode: "seed" | "add" }> = [];
  const organized: string[] = [];
  const chosen: string[] = [];
  let leaves = 0;
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  const host: FirstRunHost = {
    door: "local",
    ai: "unset",
    probe: async () => ({ host: "h", user: "u", folders: 1 }),
    connect: async (input, mode) => { connects.push({ input, mode }); return { id: "mb-new" }; },
    organize: async (id) => { organized.push(id); return "stored"; },
    complete: async () => { /* leaves */ },
    setAiEnabled: async () => { /* answered */ },
    forgetMailbox: async () => { /* removed */ },
    probeReason: () => null,
    probeMessage: () => null,
  };
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(KeymapProvider, {
        children: h(FirstRun, {
          host,
          facts: unnamed(),
          onRefresh: () => { /* nothing moves here */ },
          onLeave: () => { leaves += 1; },
          pull: { screened: 0, history: 0, pulled: 0 },
          decide: null,
          mailboxId: null,
          ...(o.choices ? { subjectChoices: o.choices, onChooseMailbox: (id: string) => { chosen.push(id); } } : {}),
        }),
      }),
    }));
  });
  const buttons = () => [...el.querySelectorAll("button")];
  return {
    el, connects, organized, chosen,
    left: () => leaves,
    heading: () => (el.querySelector("h1")?.textContent ?? "").trim(),
    press: async (label: string) => {
      /* The label without the key hint the primary verb carries in its own <kbd>. */
      const said = (x: HTMLButtonElement) => [...x.childNodes]
        .filter((n) => !(n instanceof HTMLElement && n.tagName === "KBD")).map((n) => n.textContent ?? "").join("").trim();
      const b = buttons().filter((x) => said(x) === label);
      expect(b.length, `one button saying ${label}`).toBe(1);
      await act(async () => { b[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    },
  };
}

describe("a first run that names no mailbox, on an install holding several", () => {
  it("the subject is `choose`, never the first row", () => {
    expect(firstRunSubject(ROWS, null, false)).toEqual({ mailbox: null, state: "choose" });
    // The control: one row and no name is still that row.
    expect(firstRunSubject(ROWS.slice(1), null, false)).toEqual({ mailbox: ROWS[1], state: "mailbox" });
  });

  it("asks which, and each press names its own mailbox", async () => {
    const s = await mount({ choices: ROWS });
    expect(s.heading()).toBe(t.chooseTitle);
    await s.press("box2@home.arpa");
    await s.press("box1@home.arpa");
    expect(s.chosen).toEqual(["mb-connected", "mb-refused"]);
  });

  it("offers no connect form and writes no consent — and leaving is live", async () => {
    const s = await mount({ choices: ROWS });
    expect(s.el.querySelector("input"), "a field on the choice screen").toBeNull();
    expect(s.connects).toEqual([]);
    expect(s.organized).toEqual([]);
    await s.press(t.chooseLeave);
    expect(s.left()).toBe(1);
  });

  it("answers `choose` from every cursor value, ahead of the derivation", () => {
    const steps: Array<OnboardingStep | null> = [
      null, "welcome", "mailbox", "consent", "window", "ai", "provider", "pull", "decide", "summary", "pair",
    ];
    for (const at of steps) {
      expect(firstRunStep(unnamed(), at, false, false, false, null, false, false, true), String(at)).toBe("choose");
    }
  });

  it("POSITIVE CONTROL — the same unnamed run with no choice to make is the first run it always was", async () => {
    const s = await mount({});
    expect(s.heading()).not.toBe(t.chooseTitle);
  });
});
