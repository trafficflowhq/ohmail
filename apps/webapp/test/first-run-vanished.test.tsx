/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { firstRunStep } from "@ohmail/app-logic/mailboxes/first-run/step";
import type { OnboardingFacts, OnboardingStep } from "@ohmail/app-logic/doors/onboarding";
import type { FirstRunRow } from "@ohmail/app-logic/mailboxes/first-run/ground";
import { O, fakeDoor, id } from "../../../packages/app/test/mailboxes/connect/support.js";
import { mountStage } from "./_first-run-stage.js";

/**
 * ═══ A RE-RUN ABOUT A MAILBOX THAT IS GONE SAYS SO — IT DOES NOT OFFER A CONNECT FORM ══════
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────
 *
 * `#/first-run/again?mailbox=<id>` resolves to no mailbox when the row leaves the facts — a removal
 * from another surface, a failing `GET /mailboxes`, or this flow's own "Start over → forget this
 * mailbox". `firstRunStep`'s re-run arm answered `mailbox` for a null mailbox; the mailbox step is a
 * FORM; and its connect mode is `seed`, because `add === true` is the only thing that selects `add`.
 * So a re-run on an install that still holds mailboxes offered a form that RECONFIGURES the install
 * — on the standalone door, `engine_configure` onto whatever was typed.
 *
 * ── WHAT IS MEASURED HERE ──────────────────────────────────────────────────────────────────
 *
 * The refusal is read off the RENDERED screen; the absence of the form is read the same way (no
 * address field, no password field, no connect verb), and the door's `connect` is a spy that must
 * never be called. The "by any path" half is a table over `firstRunStep` with every cursor value
 * the union has, because a cursor is the one way a screen is reached without the derivation.
 *
 * MUTATION WATCHED RED: `if (vanished) return "vanished";` removed from `firstRunStep` — the
 * heading case, the no-form case and the every-cursor case all go red, by name.
 * POSITIVE CONTROL: the same re-run with its row PRESENT opens on the consent statement, and a
 * first run with no mailbox anywhere still gets the form it exists to show.
 *
 * RE-POINTED (the switch's older tests, sorted once): the run is the new frame's first-run stage
 * (`_first-run-stage.tsx`) at the address that names the mailbox; "the row left the facts" is the
 * ground handing no row of that id; the door's `connect` is the connect wire's, a spy; leaving is the frame's address
 * moving to its place; the progress rail is the kit's step dots. `firstRunStep` is the stage's own
 * (`@ohmail/app-logic/mailboxes/first-run/step`). Every expectation is as it stood.
 */

const t = O;

const CONNECTED = {
  organizerRole: "organizer" as const,
  organizedBy: null,
  organizerState: null,
  organizeConsentedAt: "2026-03-01T10:00:00.000Z" as string | null,
  initialImportCompletedAt: "2026-03-01T11:00:00.000Z" as string | null,
};

/** What the shell hands the stage when the run's row is not in the facts: no mailbox at all. */
const noMailbox = (): OnboardingFacts => ({
  door: "local",
  mailbox: null,
  account: { onboardingCompletedAt: "2026-03-01T11:30:00.000Z" },
  ai: "on",
  queuedSenders: 0,
});

/** The same re-run with its row present — the control. */
const held = (): OnboardingFacts => ({ ...noMailbox(), mailbox: { ...CONNECTED } });

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

interface Harness {
  el: HTMLElement;
  connects: unknown[];
  left: () => number;
  heading: () => string;
  text: () => string;
  buttons: () => HTMLButtonElement[];
}

async function mount(o: {
  facts: OnboardingFacts;
  subjectVanished?: boolean;
  rerun?: boolean;
  mailboxId?: string | null;
}): Promise<Harness> {
  /* THE CALL THE DEFECT ENDS IN. A `seed` here is the install reconfigured. */
  const wire = fakeDoor();
  const rows: FirstRunRow[] = o.facts.mailbox === null ? [] : [{ id: id("mb-1"), address: "me@example.invalid", ...o.facts.mailbox } as FirstRunRow];
  /* The run names its mailbox in its address; a vanished subject is a name the rows do not hold. */
  const named = o.subjectVanished ? "mb-gone" : o.mailboxId ?? null;
  const at = o.rerun ? `#/first-run/again${named ? `?mailbox=${named}` : ""}` : "#/first-run";
  const st = await mountStage({
    rows,
    at,
    door: o.facts.door,
    account: o.facts.account,
    connect: wire.door,
    verbs: {
      ai: o.facts.ai,
      organize: async () => "stored",
      complete: async () => { /* leaves */ },
      setAiEnabled: async () => { /* answered */ },
      forgetMailbox: async () => { /* removed */ },
    },
  });
  const el = st.el;
  const first = st.address();
  return {
    el,
    get connects() { return wire.of("connect"); },
    left: () => (st.address() !== first && !st.address().includes("first-run") ? 1 : 0),
    heading: st.heading,
    text: () => (el.textContent ?? "").replace(/\s+/g, " "),
    /* The screen's own controls: the stage's, never the app's behind it (inert while the stage stands). */
    buttons: () => [...(el.querySelector('[role="dialog"]')?.querySelectorAll("button") ?? [])],
  };
}

describe("a re-run whose mailbox has left the facts", () => {
  it("renders the refusal, by name, instead of a setup screen", async () => {
    const s = await mount({ facts: noMailbox(), rerun: true, subjectVanished: true });
    expect(s.heading()).toBe(t.vanishedTitle);
    expect(s.text()).toContain(t.vanishedLead);
  });

  it("THE SEED FORM IS NOT THERE — no fields, no connect verb, and the door is never called", async () => {
    const s = await mount({ facts: noMailbox(), rerun: true, subjectVanished: true });
    expect(s.el.querySelector("input[type=email]"), "the address field is on screen").toBeNull();
    expect(s.el.querySelector("input[type=password]"), "the password field is on screen").toBeNull();
    expect(s.text()).not.toContain(t.connect);
    expect(s.text()).not.toContain(t.mailboxTitle);
    // Every control on this screen, pressed: none of them may reach `connect`.
    for (const b of s.buttons()) await act(async () => { b.click(); });
    expect(s.connects, "a control on the refusal screen reached the door").toEqual([]);
  });

  it("its one control is LIVE and it leaves — a refusal with a dead button is a trap", async () => {
    const s = await mount({ facts: noMailbox(), rerun: true, subjectVanished: true });
    const buttons = s.buttons();
    expect(buttons).toHaveLength(1);
    expect((buttons[0]!.textContent ?? "").trim()).toContain(t.vanishedLeave);
    await act(async () => { buttons[0]!.click(); });
    expect(s.left()).toBe(1);
  });

  it("no progress rail: this run is not on a walk and must not draw one", async () => {
    const s = await mount({ facts: noMailbox(), rerun: true, subjectVanished: true });
    expect(s.el.querySelector(".oh-stepdots"), "the refusal screen drew a rail").toBeNull();
  });
});

describe("and no cursor can walk around it", () => {
  /* Every screen the union has, because a cursor is the one way a step is reached without the
     derivation — and "Start over" writes one. */
  const EVERY: OnboardingStep[] = [
    "welcome", "vanished", "mailbox", "elsewhere", "consent", "window",
    "ai", "provider", "pull", "decide", "summary", "pair",
  ];

  it("answers `vanished` from every cursor value, on a re-run and on an add", () => {
    for (const at of [...EVERY, null]) {
      for (const [rerun, add] of [[true, false], [false, false], [false, true]] as const) {
        expect(
          firstRunStep(noMailbox(), at, rerun, false, add, null, false, true),
          `cursor ${String(at)} rerun=${rerun} add=${add} reached another screen`,
        ).toBe("vanished");
      }
    }
  });

  it("POSITIVE CONTROL — with the row present the same re-run opens on the consent statement", async () => {
    const s = await mount({ facts: held(), rerun: true, mailboxId: "mb-1" });
    expect(s.heading()).toBe(t.consentTitle);
    expect(s.text()).not.toContain(t.vanishedTitle);
  });

  it("POSITIVE CONTROL — a genuine first run still gets the form the refusal replaced", async () => {
    const s = await mount({
      facts: { ...noMailbox(), account: { onboardingCompletedAt: null }, ai: "unset" },
    });
    expect(s.text()).not.toContain(t.vanishedTitle);
    // The welcome, whose one verb walks on to the connect form — the flow this row must not break.
    // The kit draws a title's closing full stop as its end dot: the sentence is the same.
    expect(s.heading()).toBe(t.welcomeTitle.replace(/\.$/, ""));
  });
});
