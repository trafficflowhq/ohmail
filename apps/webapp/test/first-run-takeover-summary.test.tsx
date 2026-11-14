/** @vitest-environment jsdom */
import { describe, expect, it, afterEach } from "vitest";
import { act, cleanup } from "@testing-library/react";
import deCatalogue from "../../../packages/app/messages/mailboxes.de.json" with { type: "json" };
import { takeoverState } from "@ohmail/app-logic/reading/reader-holder";
import type { OnboardingMailbox } from "@ohmail/app-logic/doors/onboarding";
import type { FirstRunRow, FirstRunSender } from "@ohmail/app-logic/mailboxes/first-run/ground";
import { O, id } from "../../../packages/app/test/mailboxes/connect/support.js";
import { mountStage } from "./_first-run-stage.js";

/**
 * DONE SAYS THE TAKEOVER THAT IS UNDER WAY, AND THE FIRST DECISION REACHES ITS HOST
 * After "Organize here instead" and Agree, the summary read "It reads this mailbox …
 * You can organize from here later" until the claim landed, up to 80 s later. `takeoverState`
 * reads the row: asked while the stamp stands, landed once the row says organizer, refused once
 * the gate spent the stamp and the row stayed a reader. HOW TO WATCH IT FAIL: make
 * `takeoverState` answer `null` — the asked and refused cases go red.
 *
 * RE-POINTED (the switch's older tests, sorted once): the run is the new frame's first-run stage
 * (`packages/app/src/mailboxes/first-run`) over a ground the case moves (`_first-run-stage.tsx`), its
 * words the stage's catalogue; the guided decision's sender is the ground's (its `decide` is the host's press); a
 * key reaches the element that has the keys, as a browser delivers it. Every expectation is as it stood.
 */

const t = O;
const de = deCatalogue;
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

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
}

/** The row the ground hands: the account's id and address beside exactly the case's facts. */
const rowOf = (mailbox: OnboardingMailbox): FirstRunRow =>
  ({ id: id("mb-1"), address: "me@example.invalid", holderSince: "14 Sept 2026", ...mailbox }) as FirstRunRow;

async function mount() {
  let current = rowOf(READER);
  const decisions: string[] = [];
  const sender: FirstRunSender = {
    name: SENDER, address: "bea@example.test", held: 6, waiting: 1, many: false, since: "6 waiting",
    decide: (dest) => { decisions.push(dest); },
  };
  const st = await mountStage({
    rows: [current],
    door: "local",
    live: () => [current],
    about: { queuedSenders: 1, sender },
    verbs: {
      ai: "off",
      // The door's answer to Agree: consent and the takeover stamp, one statement; the role waits.
      organize: async () => {
        current = { ...current, organizeConsentedAt: STAMP, takeoverAuthorizedAt: STAMP };
        return "stored";
      },
      complete: async () => { /* stamped */ },
      setAiEnabled: async () => { /* answered */ },
    },
  });
  const el = st.el;
  return {
    heading: st.heading,
    text: () => el.textContent ?? "",
    press: async (label: string) => {
      const button = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(label));
      if (!button) throw new Error(`no button labelled ${JSON.stringify(label)}`);
      await act(async () => { button.click(); for (let i = 0; i < 12; i++) await Promise.resolve(); });
    },
    /** A key as a browser delivers it: at the element that has the keys. */
    key: async (key: string) => {
      await act(async () => { ((document.activeElement as HTMLElement | null) ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
      await settle();
    },
    /** A later read of the row, as the shell's poll delivers it. */
    read: async (over: Partial<OnboardingMailbox>) => {
      current = { ...current, ...over };
      await st.move([current]);
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
