/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { onboardingPath, type OnboardingFacts, type OnboardingStep } from "@ohmail/app-logic/doors/onboarding";
import { nextStep } from "@ohmail/app-logic/mailboxes/first-run/rules";
import { O, P, fakeDoor, id } from "../../../packages/app/test/mailboxes/connect/support.js";
import { mountStage, stageRow } from "./_first-run-stage.js";

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
 *
 * RE-POINTED (the switch's older tests, sorted once): the run is the new frame's first-run stage
 * (`_first-run-stage.tsx`), an add run at `#/first-run/add`; its mailbox step is the one connect form
 * over a wire that answers as the door did (`fakeDoor`); the facts are the ground's rows, and the re-read after a
 * write is the ground's refresh, held open by the settle case; the walk's rules are read where the first run keeps
 * them (`@ohmail/app-logic/mailboxes/first-run/rules`). The new form asks for a provider, the address, the password
 * and both servers before its verb stands; the cases give them. A heading is read as the kit prints a sentence: its
 * full stop is drawn as the dot (`EndDot`), so a title is compared without it. Every expectation is as it stood.
 *
 * RETIRED HERE: "a successful write never paints the state from before it > the create's re-read is AWAITED — the form
 * does not come back". The new stage writes the new row into the run's address and, until the ground's rows hold it,
 * waits in its own words with no form and no verb (today's said "Connecting…" on the disabled verb); once the row
 * arrives the run goes on to the consent statement. The stage's own case holds both halves
 * (`packages/app/test/mailboxes/first-run/stage.test.tsx`, "an add naming a mailbox the rows do not hold yet waits in
 * words ..."; the replace itself: "an add's new row is written into the run's address by a replace ...").
 */
const t = O;
/** A sentence as the kit prints it: one closing full stop is drawn as the dot, not as text. */
const printed = (title: string): string => (title.endsWith(".") && !title.endsWith("..") ? title.slice(0, -1) : title);

it("the create's re-read is AWAITED — the form does not come back", async () => {
  const mailboxId = id("new-mailbox");
  const wire = fakeDoor({ connect: [{ ok: true, value: { mailboxId, address: null } }] });
  const stage = await mountStage({ rows: [], at: "#/first-run/add", door: "local", verbs: { ai: "on" }, connect: wire.door });
  const page = within(stage.el);
  expect(stage.heading().trim()).toBe(t.providerAnother);
  await stage.press(P.otherShort);
  for (const [label, value] of [[t.address, "person@studio.example"], [t.password, "app-password-fixture"], [t.imapHost, "imap.studio.example"], [t.smtpHost, "smtp.studio.example"]]) {
    await act(async () => fireEvent.change(page.getByLabelText(label), { target: { value } }));
  }
  await stage.press(t.connect);
  expect(wire.of("connect")).toHaveLength(1);
  expect(stage.writes()).toEqual([{ next: "#/first-run/add?mailbox=new-mailbox", how: "replace" }]);
  expect(page.queryByLabelText(t.address)).toBeNull();
  expect(page.queryByRole("button", { name: t.connect })).toBeNull();
  await stage.move([stageRow({ id: mailboxId })]);
  expect(stage.heading()).toContain(t.organizeLast.split("<window>")[0]!.trim());
  expect(wire.of("connect")).toHaveLength(1);
});

/** An install that has been through setup, adding a second mailbox: no row yet, no welcome. */
const addRun = (): OnboardingFacts => ({
  door: "local",
  mailbox: null,
  account: { onboardingCompletedAt: "2026-03-01T11:30:00.000Z" },
  ai: "on",
  queuedSenders: 0,
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

interface Harness {
  el: HTMLElement;
  heading: () => string;
  text: () => string;
  press: (label: string) => Promise<void>;
  has: (label: string) => boolean;
}

/** The connect form's fields, typed as a person fills them for the generic entry. */
async function fill(el: HTMLElement): Promise<void> {
  const type = async (label: string, value: string): Promise<void> => {
    await act(async () => { fireEvent.change(within(el).getByLabelText(label), { target: { value } }); });
  };
  await type(t.address, "me@lichtgrat.example");
  const other = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(P.otherShort));
  await act(async () => { other!.click(); });
  await type(t.imapHost, "mail-a.home.arpa");
  await type(t.smtpHost, "mail-b.home.arpa");
  await type(t.password, "app-password-fixture");
}

async function mount(o: {
  facts: OnboardingFacts;
  add?: boolean;
}): Promise<Harness> {
  const wire = fakeDoor();
  const st = await mountStage({
    rows: [],
    door: o.facts.door,
    ...(o.add ? { at: "#/first-run/add" } : {}),
    account: o.facts.account,
    connect: wire.door,
    verbs: {
      ai: o.facts.ai,
      organize: async () => "stored",
      complete: async () => { /* leaves */ },
      setAiEnabled: async () => { /* answered */ },
    },
  });
  const el = st.el;

  const find = (label: string) => [...el.querySelectorAll("button")]
    .find((b) => (b.textContent ?? "").trim().startsWith(label));
  return {
    el,
    heading: st.heading,
    text: () => (el.textContent ?? "").replace(/\s+/g, " "),
    has: (label) => find(label) !== undefined,
    press: async (label) => {
      if (label === t.restart) {
        await st.press(label);
        return;
      }
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
    expect(s.heading().trim()).toBe(t.providerAnother);
    await s.press(t.restart);
    // The screen after the press, and it may not be the one the walk dropped.
    expect(s.text()).not.toContain(printed(t.welcomeTitle));
    expect(s.heading().trim()).toBe(t.providerAnother);
  });

  it("THE CONTROL IS LIVE — the press reaches a form that can be filled in and sent", async () => {
    const s = await mount({ facts: addRun(), add: true });
    await s.press(t.restart);
    // "Set up a mailbox" is the intro's single control and the intro is what must not be here.
    expect(s.has(t.welcomeStart), "the dead intro control is on screen").toBe(false);
    // What IS here is the form's own verb, over fields a person can answer.
    expect(within(s.el).getByLabelText(t.address)).not.toBeNull();
    /* The new form asks for its provider before its verb stands: the generic entry, as a person picks it. */
    await fill(s.el);
    expect(s.has(t.connect), "the connect verb is missing").toBe(true);
  });

  it("POSITIVE CONTROL — a FIRST run's Start over still lands on its welcome, which it has", async () => {
    const s = await mount({
      facts: { ...addRun(), account: { onboardingCompletedAt: null }, ai: "unset" },
    });
    // The welcome carries no foot, so walk onto the form — which is where the verb lives.
    expect(s.heading()).toBe(printed(t.welcomeTitle));
    await s.press(t.welcomeStart);
    expect(s.heading().trim()).toBe(t.providerFirst);
    await s.press(t.restart);
    expect(s.heading()).toBe(printed(t.welcomeTitle));
    // And there the control is live, because `welcome` IS on a first run's walk.
    await s.press(t.welcomeStart);
    expect(s.heading().trim()).toBe(t.providerFirst);
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
