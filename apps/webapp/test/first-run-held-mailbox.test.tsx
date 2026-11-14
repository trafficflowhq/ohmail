/** @vitest-environment jsdom */
import { describe, expect, it, afterEach } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FirstRun } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import type { OnboardingFacts, OnboardingMailbox } from "@ohmail/app-logic/doors/onboarding";

/**
 * ═══ SETUP ON A MAILBOX SOMEBODY ELSE ORGANIZES ═════════════════════════════════════════════
 *
 * ── THE SEQUENCE, MEASURED ON THE RELEASED 0.13.6, ON THE REAL BYTES ────────────────────────
 *
 * A fresh standalone install, a clean HOME, connecting a mailbox ohmail Cloud holds the lease on.
 * The flow opened. Step 2 — "Already organized elsewhere?", the screen that exists for exactly
 * this — NEVER RENDERED. The person pressed "Agree and start organizing". The engine's own log:
 *
 *     12:04:32.203Z  local_mailbox_organize_consented  verdict=authorized     ← Agree
 *     12:04:36.979Z  lease_stand_down                  verdict=stand_down
 *     12:04:36.980Z  organizer_stand_down              organized_elsewhere:cloud  "ohmail Cloud"
 *     ~12:05:30Z     "What ohmail did — N senders screened · Folders created in your mailbox"
 *
 * It became a READER 4.8 seconds after the consent and, 54 seconds later, reported the organizing
 * it had just been refused. Settings → Mailboxes said the true thing on the same machine at the
 * same moment ("Organized by ohmail Cloud · this computer reads the mailbox; it moves nothing and
 * screens nothing"), which is how the contradiction was found.
 *
 * ── THE CAUSE IS THE CURSOR, AND THE OBVIOUS SUSPECT WAS INNOCENT ───────────────────────────
 *
 * The first thing to look at was the derivation: row 3 read `organizerRole === 'reader' &&
 * organizedBy && !consented`, and the holder columns are written by a PEEK while the ROLE is
 * written by the STAND-DOWN, which only happens after somebody has already agreed. That reads
 * like the bug. **It is not, and the mutation says so**: on this door the row is created
 * `organizer_role = 'reader'` at connect (`identity.ts#ensureLocalWorld`, "the pre-consent state
 * IS the reader mode"), so the clause was satisfied throughout. Putting `isReader &&` back leaves
 * every case in this file green. The clause is gone anyway — it can only ever withhold the screen
 * and it guards nothing that `!consented` does not already say — but it is a DEFENSIVE change
 * and is not described here as the fix.
 *
 * What actually shipped is `firstRunStep` returning `at` whenever it was non-null. The peek needs
 * an IMAP round trip and the facts are polled, so on the walked install the consent screen was
 * correct at the instant it rendered — no holder was known yet — the person pressed Continue, and
 * from that press the cursor answered every render. The screen the facts selected a second later
 * could not appear. **A deterministic defect, not a race**: once the cursor is set, no later fact
 * can put the claim question back.
 *
 * And the summary reported the MAILBOX rather than the RUN — every number on it true about the
 * mailbox and false about the install printing it.
 *
 * ── HOW TO WATCH THESE FAIL ─────────────────────────────────────────────────────────────────
 *
 *  · delete the `derived === "elsewhere"` guard from `firstRunStep` → "THE PEEK LANDS MID-RUN"
 *    goes red with the window screen still on, which is the released behaviour exactly;
 *  · drop `claimAnswered` from that guard (pass `false`) → "AND THE CHOICE IS NOT A LOOP" goes
 *    red, thrown back to the claim question it just answered — the loop this codebase keeps
 *    producing, and the reason the flag exists;
 *  · make the summary unconditional again → "A READER'S SUMMARY" goes red with "What ohmail did"
 *    and "Folders created in your mailbox" over an install that created none;
 *  · put `isReader &&` back in front of row 3 → nothing goes red HERE, and
 *    `onboarding-step.test.ts`'s "row 3 — a holder is named and the role has not caught up"
 *    is the case that carries it.
 *
 * All four mutations were run; the fourth is recorded because its result is the useful one.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const t = messages.onboarding;
const tm = messages.mailboxes;

/** What a standalone connect creates: a consent-less reader, and nobody named yet. */
const PRE_CONSENT: OnboardingMailbox = {
  organizerRole: "reader",
  organizedBy: null,
  organizerState: null,
  organizeConsentedAt: null,
  initialImportCompletedAt: null,
};

/** What the pre-consent PEEK writes once it has looked: the four holder columns, no role change. */
const PEEKED: OnboardingMailbox = {
  ...PRE_CONSENT,
  organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
  organizerState: "held",
};

const facts = (mailbox: OnboardingMailbox | null, over: Partial<OnboardingFacts> = {}):
OnboardingFacts => ({
  door: "local",
  mailbox,
  account: { onboardingCompletedAt: null },
  ai: "unset",
  queuedSenders: 0,
  ...over,
});

interface Harness {
  el: HTMLElement;
  heading: () => string;
  text: () => string;
  press: (label: string) => Promise<void>;
  /** Choose one of the elsewhere screen's two options, as a person clicking a radio does. */
  pick: (value: "here" | "read") => Promise<void>;
  /** Which option is selected right now — the DEFAULT before anything has been picked. */
  picked: () => string | null;
  /** Move the facts under a live run — what a poll landing mid-flow actually does. */
  move: (mailbox: OnboardingMailbox) => Promise<void>;
  completed: () => number;
  left: () => number;
  organizedWith: Array<unknown>;
}

const roots: Root[] = [];
afterEach(async () => {
  /* Inside `act`, because a bare unmount is itself a React update and the warning it prints
     ("An update to Root inside a test was not wrapped in act") looks exactly like a real one. */
  await act(async () => { for (const r of roots.splice(0)) r.unmount(); });
  document.body.innerHTML = "";
});

async function mount(o: {
  facts: OnboardingFacts;
  /** Present only where the case is about the SUMMARY's two shapes. */
  pull?: { screened: number; history: number; pulled: number };
}): Promise<Harness> {
  let current = o.facts;
  let completes = 0;
  let leaves = 0;
  const organizedWith: unknown[] = [];
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);

  const host: FirstRunHost = {
    door: "local",
    ai: o.facts.ai,
    probe: async () => ({ host: "h", user: "u", folders: 1 }),
    connect: async () => ({ id: "mb-1" }),
    organize: async (_id, body) => {
      organizedWith.push(body);
      /* THE SERVER TOOK THE CONSENT. It does NOT make this install the organizer — that is the
         lease's decision on the next pass, and on a live Cloud claim the answer is no. The facts
         are left exactly as the caller set them, which is the honest simulation. */
      current = {
        ...current,
        mailbox: { ...current.mailbox!, organizeConsentedAt: "2026-09-02T12:04:32.000Z" },
      };
      return "stored";
    },
    complete: async () => { completes += 1; },
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
      onLeave: () => { leaves += 1; },
      pull: o.pull ?? { screened: 0, history: 0, pulled: 0 },
      decide: null,
      mailboxId: "mb-1",
      organizedSince: "30 Aug 2026",
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

  const radios = (): HTMLInputElement[] =>
    [...el.querySelectorAll("input[type=radio]")] as HTMLInputElement[];

  return {
    el,
    heading: () => (el.querySelector("h1")?.textContent ?? "").trim(),
    text: () => el.textContent ?? "",
    press,
    pick: async (value) => {
      const radio = radios().find((i) => i.value === value);
      if (!radio) {
        throw new Error(`no ${JSON.stringify(value)} option; saw: `
          + radios().map((i) => JSON.stringify(i.value)).join(", "));
      }
      await act(async () => { radio.click(); for (let i = 0; i < 4; i++) await Promise.resolve(); });
    },
    picked: () => radios().find((i) => i.checked)?.value ?? null,
    move: async (mailbox) => {
      current = { ...current, mailbox };
      await act(async () => { bumpOutside?.(); for (let i = 0; i < 4; i++) await Promise.resolve(); });
    },
    completed: () => completes,
    left: () => leaves,
    organizedWith,
  };
}

describe("the claim question cannot be walked past", () => {
  it("THE PEEK LANDS before anything is pressed → the CHOICE, not the consent statement", async () => {
    // The resting case, and the one that was always right: the role is `reader`, the consent is
    // null, and the peek has written who holds the mailbox. Green before this slice too — which
    // is exactly why the walk found nothing wrong with the derivation.
    const s = await mount({ facts: facts(PEEKED) });
    expect(s.heading()).toBe(t.elsewhereTitle);
    expect(s.text()).toContain("ohmail Cloud");
  });

  it("THE PEEK LANDS MID-RUN — the cursor may not keep the run on the screen it left", async () => {
    /* THE MEASURED SEQUENCE. At connect the peek has not answered, so the consent statement is
       correct; Continue sets the cursor; the peek then lands. On the released build the cursor
       won here and the person agreed on the next screen. */
    const s = await mount({ facts: facts(PRE_CONSENT) });
    expect(s.heading(), "a mailbox with no holder named is an ordinary consent")
      .toBe(t.consentTitle);

    await s.press(t.continue);
    expect(s.heading()).toBe(t.windowTitle);

    await s.move(PEEKED);
    expect(s.heading(), "the flow stayed on the window screen over a mailbox somebody else holds")
      .toBe(t.elsewhereTitle);

    /* AND NOTHING WAS AGREED TO ON THE WAY. The window screen's press is the consent write, and
       the whole failure is that it was reachable from here. */
    expect(s.organizedWith).toEqual([]);
  });

  it("THE PEEK LANDS AND A STALE READ FOLLOWS IT — with nothing pressed at all", async () => {
    /* THE SAME SEQUENCE WITHOUT THE PRESS, which is the ordinary one and the one that shipped
       unguarded on the 0.14.2 candidate. Two reads of the account are in flight together; the
       peek's lands first and the derivation puts the claim question up; the older one lands
       after it, says "nobody organizes this mailbox" about a moment that has passed, and — with
       no cursor to hold the screen, because nobody has touched anything — carried the run on to
       the consent statement. Continue and then Agree from there authorize the takeover this
       screen exists to ask about.

       This case is here and not in the pure table because the WIRING is what it measures: the
       flag comes from the screen's own floor ref, and passing `false` at the call reds this and
       nothing else. */
    const t1 = "2026-09-07T09:00:00.000Z";
    const t2 = "2026-09-07T09:05:00.000Z";
    const t3 = "2026-09-07T09:10:00.000Z";

    const s = await mount({ facts: facts(PRE_CONSENT) });
    expect(s.heading(), "a mailbox with no holder named is an ordinary consent")
      .toBe(t.consentTitle);

    await s.move({ ...PEEKED, organizerEventAt: t2 });
    expect(s.heading(), "the derivation did not put the claim question up on its own")
      .toBe(t.elsewhereTitle);

    await s.move({ ...PRE_CONSENT, organizerEventAt: t1 });
    expect(s.heading(), "a read prepared before the holder appeared took the question away")
      .toBe(t.elsewhereTitle);

    /* AND THE RELEASE STILL GETS THROUGH. Without this the row above would be satisfied by a
       screen nobody can leave. */
    await s.move({ ...PRE_CONSENT, organizerEventAt: t3 });
    expect(s.heading(), "the release actually happening did not move the run on")
      .toBe(t.consentTitle);
  });

  it("AND THE CHOICE IS NOT A LOOP — 'Organize here instead' moves on", async () => {
    /* The guard's own hazard, and the failure mode this codebase keeps producing. The consent
       stamp that ends the situation is written two screens later, so between the choice and the
       window press the derivation still answers "elsewhere". Without the answered flag the
       person is thrown back to the question they just answered, on every render, for ever. */
    const s = await mount({ facts: facts(PEEKED) });
    expect(s.heading()).toBe(t.elsewhereTitle);
    /* PICKED, not defaulted. The default on a live Cloud holder is the reader ending now (the
       case below), so a bare Continue here would walk the other path and this case would silently
       stop testing the loop it exists for. */
    await s.pick("here");
    await s.press(t.continue);
    expect(s.heading(), "the claim choice returned to the claim question").toBe(t.consentTitle);
    await s.press(t.continue);
    expect(s.heading()).toBe(t.windowTitle);
  });

  /* ── NOTHING IS PRE-SELECTED OVER A LIVE HOLDER ─────────────────────────────────────────────
   *
   * "Organize here instead" used to be pre-selected on every door, so an unread Continue displaced a
   * running organizer and re-baselined its Screener window. Over a holder that is still checking in
   * the person picks; a stopped holder (below) and the consented re-entry keep the default.
   *
   * HOW TO WATCH IT FAIL: default `elsewhereChoice` to "here" again. */
  it("NOTHING IS PRE-SELECTED OVER A LIVE HOLDER, and Continue does nothing until a pick", async () => {
    const live = await mount({ facts: facts(PEEKED) });
    expect(live.heading()).toBe(t.elsewhereTitle);
    expect(live.picked(), "a live organizer's mailbox defaulted to the takeover").toBeNull();
    const cont = [...live.el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(t.continue));
    expect(cont?.disabled, "Continue is pressable with nothing picked").toBe(true);
    await live.press(t.continue);
    // Enter submits the step's form whatever the button says.
    await act(async () => { live.el.querySelector("form")!.requestSubmit(); for (let i = 0; i < 4; i++) await Promise.resolve(); });
    expect({ heading: live.heading(), organized: live.organizedWith }).toEqual({ heading: t.elsewhereTitle, organized: [] });
    const stopped = await mount({ facts: facts({ ...PEEKED, organizerState: "stopped" }) });
    expect(stopped.picked()).toBe("here");
  });

  it("A PICKED 'Organize here instead' walks on to Agree, which asks for the takeover", async () => {
    const s = await mount({ facts: facts(PEEKED) });
    await s.pick("here");
    await s.press(t.continue);
    await s.press(t.continue);
    expect(s.heading()).toBe(t.windowTitle);
    await s.press(t.agree);
    expect(s.organizedWith.map((b) => (b as { intent?: string }).intent)).toEqual(["takeover"]);
  });

  it("CONTROL: where the claim CAN win, the default is still 'Organize here instead'", async () => {
    // A holder that has stopped checking in is beatable (rules 7-8), so `here` promises nothing
    // the next pass declines and it stays the ordinary intent of a first run.
    const s = await mount({ facts: facts({ ...PEEKED, organizerState: "stopped" }) });
    expect(s.picked()).toBe("here");
  });

  it("CONTROL: a press still wins over the default — 'here' is choosable on a live holder", async () => {
    // The screen states the refusal; it does not remove the choice. `elsewhereChoicePicked` is
    // what makes the default a default rather than a lock.
    const s = await mount({ facts: facts(PEEKED) });
    await s.pick("here");
    expect(s.picked()).toBe("here");
  });

  it("'Just read it here' ENDS THE RUN ON THE READER SUMMARY, not by closing the flow", async () => {
    /* Measured on the released 0.13.7: this choice called `leave()` outright — no summary, and
       nothing anywhere else in the shell saying who organizes the mailbox. The reader summary
       existed in both catalogues and was unreachable, because this was its only path. */
    const s = await mount({ facts: facts(PEEKED) });
    await s.pick("read");
    await s.press(t.continue);

    expect(s.heading(), "the reader ending skipped the summary written for it")
      .toBe(t.doneReaderTitle);
    expect(s.text()).toContain(t.doneReaderReads);
    expect(s.text()).toContain(tm.readerLabel.replace("{name}", "ohmail Cloud"));
    expect(s.organizedWith, "the reader ending asked for the mailbox").toEqual([]);
    /* NOT YET STAMPED. Deferring it one screen is the whole change, and it costs nothing: cancel
       and finish write the same stamp, so quitting on the summary lands where `leave()` did. */
    expect(s.completed(), "the summary was skipped past to the stamp").toBe(0);

    await s.press(t.doneOpen);
    expect(s.completed(), "the summary's own verb left no completion stamp").toBe(1);
    expect(s.left()).toBe(1);
    expect(s.organizedWith).toEqual([]);
  });

  it("THE CONSEQUENCE IS SAID BEFORE THE PRESS, on a holder that is still checking in", async () => {
    /* THIS ROW IS THE INVERSE OF THE ONE IT REPLACES, and the inversion is the point.
       It used to assert that the screen REFUSED here — a local install had no path over a live
       hosted claim, authorized or not, so the choice promised a takeover the next pass declined
       (the 4.8 seconds between the consent and the stand-down in the log above). An explicit
       press outranks a claim carrying none now, so the press succeeds and what the screen owes
       is what it COSTS the other machine: it stops organizing within a minute and goes on
       reading, keeping its copy of the mail. Said before the press, which is the property the
       old row was really defending. */
    const s = await mount({ facts: facts(PEEKED) });
    expect(s.text()).toContain(t.elsewhereChoiceHereWhy.replace("{name}", "ohmail Cloud"));
  });

  it("…and the retired refusal is not said anywhere, on either holder state", async () => {
    /* THE COUNTERWEIGHT, widened. It used to check that the warning was absent on a STOPPED
       holder — the one state where the takeover could win. Both states win now, so the absence
       has to hold on both, and it is asserted on the sentence's own distinctive phrase rather
       than on a key that no longer exists. A screen still saying this would be sending somebody
       to stop a machine they do not have to touch. */
    const live = await mount({ facts: facts(PEEKED) });
    expect(live.heading()).toBe(t.elsewhereTitle);
    expect(live.text()).not.toContain("still checking in");
    const stopped = await mount({ facts: facts({ ...PEEKED, organizerState: "stopped" }) });
    // The stopped holder's own title: the question is up, told as a stop.
    expect(stopped.heading()).toBe(t.elsewhereTitleStopped);
    expect(stopped.text()).not.toContain("still checking in");
  });
});

describe("the summary reports what THIS install did", () => {
  /** F's end state exactly: consent given, the lease refused it, this install reads. */
  const demoted: OnboardingMailbox = {
    organizerRole: "reader",
    organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
    organizerState: "held",
    organizeConsentedAt: "2026-09-02T12:04:32.000Z",
    initialImportCompletedAt: "2026-09-02T12:05:00.000Z",
  };

  it("A READER'S SUMMARY says it reads, names the organizer, and counts NOTHING", async () => {
    const s = await mount({
      facts: facts(demoted, { ai: "off" }),
      // The mirror's own totals, which is what the released build printed as its own work.
      pull: { screened: 532, history: 8, pulled: 540 },
    });
    expect(s.heading()).toBe(t.doneReaderTitle);
    expect(s.text()).toContain(t.doneReaderReads);
    // WHO ORGANIZES IT — the same sentence the pane and the elsewhere screen render.
    expect(s.text()).toContain(tm.readerLabel.replace("{name}", "ohmail Cloud"));
    expect(s.text()).toContain(tm.readerSinceCloud.replace("{since}", "30 Aug 2026"));

    /* THE THREE CLAIMS THAT WERE FALSE. Each was on screen at 12:05:30 on the walked machine. */
    expect(s.text(), "a reader reported folders it did not create").not.toContain(t.doneFolders);
    expect(s.text(), "a reader reported screening it did not do").not.toContain("532");
    expect(s.text(), "a reader reported a History listing it did not make").not.toContain(t.doneTitle);
  });

  it("CONTROL: an ORGANIZER's summary is unchanged, and it counts MESSAGES", async () => {
    // Which is what says the case above is about the ROLE. The noun is checked too: the number is
    // the mirror's size minus what History lists — messages — and it was printed as "senders".
    const s = await mount({
      facts: facts({
        organizerRole: "organizer",
        organizedBy: null,
        organizerState: null,
        organizeConsentedAt: "2026-09-02T12:04:32.000Z",
        initialImportCompletedAt: "2026-09-02T12:05:00.000Z",
      }, { ai: "off" }),
      pull: { screened: 532, history: 8, pulled: 540 },
    });
    expect(s.heading()).toBe(t.doneTitle);
    expect(s.text()).toContain(t.doneFolders);
    expect(s.text()).toContain("532" + " messages screened");
    expect(s.text(), "the count was labelled senders over a count of messages")
      .not.toContain("532" + " senders");
  });

  it("A HOST TOO OLD TO SAY THE ROLE gets the organizer summary, not the reader one", async () => {
    // The deploy-skew direction `OnboardingMailbox.organizerRole` names: every install was an
    // organizer before the column existed, so absent must not withhold the work it did.
    const s = await mount({
      facts: facts({
        organizeConsentedAt: "2026-09-02T12:04:32.000Z",
        initialImportCompletedAt: "2026-09-02T12:05:00.000Z",
      }, { ai: "off" }),
      pull: { screened: 3, history: 0, pulled: 3 },
    });
    expect(s.heading()).toBe(t.doneTitle);
  });
});
