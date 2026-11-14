/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FirstRun } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import type { OnboardingDoor, OnboardingFacts } from "@ohmail/app-logic/doors/onboarding";

/**
 * "HOW FAR BACK" PRE-SELECTS THE ROW THAT CALLS ITSELF THE USUAL ONE.
 *
 * The reported contradiction, driven on three renders: the control pre-selected "90 days" while
 * the row beside it read "One year · usual". Nobody had chosen 90. It was the PRODUCT default
 * (60 days) being handed to the screen as though it were the person's answer, and
 * `initialWindow` snapping a stored 60 to the nearest rung it offers — 60 is nearer 90 than 365.
 * So the screen reported a default as a decision, and disagreed with its own label while doing
 * it.
 *
 * Both halves are fixed and neither was watched from the OUTSIDE. `first-run-stage.test.ts`
 * drives `initialWindow` directly (right, and it cannot see a component), and pins the shell's
 * conditional hand-off with a regex over `AppShell.tsx`'s source (real, and it is a source pin:
 * it holds the shape of one expression, not what a person meets). What was missing is the
 * screen: with nothing stored, is the default window the row that is checked, and is it the row wearing the
 * word "usual"?
 *
 * ── THE PAIR THAT TELLS THE TWO BEHAVIOURS APART ────────────────────────────────────────────
 *
 * "Pre-select 365" and "keep the current value after a choice" are two rules, and a fixture that
 * only ever omits the stored window measures the first while looking like it measures both. So
 * the same account is driven twice — once with nothing stored (365, and it says usual) and once
 * with 90 stored (90, and the label moves with it) — plus the case that explains why the shell
 * has to WITHHOLD rather than pass the resting values: handed a stored 60, this screen correctly
 * snaps to 90, which is the number the person was shown and had not picked.
 *
 * ALL THREE DOORS ARE DRIVEN, because the row names two of them: the standalone install — which
 * is `door: "local"`, and where a re-run is the only way in at all — and a fresh self-host
 * account (`"selfhost"`). The first draft of this file invented a door called `"standalone"` from
 * the row's own wording; `OnboardingDoor` is `"local" | "cloud" | "selfhost"` and the webapp
 * typechecks its tests, so it said so.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const t = messages.onboarding;

const CONNECTED = {
  organizerRole: "organizer" as const,
  organizedBy: null,
  organizerState: null,
  organizeConsentedAt: null as string | null,
  initialImportCompletedAt: null as string | null,
};

/** An account that has been through setup — the state a re-run is about. */
const finished = (door: OnboardingDoor): OnboardingFacts => ({
  door,
  mailbox: {
    ...CONNECTED,
    organizeConsentedAt: "2026-03-01T10:00:00.000Z",
    initialImportCompletedAt: "2026-03-01T11:00:00.000Z",
  },
  account: { onboardingCompletedAt: "2026-03-01T11:30:00.000Z" },
  ai: "off",
  queuedSenders: 0,
});

const roots: Root[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.unmount();
  document.body.innerHTML = "";
});

interface Stage {
  el: HTMLElement;
  press: (label: string) => Promise<void>;
  /** A re-render WITHOUT a remount — what the shell does when the facts come back. */
  rerender: () => Promise<void>;
  heading: () => string;
  /** The value of the checked rung, or null when the control shows no selection at all. */
  checked: () => string | null;
  /** The visible label of the checked rung ("One year · usual"). */
  checkedLabel: () => string;
  stored: Array<{ dormancyDays?: number; scope?: "window" | "all_time" }>;
}

/**
 * `screening` is passed only when the caller says so — which is the WHOLE POINT of this file.
 * The harness in `first-run-rerun-loop.test.tsx` hands it unconditionally, which is a fine
 * fixture for what that file is about and is exactly the shape of the shipped defect.
 */
async function mount(o: {
  door?: OnboardingDoor;
  screening?: { dormancyDays: number; scope: "window" | "all_time" };
}): Promise<Stage> {
  const stored: Stage["stored"] = [];
  const door = o.door ?? "cloud";
  let facts = finished(door);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);

  const host: FirstRunHost = {
    door,
    ai: "off",
    probe: async () => ({ host: "h", user: "u", folders: 1 }),
    connect: async () => ({ id: "mb-1" }),
    organize: async (_id, body) => {
      if (body.screening) stored.push(body.screening);
      facts = { ...facts, mailbox: { ...facts.mailbox!, organizeConsentedAt: "2026-09-02T09:00:00.000Z" } };
      return "stored";
    },
    complete: async () => {},
    setAiEnabled: async () => {},
    probeReason: () => null,
    probeMessage: () => null,
  };

  let bump: (() => void) | null = null;
  const Host = () => {
    const [, set] = React.useState(0);
    bump = () => set((n) => n + 1);
    return h(FirstRun, {
      host,
      facts,
      onRefresh: () => set((n) => n + 1),
      onLeave: () => {},
      pull: { screened: 0, history: 0, pulled: 0 },
      decide: null,
      mailboxId: "mb-1",
      rerun: true,
      /* Absent means "nothing was ever chosen" — see `FirstRunProps.screening`. */
      ...(o.screening ? { screening: o.screening } : {}),
    });
  };

  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(KeymapProvider, { children: h(Host, null) }),
    }));
  });

  const press = async (label: string) => {
    const button = [...el.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").trim().startsWith(label));
    if (!button) {
      throw new Error(`no button labelled ${JSON.stringify(label)}; saw: `
        + [...el.querySelectorAll("button")].map((b) => JSON.stringify(b.textContent)).join(", "));
    }
    await act(async () => { (button as HTMLButtonElement).click(); });
  };

  const rungs = (): HTMLInputElement[] =>
    [...el.querySelectorAll<HTMLInputElement>("input[type=radio]")];

  return {
    el, press, stored,
    rerender: async () => { await act(async () => { bump?.(); }); },
    heading: () => (el.querySelector("h1")?.textContent ?? "").trim(),
    checked: () => rungs().find((i) => i.checked)?.value ?? null,
    checkedLabel: () => {
      const on = rungs().find((i) => i.checked);
      return (on?.closest("label")?.querySelector("b")?.textContent ?? "").trim();
    },
  };
}

/** Walk the re-run from its opening screen to "How far back". */
async function toWindow(s: Stage): Promise<void> {
  expect(s.heading(), "the re-run did not open on the consent statement").toBe(t.consentTitle);
  await s.press(t.continue);
  expect(s.heading(), "Continue did not reach the window screen").toBe(t.windowTitle);
}

describe("the window screen agrees with its own label", () => {
  it("nothing ever chosen: 365 is checked, and 365 is the row that says usual", async () => {
    const s = await mount({});
    await toWindow(s);

    expect(s.checked(), "the pre-selected rung").toBe("365");
    /* THE CONTRADICTION, in one assertion: the checked row must be the one carrying the word.
       Reading the value alone would pass a build that moved the label to another rung. */
    expect(s.checkedLabel()).toContain(t.winDefault);
    expect(s.checkedLabel()).toBe(`${t.win365} · ${t.winDefault}`);
  });

  it("…on the standalone install too, where a re-run is the only way in", async () => {
    const s = await mount({ door: "local" });
    await toWindow(s);
    expect(s.checked()).toBe("365");
    expect(s.checkedLabel()).toContain(t.winDefault);
  });

  it("…and on a self-host account, the other door the row names", async () => {
    const s = await mount({ door: "selfhost" });
    await toWindow(s);
    expect(s.checked()).toBe("365");
    expect(s.checkedLabel()).toContain(t.winDefault);
  });

  it("a real choice is kept: 90 stored opens on 90, and the label moves off it", async () => {
    const s = await mount({ screening: { dormancyDays: 90, scope: "window" } });
    await toWindow(s);

    expect(s.checked()).toBe("90");
    expect(s.checkedLabel()).toBe(t.win90);
    /* The usual-row label stays where it belongs rather than following the selection —
       "usual" is a fact about the product, not about this account. */
    expect(s.checkedLabel()).not.toContain(t.winDefault);
  });

  it("all-time stored opens on all-time", async () => {
    const s = await mount({ screening: { dormancyDays: 90, scope: "all_time" } });
    await toWindow(s);
    expect(s.checked()).toBe("all");
  });

  it("A STORED 60 SNAPS TO 90 — which is why the shell must withhold, not pass the resting values", async () => {
    /* This case is the DEFECT, reproduced deliberately, and it is here so the fix cannot be
       misread as "initialWindow got kinder". The snap is correct: 60 is not a rung this control
       offers, and 60 is nearer 90 than 365. What was wrong is that the shell handed 60 over on
       every run because it rests there. Withheld, the same screen answers 365 — the case at the
       top of this file — and the two together are what tell the halves apart. */
    const s = await mount({ screening: { dormancyDays: 60, scope: "window" } });
    await toWindow(s);
    expect(s.checked()).toBe("90");
    expect(s.checkedLabel()).not.toContain(t.winDefault);
  });
});

describe("a pick survives", () => {
  it("choosing 90 on a fresh screen holds across a re-render, and it is 90 that gets stored", async () => {
    const s = await mount({});
    await toWindow(s);
    expect(s.checked()).toBe("365");

    const ninety = [...s.el.querySelectorAll<HTMLInputElement>("input[type=radio]")]
      .find((i) => i.value === "90");
    expect(ninety, "the screen offers no 90-day rung").toBeDefined();
    await act(async () => { ninety!.click(); });
    expect(s.checked()).toBe("90");

    /* A RE-RENDER, NOT A REMOUNT. The shell re-renders this stage whenever the facts come back,
       and a screen that re-derived its value from the props on every render would silently drop
       the pick here and store the default instead. */
    await s.rerender();
    expect(s.checked(), "the pick did not survive a re-render").toBe("90");

    await s.press(t.agree);
    expect(s.stored).toEqual([{ dormancyDays: 90, scope: "window" }]);
  });

  it("and the untouched screen stores the 365 it was showing — the positive control", async () => {
    /* Without this, every case above is about what is CHECKED and none about what is written.
       A build that displayed 365 and stored the resting default would pass all of them. */
    const s = await mount({});
    await toWindow(s);
    await s.press(t.agree);
    expect(s.stored).toEqual([{ dormancyDays: 365, scope: "window" }]);
  });
});
