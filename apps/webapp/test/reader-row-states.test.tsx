/** @vitest-environment jsdom */
import { describe, expect, it, afterEach } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FirstRun } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import { readerHolder } from "@ohmail/app-logic/reading/reader-holder";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import type { OnboardingFacts, OnboardingMailbox } from "@ohmail/app-logic/doors/onboarding";

/**
 * ═══ "ORGANIZED BY ANOTHER INSTALL" WITH NO OTHER INSTALL ══════════════════════════════════
 *
 * ── WHAT WAS MEASURED, on the released build ────────────────────────────────────────────────
 *
 * Connect a mailbox through the standalone door's "On this PC — organized right here" card and
 * give no organizing consent. `ohmail/_meta` holds no claim at all — read three times, empty
 * every time — so the four holder columns are unwritten and the wire's `organizedBy` is `null`.
 * Every reader surface then said:
 *
 *     Reading only
 *     Organized by another install
 *     Since —. This computer reads the mailbox; it moves nothing and screens nothing.
 *     [ Organize here instead ]
 *
 * There is no other install. Two false statements in three lines: a relationship with a machine
 * that does not exist, and a date line whose date is an em dash.
 *
 * ── THE CAUSE, and it is one question standing in for another ───────────────────────────────
 *
 * The surfaces branched on `holderName(facts) === null`, and `holderName` returns `null` for two
 * unrelated states: a holder exists and this build has no NAME for it, and nobody holds the
 * mailbox at all. The doc comment above `holderName` asserted the opposite as a guarantee — *"the
 * mailbox has a holder (that is what put the elsewhere screen on screen)"* — which is true on the
 * screen it was written for and false on the summary row and in Settings, where a consent-less
 * reader with no holder is the ordinary first state of a fresh connect.
 *
 * `reader-holder.ts` is now the one place that answers it, from the fact that distinguishes the
 * states (`organizedBy` present vs absent) rather than from the display name.
 *
 * ── AND THE DATE HAD THE SAME DEFECT ONE FIELD OVER ─────────────────────────────────────────
 *
 * A holder is real and its `since` column was never written — an older claim, a peek that read a
 * lease carrying no instant. `AppShell` withholds the prop in exactly that case, and its own
 * comment says the screens "keep their own 'we do not know' arm instead of printing an empty
 * one". They had no such arm: they interpolated `organizedSince ?? ""` into a dated template and
 * rendered "Since . This computer reads the mailbox…" and "Since  · ohmail Cloud." — a sentence
 * that reads as a fault in the mailbox rather than as missing copy. The rule is the same as for
 * the holder: no date line where there is no date. `readerReadsOnly` is that sentence, and it is
 * the dated one with its date clause removed, so the two states cannot say different things about
 * what this computer does.
 *
 * ── THE THREE STATES, AND WHAT EACH SURFACE OWES ────────────────────────────────────────────
 *
 *  (a) NOBODY holds it        → "Nothing organizes this mailbox" + what this computer does and
 *                               which press changes it. NO date line: there is no date.
 *  (b) a holder, UNNAMED      → "Organized by another install" + "Since <date>", as before.
 *  (c) a holder, NAMED        → "Organized by <name>" + the kind's own sentence, as before.
 *
 * ── HOW TO WATCH THESE FAIL ─────────────────────────────────────────────────────────────────
 *
 * Put `holderName(facts) === null` back in front of either branch in `FirstRun.tsx` and the two
 * (a) cases go red naming `mailboxes.readerLabelLegacy` — which is the released behaviour
 * exactly. The (b) and (c) cases are green either way: they are what says this slice changed the
 * state nobody held and nothing else.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const t = messages.onboarding;
const tm = messages.mailboxes;

/** State (a): a consent-less reader, and nothing anywhere has recorded a holder. */
const NOBODY: OnboardingMailbox = {
  organizerRole: "reader",
  organizedBy: null,
  organizerState: null,
  organizeConsentedAt: null,
  initialImportCompletedAt: null,
};

/**
 * State (b), the shape the legacy label was written for: a holder was recorded — the object
 * exists, which the wire only does when a holder column was written — and it carries no name.
 */
const UNNAMED: OnboardingMailbox = {
  ...NOBODY,
  organizedBy: { kind: "local", name: null, since: "2026-08-30T09:00:00.000Z" },
  organizerState: "held",
};

/** State (b) again, at the degenerate end: an empty name is still a recorded holder. */
const EMPTY_NAME: OnboardingMailbox = {
  ...NOBODY,
  organizedBy: { kind: null, name: "", since: null },
  organizerState: "held",
};

/** State (c): a holder with a name. */
const NAMED: OnboardingMailbox = {
  ...NOBODY,
  organizedBy: { kind: "local", name: "omarchy", since: "2026-08-30T09:00:00.000Z" },
  organizerState: "held",
};

/** State (c) on the other kind, and the one the elsewhere screen usually opens on. */
const CLOUD: OnboardingMailbox = {
  ...NOBODY,
  organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
  organizerState: "held",
};

/**
 * State (b) with a DATE and nothing else — the shape a peek writes when it read a claim it could
 * not attribute. `organizedBy` exists, `kind` and `name` are both empty, and the instant is real.
 */
const SINCE_ONLY: OnboardingMailbox = {
  ...NOBODY,
  organizedBy: { kind: null, name: null, since: "2026-08-30T09:00:00.000Z" },
  organizerState: "held",
};

/** State (c) with NO date: a real named holder whose `since` column was never written. */
const CLOUD_UNDATED: OnboardingMailbox = {
  ...NOBODY,
  organizedBy: { kind: "cloud", name: "ohmail Cloud", since: null },
  organizerState: "held",
};

/** The same, on the other kind. */
const NAMED_UNDATED: OnboardingMailbox = {
  ...NOBODY,
  organizedBy: { kind: "local", name: "omarchy", since: null },
  organizerState: "held",
};

/**
 * WHAT `AppShell` HANDS THE SCREENS for a given row: the holder's instant as a date in words, or
 * nothing at all. One formatter for the whole file so no case can assert a date the mount would
 * not have produced.
 */
const sinceProp = (m: OnboardingMailbox | null): string | undefined =>
  m?.organizedBy?.since ? "30 Aug 2026" : undefined;

const facts = (mailbox: OnboardingMailbox | null): OnboardingFacts => ({
  door: "local",
  mailbox,
  account: { onboardingCompletedAt: null },
  ai: "unset",
  queuedSenders: 0,
});

interface HolderRow { label: string; description: string }

interface Harness {
  el: () => HTMLElement;
  heading: () => string;
  text: () => string;
  /**
   * THE HOLDER ROW'S OWN LABEL AND DESCRIPTION, exactly — and `toContain` cannot stand in for
   * this. `readerReadsOnly` IS `readerSinceUnknown` with its date clause removed, so it is a
   * substring of the dated sentence: a containment check passes for both states and a negative
   * containment check can never hold for the dated one. Only an equality on the rendered node
   * tells the two apart, which is what the dated controls are for.
   */
  row: () => HolderRow;
  press: (label: string) => Promise<void>;
  pick: (value: "here" | "read") => Promise<void>;
  move: (mailbox: OnboardingMailbox) => Promise<void>;
}

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => { for (const r of roots.splice(0)) r.unmount(); });
  document.body.innerHTML = "";
});

async function mount(initial: OnboardingMailbox): Promise<Harness> {
  let current = facts(initial);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);

  const host: FirstRunHost = {
    door: "local",
    ai: "unset",
    probe: async () => ({ host: "h", user: "u", folders: 1 }),
    connect: async () => ({ id: "mb-1" }),
    organize: async () => "stored",
    complete: async () => { /* the summary's own verb */ },
    setAiEnabled: async () => { /* answered */ },
    probeReason: () => null,
    probeMessage: () => null,
  };

  let bumpOutside: (() => void) | null = null;
  const Stage = () => {
    const [, bump] = React.useState(0);
    bumpOutside = () => bump((n) => n + 1);
    return h(FirstRun, {
      host,
      facts: current,
      onRefresh: () => bump((n) => n + 1),
      onLeave: () => { /* left */ },
      pull: { screened: 0, history: 0, pulled: 0 },
      decide: null,
      mailboxId: "mb-1",
      /* THE PROP IS DERIVED THE WAY `AppShell` DERIVES IT, INCLUDING THE WITHHOLDING.
         `AppShell`'s `holderSince` returns `null` for an absent or unparseable instant and the
         mount then spreads NOTHING (`{...(holderSince ? { organizedSince } : {})}`), so a fixture
         that hands the screens a placeholder string is a fixture of a state the product cannot be
         in — and it would hide exactly the defect these cases are about, which is what the sites
         do when the prop is missing. */
      ...(sinceProp(current.mailbox) ? { organizedSince: sinceProp(current.mailbox)! } : {}),
    });
  };

  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(KeymapProvider, { children: h(Stage, null) }),
    }));
  });

  const press = async (label: string) => {
    const button = [...el.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").trim().startsWith(label));
    if (!button) {
      throw new Error(`no button labelled ${JSON.stringify(label)}; saw: `
        + [...el.querySelectorAll("button")].map((b) => JSON.stringify(b.textContent)).join(", "));
    }
    await act(async () => {
      button.click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
  };

  const row = (): HolderRow => {
    /* The banner is the claim question's; the summary has no banner and carries the holder row
       SECOND, under "It reads this mailbox". `onSummary` asserts that position once. */
    const node = el.querySelector(".set-banner")
      ?? (el.querySelectorAll(".ob-done .set-row")[1] as Element | undefined);
    if (!node) {
      throw new Error("no holder row on screen; rows: "
        + [...el.querySelectorAll(".set-row .lab b")].map((b) => JSON.stringify(b.textContent))
          .join(", "));
    }
    return {
      label: (node.querySelector(".lab b")?.textContent ?? "").trim(),
      description: (node.querySelector(".lab span")?.textContent ?? "").trim(),
    };
  };

  return {
    el: () => el,
    heading: () => (el.querySelector("h1")?.textContent ?? "").trim(),
    text: () => el.textContent ?? "",
    row,
    press,
    pick: async (value) => {
      const radios = [...el.querySelectorAll("input[type=radio]")] as HTMLInputElement[];
      const radio = radios.find((i) => i.value === value);
      if (!radio) {
        throw new Error(`no ${JSON.stringify(value)} option; saw: `
          + radios.map((i) => JSON.stringify(i.value)).join(", "));
      }
      await act(async () => { radio.click(); for (let i = 0; i < 4; i++) await Promise.resolve(); });
    },
    move: async (mailbox) => {
      current = facts(mailbox);
      await act(async () => { bumpOutside?.(); for (let i = 0; i < 4; i++) await Promise.resolve(); });
    },
  };
}

/** The date line, as the two "since" sentences begin it — the half state (a) must not render. */
const SINCE = tm.readerSinceUnknown.slice(0, tm.readerSinceUnknown.indexOf("{since}"));

/**
 * THE SUMMARY'S READER ROW — reached the way a person reaches it: the claim question, answered
 * with "just read it here". The walk needs a holder (that is what puts the question on screen);
 * the facts then MOVE under the run, which is what a poll landing mid-flow does and what happens
 * the moment the holder releases the mailbox.
 */
async function onSummary(initial: OnboardingMailbox = CLOUD): Promise<Harness> {
  const s = await mount(initial);
  expect(s.heading(), "the walk to the summary did not start on the claim question")
    .toBe(t.elsewhereTitle);
  await s.pick("read");
  await s.press(t.continue);
  expect(s.heading(), "the walk did not reach the reader summary").toBe(t.doneReaderTitle);
  /* THE POSITION `row()` READS, pinned here rather than assumed at every case: a row inserted
     above the holder's would otherwise move every assertion below onto the wrong sentence and
     they would all still pass or all still fail, for the wrong reason. */
  const first = s.el().querySelectorAll(".ob-done .set-row")[0];
  expect((first?.querySelector(".lab b")?.textContent ?? "").trim(),
    "the summary's rows moved — `row()` reads the second one").toBe(t.doneReaderReads);
  return s;
}

/**
 * THE CLAIM QUESTION'S OWN BANNER, with the cursor parked on it: "Organize here instead" moves
 * the cursor to the consent statement, Back moves it to this screen, and the holder can release
 * the mailbox at any point while somebody is reading it.
 *
 * That sequence USED TO be how state (a) reached this screen, and the first case below is now
 * about the sequence rather than about the banner: the cursor releases when nothing holds the
 * mailbox, because every sentence on this screen — its title, its lead and both choices — is
 * about the install that does hold it. The banner's own `nobody` arm stays as a fail-closed
 * default (without it the named branch would interpolate a null), and the routing is what makes
 * it unreachable; see `firstRunStep`'s cursor check and `first-run-stage.test.ts`.
 */
async function onElsewhere(): Promise<Harness> {
  const s = await mount(CLOUD);
  expect(s.heading()).toBe(t.elsewhereTitle);
  await s.pick("here");
  await s.press(t.continue);
  expect(s.heading(), "'Organize here instead' did not reach the consent statement")
    .toBe(t.consentTitle);
  await s.press(t.back);
  expect(s.heading(), "Back did not park the cursor on the claim question").toBe(t.elsewhereTitle);
  return s;
}

describe("the fact that tells the three states apart", () => {
  it("absent and null are NOBODY — an API too old to say has not named anybody", () => {
    expect(readerHolder(null)).toBe("nobody");
    expect(readerHolder(undefined)).toBe("nobody");
  });

  it("a recorded holder with no usable name is UNNAMED, never nobody", () => {
    // The wire emits the object only when a holder column was written, so its presence IS the
    // "somebody recorded a holder" fact. An empty or blank name does not un-record it.
    expect(readerHolder({ kind: "local", name: null, since: "2026-08-30T09:00:00.000Z" }))
      .toBe("unnamed");
    expect(readerHolder({ kind: null, name: "", since: null })).toBe("unnamed");
    expect(readerHolder({ kind: null, name: "   ", since: null })).toBe("unnamed");
  });

  it("a name makes it NAMED", () => {
    expect(readerHolder({ kind: "local", name: "omarchy", since: null })).toBe("named");
  });
});

/**
 * THE LABEL AND DESCRIPTION EACH STATE OWES, as the catalogue spells them — one table, so a case
 * cannot assert a sentence nobody would render, and so the seven states are visibly seven.
 */
const sentences = {
  nobody: { label: tm.stateNotOrganized, description: tm.readerNobodyReads },
  unnamedDated: {
    label: tm.readerLabelLegacy,
    description: tm.readerSinceUnknown.replace("{since}", "30 Aug 2026"),
  },
  unnamedUndated: { label: tm.readerLabelLegacy, description: tm.readerReadsOnly },
  cloudDated: {
    label: tm.readerLabel.replace("{name}", "ohmail Cloud"),
    description: tm.readerSinceCloud.replace("{since}", "30 Aug 2026"),
  },
  cloudUndated: {
    label: tm.readerLabel.replace("{name}", "ohmail Cloud"),
    description: tm.readerReadsOnly,
  },
  localDated: {
    label: tm.readerLabel.replace("{name}", "omarchy"),
    description: tm.readerSinceLocal
      .replace("{since}", "30 Aug 2026").replace("{name}", "omarchy"),
  },
  localUndated: {
    label: tm.readerLabel.replace("{name}", "omarchy"),
    description: tm.readerReadsOnly,
  },
  stopped: {
    label: tm.readerLabel.replace("{name}", "ohmail Cloud"),
    description: tm.readerStopped.replace("{name}", "ohmail Cloud"),
  },
} as const;

describe("SURFACE 1 — the summary's reader row", () => {
  it("(a) NOBODY holds it → no install is named and no date is promised", async () => {
    const s = await onSummary();
    await s.move(NOBODY);
    expect(s.text(), "a relationship with an install that does not exist")
      .not.toContain(tm.readerLabelLegacy);
    expect(s.text(), "a date line over a holder that was never recorded").not.toContain(SINCE);
    expect(s.row()).toEqual(sentences.nobody);
  });

  it("(b) CONTROL: a recorded holder with no name still reads 'another install' + since", async () => {
    const s = await onSummary();
    await s.move(UNNAMED);
    expect(s.row()).toEqual(sentences.unnamedDated);
  });

  it("(b) a holder with NO DATE gets the undated sentence, not an empty one", async () => {
    /* `EMPTY_NAME` carries no `since`, so `AppShell` hands this screen no date at all and the
       dated template rendered "Since . This computer reads the mailbox…". */
    const s = await onSummary();
    await s.move(EMPTY_NAME);
    expect(s.text(), "a date line with no date in it").not.toContain(SINCE);
    expect(s.row()).toEqual(sentences.unnamedUndated);
  });

  it("(b) CONTROL: an EMPTY name is a recorded holder too, not a fourth state", async () => {
    const s = await onSummary();
    await s.move(EMPTY_NAME);
    expect(s.row().label, "an empty name became 'nothing organizes this'")
      .toBe(tm.readerLabelLegacy);
    expect(s.row().description).not.toBe(tm.readerNobodyReads);
  });

  it("(b) CONTROL: a holder known ONLY by its date keeps that date", async () => {
    // The other half of the rule: the undated arm is chosen by the DATE's absence, never the
    // name's — and this row has no name at all.
    const s = await onSummary();
    await s.move(SINCE_ONLY);
    expect(s.row()).toEqual(sentences.unnamedDated);
  });

  it("(c) CONTROL: a NAMED holder is unchanged, name and kind both", async () => {
    const s = await onSummary();
    await s.move(NAMED);
    expect(s.row()).toEqual(sentences.localDated);
    await s.move(CLOUD);
    expect(s.row()).toEqual(sentences.cloudDated);
  });

  it("(c) a NAMED holder with NO DATE keeps its name and loses only the date", async () => {
    const s = await onSummary();
    await s.move(CLOUD_UNDATED);
    expect(s.text(), "the dated Cloud sentence rendered with nothing where the date belongs")
      .not.toContain(SINCE);
    expect(s.row()).toEqual(sentences.cloudUndated);
    await s.move(NAMED_UNDATED);
    expect(s.text(), "the dated local sentence rendered with nothing where the date belongs")
      .not.toContain(SINCE);
    expect(s.row()).toEqual(sentences.localUndated);
  });
});

describe("SURFACE 2 — the claim question's banner", () => {
  it("(a) NOBODY holds it → the claim question is not the screen for that state", async () => {
    /* The four sentences this screen is built from all name the other install, and rewording them
       for a state they were not written for would leave a choice between "let them keep it" and
       "take it from them" with nobody on the other side of it. So the screen goes. */
    const s = await onElsewhere();
    await s.move(NOBODY);
    expect(s.heading(), "a screen about another install stood over a mailbox nothing organizes")
      .not.toBe(t.elsewhereTitle);
    expect(s.heading(), "the run lost its place instead of moving on").toBe(t.consentTitle);
    expect(s.text(), "the lead about a second install survived the install")
      .not.toContain(t.elsewhereLead);
    expect(s.text(), "a relationship with an install that does not exist")
      .not.toContain(tm.readerHolderUnknown);
  });

  /**
   * (a2) THE ORDERING RULE, THROUGH A REAL RENDER — and this is the case that says the wiring
   * exists at all.
   *
   * `firstRunStep`'s floor is supplied by the SCREEN: a ref written from an effect while the
   * claim question is on display with a holder on it. Every table case above drives that floor as
   * an argument, so all of them would stay green with the ref never written and every late read
   * releasing the cursor — the defect, with the guard's own unit cases passing. This drives the
   * facts under a mounted run instead, which is the only way that wiring is exercised.
   *
   * WATCH IT FAIL: delete the `heldStampRef` effect, or pass `null` for the floor at the call
   * site, and the first assertion reds with the run on the consent statement.
   */
  it("(a2) a nobody from an OLDER read does not take the screen away; a newer one does", async () => {
    const t1 = "2026-09-07T09:00:00.000Z";
    const t2 = "2026-09-07T09:05:00.000Z";
    const t3 = "2026-09-07T09:10:00.000Z";

    /* The cursor has to be PARKED for this to be reachable at all: with no cursor the derivation
       answers the question on its own from each read. This is `onElsewhere`'s walk, over a holder
       carrying a stamp — "Organize here instead", which moves the cursor two screens ahead of the
       write that would end the situation, then Back. */
    const s = await mount({ ...CLOUD, organizerEventAt: t2 });
    expect(s.heading()).toBe(t.elsewhereTitle);
    await s.pick("here");
    await s.press(t.continue);
    expect(s.heading()).toBe(t.consentTitle);
    await s.press(t.back);
    expect(s.heading(), "the walk did not park the cursor on the claim question")
      .toBe(t.elsewhereTitle);

    // A read prepared BEFORE the holder was recorded, landing now. It says the same thing a
    // current one would; only its stamp says it is not news.
    await s.move({ ...NOBODY, organizerEventAt: t1 });
    expect(s.heading(), "a late-landing read took the claim question away")
      .toBe(t.elsewhereTitle);

    /* AND A READ THAT OMITS THE FIELD ALTOGETHER is not an answer either, whatever its stamp
       says. Both producers used to normalize this into "nobody", which is what made the arm
       written for it unreachable — so it is driven here through a mount rather than only at the
       seam, where a producer's normalization cannot reach. */
    const noField = { ...NOBODY, organizerEventAt: t3 } as Record<string, unknown>;
    delete noField.organizedBy;
    await s.move(noField as unknown as OnboardingMailbox);
    expect(s.heading(), "a read that said nothing about the organizer took the screen away")
      .toBe(t.elsewhereTitle);

    // …and the release actually happening does move the run on, which is what keeps the rule
    // above from being a screen nobody can leave.
    await s.move({ ...NOBODY, organizerEventAt: t3 });
    expect(s.heading(), "the release the person is waiting for did not move the run on")
      .not.toBe(t.elsewhereTitle);
  });

  /**
   * (d2) THE FLOOR ONLY EVER MOVES UP.
   *
   * Holder reads arrive out of order for exactly the reason the `nobody` ones do, and the floor
   * was ASSIGNED from each of them — so a holder read issued at the second instant landing after the one issued
   * at the third lowered the floor it had just set, and a still-older `nobody` at the second then passed the
   * comparison. The ordering rule defeated by the very disorder it exists for, one read earlier.
   *
   * WATCH IT FAIL: assign the floor instead of raising it, and the third assertion reds with the
   * run on the consent statement.
   */
  it("(d2) a late holder read does not lower the floor it already set", async () => {
    const t2 = "2026-09-07T09:05:00.000Z";
    const t3 = "2026-09-07T09:10:00.000Z";

    const s = await mount({ ...CLOUD, organizerEventAt: t3 });
    expect(s.heading()).toBe(t.elsewhereTitle);
    await s.pick("here");
    await s.press(t.continue);
    await s.press(t.back);
    expect(s.heading(), "the walk did not park the cursor on the claim question")
      .toBe(t.elsewhereTitle);

    // A HOLDER read issued before that one, landing now. It still names a holder, so the screen
    // is right to stay — the question is what it does to the floor.
    await s.move({ ...CLOUD, organizerEventAt: t2 });
    expect(s.heading(), "a read that still names a holder took the screen away").toBe(t.elsewhereTitle);

    // The floor must still be the third instant, so a `nobody` at the second is older and refused.
    await s.move({ ...NOBODY, organizerEventAt: t2 });
    expect(s.heading(), "a late holder read lowered the floor and let an older nobody through")
      .toBe(t.elsewhereTitle);

    // …and the third is not older, so the genuine release still lands.
    await s.move({ ...NOBODY, organizerEventAt: t3 });
    expect(s.heading(), "the floor stopped the release it was supposed to admit")
      .not.toBe(t.elsewhereTitle);
  });

  it("(b) CONTROL: a recorded holder with no name is unchanged here", async () => {
    const s = await onElsewhere();
    await s.move(UNNAMED);
    expect(s.row()).toEqual(sentences.unnamedDated);
  });

  it("(c) a NAMED holder with NO DATE loses only the date here too", async () => {
    const s = await onElsewhere();
    await s.move(CLOUD_UNDATED);
    expect(s.text(), "a date line with no date in it").not.toContain(SINCE);
    expect(s.row()).toEqual(sentences.cloudUndated);
  });

  it("(b) CONTROL: a holder known ONLY by its date keeps that date here too", async () => {
    const s = await onElsewhere();
    await s.move(SINCE_ONLY);
    expect(s.row()).toEqual(sentences.unnamedDated);
  });

  it("(c) CONTROL: a NAMED holder that has STOPPED checking in keeps its own sentence", async () => {
    /* The stopped arm sits between (a) and every dated sentence, and it is the one arm a
       reordering could swallow: it names the holder, so it may only be reached once there is one.
       It carries NO date by design, and the undated arm must not take it either. */
    const s = await onElsewhere();
    await s.move({ ...CLOUD, organizerState: "stopped" });
    expect(s.row()).toEqual(sentences.stopped);
  });
});
