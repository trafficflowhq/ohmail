/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup } from "@testing-library/react";
import { firstRunSubject } from "@ohmail/app-logic/doors/first-run-subject";
import type { OnboardingFacts, OnboardingStep } from "@ohmail/app-logic/doors/onboarding";
import type { FirstRunRow } from "@ohmail/app-logic/mailboxes/first-run/ground";
import { firstRunStep } from "@ohmail/app-logic/mailboxes/first-run/step";
import { O, fakeDoor, id } from "../../../packages/app/test/mailboxes/connect/support.js";
import { mountStage } from "./_first-run-stage.js";

/**
 * A RUN THAT NAMES NO MAILBOX ON AN INSTALL WITH SEVERAL ASKS WHICH. The stage took the install's
 * first row, so after a refused first door under one address and a successful one under another,
 * the consent landed on the refused attempt's bare row and the connected mailbox stayed
 * unconsented. Read off the rendered screen: the choice, each press naming its own mailbox, no
 * connect form and no consent. The one-row run keeps its row (the control).
 *
 * RE-POINTED (the switch's older tests, sorted once): the run is the new frame's first-run stage
 * (`_first-run-stage.tsx`); the install's rows are the ground's; a press on a mailbox names it in the
 * run's address (the person's Back returns to the question), and leaving moves the address off the stage; the
 * connect wire the mailbox step would dial is a scripted one whose calls are read. Every expectation is as it stood.
 */

const t = O;

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

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

/** A mailbox row the ground hands: this install's, never consented. */
const rowOf = (m: (typeof ROWS)[number]): FirstRunRow =>
  ({
    id: id(m.id), address: m.address, organizerRole: "organizer", organizedBy: null, organizerState: null,
    organizerChecked: true, organizeConsentedAt: null, initialImportCompletedAt: null,
  }) as FirstRunRow;

async function mount(o: { choices?: typeof ROWS }) {
  const wire = fakeDoor();
  const organized: string[] = [];
  const st = await mountStage({
    rows: (o.choices ?? []).map(rowOf),
    door: "local",
    connect: wire.door,
    verbs: {
      ai: "unset",
      organize: async (mailbox) => { organized.push(mailbox); return "stored"; },
      complete: async () => { /* leaves */ },
      setAiEnabled: async () => { /* answered */ },
    },
  });
  const el = st.el;
  /** The mailbox each press named: the run's address it wrote. */
  const chosen = () =>
    st.writes().flatMap((w) => {
      const named = /[?&]mailbox=([^&]+)/.exec(w.next);
      return named && w.next.startsWith("#/first-run") ? [decodeURIComponent(named[1]!)] : [];
    });
  const buttons = () => [...el.querySelectorAll("button")];
  return {
    el, organized,
    connects: () => wire.calls.filter((c) => c.verb === "connect" || c.verb === "probe"),
    chosen,
    /** The person's Back to the question. */
    back: () => st.visit("#/first-run"),
    left: () => st.writes().filter((w) => !w.next.startsWith("#/first-run")).length,
    heading: st.heading,
    press: async (label: string) => {
      /* The label without the key hint the primary verb carries in its own <kbd>. */
      const said = (x: HTMLButtonElement) => [...x.childNodes]
        .filter((n) => !(n instanceof HTMLElement && n.tagName === "KBD")).map((n) => n.textContent ?? "").join("").trim();
      const b = buttons().filter((x) => said(x) === label);
      expect(b.length, `one button saying ${label}`).toBe(1);
      await act(async () => {
        b[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        for (let i = 0; i < 12; i++) await Promise.resolve();
      });
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
    await s.back();
    await s.press("box1@home.arpa");
    expect(s.chosen()).toEqual(["mb-connected", "mb-refused"]);
  });

  it("offers no connect form and writes no consent — and leaving is live", async () => {
    const s = await mount({ choices: ROWS });
    expect(s.el.querySelector("input"), "a field on the choice screen").toBeNull();
    expect(s.connects()).toEqual([]);
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
