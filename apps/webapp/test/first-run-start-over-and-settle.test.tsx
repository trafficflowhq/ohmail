/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FirstRun, nextStep } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import { onboardingPath, type OnboardingFacts, type OnboardingStep } from "@ohmail/app-logic/doors/onboarding";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";

/**
 * ═══ START OVER LEAVES A LIVE CONTROL, AND A WRITE NEVER PAINTS THE STATE BEFORE IT ════════
 *
 * ── START OVER (WIZARD-START-OVER-INTRO-CONTROL-DEAD) ──────────────────────────────────────
 *
 * Settings → Mailboxes → Add mailbox → "Start over" landed on a first-run intro whose single
 * control did nothing: five drivers on the Omarchy guest, one outcome, and only a restart got out.
 * The mechanism is two lines: the foot sent the cursor to `welcome` BY NAME, and `onboardingPath`
 * drops `welcome` for an ADD run — so `indexOf` answered -1 and the forward verb computed
 * `undefined`. Not a wedged process and not a hit-test miss: the press arrived and there was
 * nowhere for it to go.
 *
 * ── THE WRITE (E2-WRITE-SHOWS-PRE-WRITE-STATE) ─────────────────────────────────────────────
 *
 * `run()` cleared the cursor and dropped `busy` before the fire-and-forget `onRefresh()` had
 * answered, so the derivation got one render over the facts from BEFORE the write — a successful
 * create deriving back to `facts.mailbox === null`, which is the connect form it had just
 * completed. Record, then paint: the re-read is awaited and the cursor moves after it.
 *
 * MUTATIONS WATCHED RED, EACH RESTORED BY `cmp`:
 *  · `goTo(path[0] ?? "mailbox")` in the foot → `goTo("welcome")`  → the add-run cases;
 *  · `nextStep`'s `path[0]` fallback → `undefined`                 → the off-path table;
 *  · `await settle()` moved back under `finally`                   → the settle case.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const t = messages.onboarding;

/** An install that has been through setup, adding a second mailbox: no row yet, no welcome. */
const addRun = (): OnboardingFacts => ({
  door: "local",
  mailbox: null,
  account: { onboardingCompletedAt: "2026-03-01T11:30:00.000Z" },
  ai: "on",
  queuedSenders: 0,
});

const roots: Root[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.unmount();
  document.body.innerHTML = "";
});

interface Harness {
  el: HTMLElement;
  heading: () => string;
  text: () => string;
  press: (label: string) => Promise<void>;
  has: (label: string) => boolean;
}

async function mount(o: {
  facts: OnboardingFacts;
  add?: boolean;
  mailboxId?: string | null;
}): Promise<Harness> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  let facts = o.facts;

  const host: FirstRunHost = {
    door: o.facts.door,
    ai: o.facts.ai,
    probe: async () => ({ host: "h", user: "u", folders: 1 }),
    connect: async () => ({ id: "mb-new" }),
    organize: async () => "stored",
    complete: async () => { /* leaves */ },
    setAiEnabled: async () => { /* answered */ },
    forgetMailbox: async () => { facts = { ...facts, mailbox: null }; },
    probeReason: () => null,
    probeMessage: () => null,
  };

  const Stage = () => {
    const [, bump] = React.useState(0);
    return h(FirstRun, {
      host,
      facts,
      onRefresh: () => { bump((n) => n + 1); },
      onLeave: () => { /* the caller returns the route to the app */ },
      pull: { screened: 0, history: 0, pulled: 0 },
      decide: null,
      mailboxId: o.mailboxId ?? null,
      ...(o.add ? { add: true } : {}),
    });
  };

  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(KeymapProvider, { children: h(Stage, null) }),
    }));
  });

  const find = (label: string) => [...el.querySelectorAll("button")]
    .find((b) => (b.textContent ?? "").trim().startsWith(label));
  return {
    el,
    heading: () => (el.querySelector("h1")?.textContent ?? "").trim(),
    text: () => (el.textContent ?? "").replace(/\s+/g, " "),
    has: (label) => find(label) !== undefined,
    press: async (label) => {
      const b = find(label);
      if (!b) {
        throw new Error(`no button labelled ${JSON.stringify(label)}; saw: `
          + [...el.querySelectorAll("button")].map((x) => JSON.stringify(x.textContent)).join(", "));
      }
      await act(async () => {
        b.click();
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });
    },
  };
}

describe("Start over on an add run", () => {
  it("the walk it lands on is one this run HAS — the connect form, not an intro", async () => {
    const s = await mount({ facts: addRun(), add: true });
    expect(s.heading()).toBe(t.mailboxTitle);
    await s.press(t.restart);
    // The screen after the press, and it may not be the one the walk dropped.
    expect(s.text()).not.toContain(t.welcomeTitle);
    expect(s.heading()).toBe(t.mailboxTitle);
  });

  it("THE CONTROL IS LIVE — the press reaches a form that can be filled in and sent", async () => {
    const s = await mount({ facts: addRun(), add: true });
    await s.press(t.restart);
    // "Set up a mailbox" is the intro's single control and the intro is what must not be here.
    expect(s.has(t.welcomeStart), "the dead intro control is on screen").toBe(false);
    // What IS here is the form's own verb, over fields a person can answer.
    expect(s.el.querySelector("input[type=email]")).not.toBeNull();
    expect(s.has(t.connect), "the connect verb is missing").toBe(true);
  });

  it("POSITIVE CONTROL — a FIRST run's Start over still lands on its welcome, which it has", async () => {
    const s = await mount({
      facts: { ...addRun(), account: { onboardingCompletedAt: null }, ai: "unset" },
    });
    // The welcome carries no foot, so walk onto the form — which is where the verb lives.
    expect(s.heading()).toBe(t.welcomeTitle);
    await s.press(t.welcomeStart);
    expect(s.heading()).toBe(t.mailboxTitle);
    await s.press(t.restart);
    expect(s.heading()).toBe(t.welcomeTitle);
    // And there the control is live, because `welcome` IS on a first run's walk.
    await s.press(t.welcomeStart);
    expect(s.heading()).toBe(t.mailboxTitle);
  });
});

describe("nextStep — a step outside the walk still has somewhere to go", () => {
  const add = onboardingPath(addRun(), true);
  const first = onboardingPath({ ...addRun(), ai: "unset" }, false);

  it("the ADD walk really does drop `welcome` — the premise of the whole row", () => {
    expect(add).not.toContain("welcome");
    expect(first).toContain("welcome");
    expect(add[0]).toBe("mailbox");
  });

  it("an off-path step goes to the walk's START rather than nowhere", () => {
    expect(nextStep(add, "welcome")).toBe("mailbox");
    // Every step the union has, asked of a walk that may not hold it: never `undefined` unless it
    // is genuinely last.
    const EVERY: OnboardingStep[] = [
      "welcome", "vanished", "mailbox", "elsewhere", "consent", "window",
      "ai", "provider", "pull", "decide", "summary", "pair",
    ];
    for (const step of EVERY) {
      const next = nextStep(add, step);
      if (step === add[add.length - 1]) expect(next).toBeUndefined();
      else expect(next, `${step} has no next on the add walk`).not.toBeUndefined();
    }
  });

  it("an ON-path step still walks forward one, and the last one stops", () => {
    expect(nextStep(first, "welcome")).toBe("mailbox");
    expect(nextStep(first, "mailbox")).toBe("consent");
    expect(nextStep(first, first[first.length - 1]!)).toBeUndefined();
  });
});

describe("a successful write never paints the state from before it", () => {
  it("the create's re-read is AWAITED — the form does not come back", async () => {
    /* The shell's real behaviour in the smallest shape that reproduces it, with ONE change that
       makes the window observable: the re-read is a promise this case holds open. React's async
       `act` turns the event loop on its way out, so a read that answers on a timer has already
       landed by the time an awaited press returns, and both behaviours look identical; a read
       that has not answered YET is the state the row is about, and it is also the state a slow
       or failing round trip really is in. */
    let created = false;
    let release: (() => void) | undefined;
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    roots.push(root);
    let facts: OnboardingFacts = { ...addRun(), account: { onboardingCompletedAt: null }, ai: "on" };

    const host: FirstRunHost = {
      door: "local",
      ai: "on",
      probe: async () => ({ host: "h", user: "u", folders: 1 }),
      connect: async () => { created = true; return { id: "mb-new" }; },
      organize: async () => "stored",
      complete: async () => {},
      probeReason: () => null,
      probeMessage: () => null,
    };

    const Stage = () => {
      const [, bump] = React.useState(0);
      return h(FirstRun, {
        host,
        facts,
        /* THE READ, AS A PROMISE — what `MailStateProvider.refresh` now answers with. */
        onRefresh: () => new Promise<void>((resolve) => {
          release = () => {
            if (created) {
              facts = {
                ...facts,
                mailbox: {
                  organizerRole: "organizer", organizedBy: null, organizerState: null,
                  organizeConsentedAt: null, initialImportCompletedAt: null,
                },
              };
            }
            bump((n) => n + 1);
            resolve();
          };
        }),
        onLeave: () => {},
        pull: { screened: 0, history: 0, pulled: 0 },
        decide: null,
        mailboxId: created ? "mb-new" : null,
        add: true,
      });
    };

    await act(async () => {
      root.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC",
        children: h(KeymapProvider, { children: h(Stage, null) }),
      }));
    });

    const button = (label: string) => [...el.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").trim().startsWith(label));
    const heading = () => (el.querySelector("h1")?.textContent ?? "").trim();
    const labels = () => [...el.querySelectorAll("button")]
      .map((b) => (b.textContent ?? "").trim()).join(" | ");
    expect(heading()).toBe(t.mailboxTitle);

    // Prove the login first — the form's primary is armed by the verdict, as a person's is.
    await act(async () => {
      button(t.test)!.click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });

    // The press. The create answers; the read does not, and will not until this case says so.
    await act(async () => {
      button(t.connect)!.click();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });

    expect(created, "the create never happened — this case measures nothing").toBe(true);
    expect(release, "the stage never asked for a re-read").not.toBeUndefined();
    /* THE WINDOW. An armed "Connect and continue" here is the pre-write state back on screen and
       pressable, over facts that do not hold the mailbox the person has just made. */
    expect(labels(), "the write let go of the screen before its read had answered")
      .not.toContain(t.connect);
    expect(labels()).toContain(t.connecting);

    // Now the read answers, and the flow moves on — to the next thing the new mailbox needs.
    await act(async () => {
      release!();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    expect(heading(), "the flow went back to the form it had just completed").not.toBe(t.mailboxTitle);
    expect(heading()).toBe(t.consentTitle);
  });
});
