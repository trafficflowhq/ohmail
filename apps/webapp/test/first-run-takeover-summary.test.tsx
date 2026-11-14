/** @vitest-environment jsdom */
import { describe, expect, it, afterEach } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { FirstRun, type FirstRunDecideSubject } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import { takeoverState } from "@ohmail/app-logic/reading/reader-holder";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import type { OnboardingFacts, OnboardingMailbox } from "@ohmail/app-logic/doors/onboarding";

/**
 * DONE SAYS THE TAKEOVER THAT IS UNDER WAY, AND THE FIRST DECISION REACHES ITS HOST
 * After "Organize here instead" and Agree, the summary read "It reads this mailbox …
 * You can organize from here later" until the claim landed, up to 80 s later. `takeoverState`
 * reads the row: asked while the stamp stands, landed once the row says organizer, refused once
 * the gate spent the stamp and the row stayed a reader. HOW TO WATCH IT FAIL: make
 * `takeoverState` answer `null` — the asked and refused cases go red.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const t = messages.onboarding;
const HOLDER = "W-old";
const SENDER = "Bea";
const STAMP = "2026-09-26T05:30:00.000Z";

const READER: OnboardingMailbox = {
  organizerRole: "reader",
  organizedBy: { kind: "local", name: HOLDER, since: "2026-09-14T09:00:00.000Z" },
  organizerState: "stopped",
  organizerEventAt: "2026-09-14T09:00:00.000Z",
  organizeConsentedAt: null,
  initialImportCompletedAt: "2026-09-26T05:00:00.000Z",
  takeoverAuthorizedAt: null,
};

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => { for (const r of roots.splice(0)) r.unmount(); });
  document.body.innerHTML = "";
});

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
}

async function mount() {
  let current: OnboardingFacts = {
    door: "local", mailbox: READER, account: { onboardingCompletedAt: null }, ai: "off", queuedSenders: 1,
  };
  const decisions: string[] = [];
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  let bump: (() => void) | null = null;
  const host: FirstRunHost = {
    door: "local",
    ai: current.ai,
    probe: async () => ({ host: "h", user: "u", folders: 1 }),
    connect: async () => ({ id: "mb-1" }),
    // The door's answer to Agree: consent and the takeover stamp, one statement; the role waits.
    organize: async () => {
      current = { ...current, mailbox: { ...current.mailbox!, organizeConsentedAt: STAMP, takeoverAuthorizedAt: STAMP } };
      return "stored";
    },
    complete: async () => { /* stamped */ },
    setAiEnabled: async () => { /* answered */ },
    probeReason: () => null,
    probeMessage: () => null,
  };
  const decide: FirstRunDecideSubject = {
    name: SENDER, address: "bea@example.test", held: 6, waiting: 1, since: "6 waiting",
    onDecide: (dest) => { decisions.push(dest); },
  };
  const Stage = () => {
    const [, set] = React.useState(0);
    bump = () => set((n) => n + 1);
    return h(FirstRun, {
      host, facts: current, onRefresh: () => bump?.(), onLeave: () => { /* left */ },
      pull: { screened: 0, history: 0, pulled: 0 }, decide, mailboxId: "mb-1",
      organizedSince: "14 Sept 2026",
    });
  };
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(KeymapProvider, { children: h(Stage, null) }),
    }));
  });
  return {
    heading: () => (el.querySelector("h1")?.textContent ?? "").trim(),
    text: () => el.textContent ?? "",
    press: async (label: string) => {
      const button = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(label));
      if (!button) throw new Error(`no button labelled ${JSON.stringify(label)}`);
      await act(async () => { button.click(); for (let i = 0; i < 12; i++) await Promise.resolve(); });
    },
    key: async (key: string) => {
      await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
      await settle();
    },
    /** A later read of the row, as the shell's poll delivers it. */
    read: async (over: Partial<OnboardingMailbox>) => {
      current = { ...current, mailbox: { ...current.mailbox!, ...over } };
      await act(async () => { bump?.(); });
      await settle();
    },
    decisions,
  };
}

/** Organize here instead → consent → Agree → the guided decision, Ohbox by its key. */
async function walkToDone() {
  const s = await mount();
  expect(s.heading()).toBe(t.elsewhereTitleStopped);
  await s.press(t.continue);
  expect(s.heading()).toBe(t.consentTitle);
  await s.press(t.continue);
  expect(s.heading()).toBe(t.windowTitle);
  await s.press(t.agree);
  expect(s.heading()).toBe(t.decideTitle);
  await s.key("o");
  return s;
}

describe("Done on the takeover path", () => {
  it("ASKED: the takeover is under way, and the decision reached the host", async () => {
    const s = await walkToDone();
    expect(s.decisions, "the guided press did not reach onDecide").toEqual(["ohbox"]);
    expect(s.text()).toContain(t.doneTakeoverLands);
    expect(s.text()).toContain(t.doneTakeoverDecided.replace("{name}", SENDER));
    expect(s.text()).toContain(t.doneTakeoverDecidedWhy);
    expect(s.text(), "Done said this computer only reads").not.toContain(t.doneReaderReads);
    expect(s.text(), "Done sent the person to Settings to ask again").not.toContain(t.doneReaderClaim);
  });

  it("LANDED: today's organizing summary, by itself", async () => {
    const s = await walkToDone();
    await s.read({ organizerRole: "organizer", takeoverAuthorizedAt: null, organizerEventAt: "2026-09-26T05:31:00.000Z" });
    expect(s.heading()).toBe(t.doneTitle);
    expect(s.text()).not.toContain(t.doneTakeoverLands);
  });

  it("REFUSED: the refusal is said, with who kept the mailbox", async () => {
    const s = await walkToDone();
    await s.read({
      takeoverAuthorizedAt: null, organizerEventAt: "2026-09-26T05:31:00.000Z",
      organizedBy: { kind: "local", name: "Studio", since: "2026-09-26T05:31:00.000Z" }, organizerState: "held",
    });
    expect(s.text()).toContain(t.doneTakeoverRefused.replace("{name}", "Studio"));
    expect(s.text()).not.toContain(t.doneTakeoverLands);
  });
});

/* TAKEOVER-REFUSED-KEEPS-A-LOCAL-RULE: the decision pressed while the takeover stood was a rule on
   this install only, and the refusal left it there. It is pressed again, once, so the Screener's
   door asks the holder that kept the mailbox. To watch it fail: drop the refused effect's `again()`. */
describe("a refused takeover sends the decision to the holder that kept the mailbox", () => {
  const REFUSED = {
    takeoverAuthorizedAt: null, organizerEventAt: "2026-09-26T05:31:00.000Z",
    organizedBy: { kind: "local", name: "Studio", since: "2026-09-26T05:31:00.000Z" }, organizerState: "held" as const,
  };

  it("the same decision is asked again once, and Done says where it went", async () => {
    const s = await walkToDone();
    expect(s.decisions).toEqual(["ohbox"]);
    await s.read(REFUSED);
    expect(s.decisions, "the refused takeover kept the decision as a local rule only").toEqual(["ohbox", "ohbox"]);
    expect(s.text()).toContain(t.doneTakeoverReasked.replace("{name}", SENDER));
    await s.read({ organizerEventAt: "2026-09-26T05:32:00.000Z" });
    expect(s.decisions, "a later poll asked a second time").toEqual(["ohbox", "ohbox"]);
  });

  it("CONTROL: a takeover that lands or is still asked asks nothing again", async () => {
    const landed = await walkToDone();
    await landed.read({ organizerRole: "organizer", takeoverAuthorizedAt: null, organizerEventAt: "2026-09-26T05:31:00.000Z" });
    expect(landed.decisions).toEqual(["ohbox"]);
    expect(landed.text()).not.toContain(t.doneTakeoverReasked.replace("{name}", SENDER));
    const asked = await walkToDone();
    await asked.read({ organizerEventAt: "2026-09-26T05:29:00.000Z" });
    expect(asked.decisions).toEqual(["ohbox"]);
  });

  it("both catalogues carry the sentence, naming the sender", () => {
    expect(t.doneTakeoverReasked).toContain("{name}");
    expect(de.onboarding.doneTakeoverReasked).toContain("{name}");
    expect(t.doneTakeoverReaskedWhy).toBeTruthy();
    expect(de.onboarding.doneTakeoverReaskedWhy).toBeTruthy();
  });
});

describe("takeoverState reads the row", () => {
  const asked = { floor: STAMP };
  it("asked, landed, refused, and a read from before the press", () => {
    expect(takeoverState({ organizerRole: "reader", takeoverAuthorizedAt: STAMP }, asked)).toBe("asked");
    expect(takeoverState({ organizerRole: "organizer", takeoverAuthorizedAt: null }, asked)).toBe("landed");
    expect(takeoverState({ organizerRole: "reader", takeoverAuthorizedAt: null, organizerEventAt: "2026-09-26T05:31:00.000Z" }, asked))
      .toBe("refused");
    expect(takeoverState({ organizerRole: "reader", takeoverAuthorizedAt: null, organizerEventAt: "2026-09-14T09:00:00.000Z" }, asked),
      "a stale read is not a refusal").toBe("asked");
  });
  it("CONTROL: a run that asked for nothing has no takeover state", () => {
    expect(takeoverState({ organizerRole: "reader", takeoverAuthorizedAt: STAMP }, null)).toBeNull();
  });
  it("both catalogues carry the five sentences, with {name} where they name somebody", () => {
    for (const k of ["doneTakeoverLands", "doneTakeoverLandsWhy", "doneTakeoverDecided", "doneTakeoverDecidedWhy", "doneTakeoverRefused"] as const) {
      expect(t[k], `en ${k}`).toBeTruthy();
      expect(de.onboarding[k], `de ${k}`).toBeTruthy();
    }
    for (const k of ["doneTakeoverDecided", "doneTakeoverRefused"] as const) {
      expect(t[k]).toContain("{name}");
      expect(de.onboarding[k]).toContain("{name}");
    }
  });
});
