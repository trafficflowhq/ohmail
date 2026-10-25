/**
 * THE FIRST-RUN STAGE'S CONTRACTS — the ones a rendered screen cannot show you.
 *
 * Two kinds of claim live here and they are kept apart on purpose:
 *
 *  1. {@link firstRunStep}'s table — the cursor/derivation interaction, driven directly. This is
 *     where "the step is DERIVED, never counted" is actually enforced, and it has rows, so it is
 *     tested as a table with no React in it at all.
 *  2. SOURCE pins — that the copy the flow promises is rendered on the step that promises it,
 *     and that four structural rules hold. Source assertions are strictly weaker than a render
 *     and it is said out loud here so the next reader does not mistake them for proof that
 *     anybody sees anything. They exist because the thing being pinned is an ABSENCE (no second
 *     Escape binding, no import of the desktop's form) and absences do not render.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { firstRunStep, initialWindow } from "../app/shell/FirstRun";
import { firstRunSubject } from "../app/shell/first-run-subject";
import { canonicalHash, parseHash } from "../app/shell/routing";
import type { OnboardingFacts } from "../app/shell/onboarding";
/* Four callbacks in `FirstRun.tsx` and `MailboxSection.tsx` are read as source below, each
   anchored on its DECLARED NAME. Neither file has been through the render-identity codemod — both
   still declare eight callbacks as `const <name> = useCallback(` and neither holds a single
   `useStableCallback` — so the hook spellings these anchors used to carry resolved today. That is
   a fact about which file the last codemod ran on, not evidence about the anchor: the same
   spellings in `AppShell.tsx`, where it did run, are all -1 now. */
import { sliceOfDeclaration } from "./source-anchor.js";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const STAGE = read("apps/webapp/app/shell/FirstRun.tsx");

/** A run with everything still to do, on the standalone door. */
const facts = (over: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  door: "local",
  mailbox: null,
  account: { onboardingCompletedAt: null },
  ai: "unset",
  queuedSenders: 0,
  ...over,
});

const CONNECTED = {
  organizerRole: "organizer" as const,
  organizedBy: null,
  organizerState: null,
  organizeConsentedAt: null,
  initialImportCompletedAt: null,
};

describe("where the stage opens, and what a cursor may and may not do", () => {
  it("a run with nothing behind it opens on the WELCOME, not on the derived step", () => {
    // `deriveOnboardingStep` answers "mailbox" here — correctly, since that is the first unmet
    // condition — and the welcome is the one screen shown ahead of the derivation.
    expect(firstRunStep(facts(), null)).toBe("welcome");
  });

  it("a run whose mailbox was REMOVED resumes on the mailbox step, with no greeting", () => {
    // Same derived step, different history. The greeting is for a person who has never been
    // here; somebody who removed their mailbox does not need introducing to the product again.
    // Distinguished by the CURSOR, which a resumed run does not have — so this case is reached
    // by the account having a completion history rather than by re-showing the welcome.
    expect(firstRunStep(facts({ account: { onboardingCompletedAt: null } }), "mailbox"))
      .toBe("mailbox");
  });

  it("the cursor carries a run forward THROUGH screens the derivation cannot name", () => {
    // `window` shares one write with `consent`, so there is no truth-condition between them to
    // resume on: the derivation answers "consent" for both and the cursor is what distinguishes
    // "reading the statement" from "choosing the window".
    const f = facts({ mailbox: CONNECTED });
    expect(firstRunStep(f, null)).toBe("consent");
    expect(firstRunStep(f, "window")).toBe("window");
  });

  it("THE COMPLETION STAMP CLOSES THE STAGE, and no cursor may reopen it", () => {
    // The load-bearing direction. `leave()` stamps and then navigates; between the two there is
    // a render in which the cursor still names a screen. If the cursor won there, the dialog
    // would stay on screen after the person asked to leave — and on the next boot too, since
    // the same cursor logic runs over the same facts.
    const done = facts({ account: { onboardingCompletedAt: "2026-09-02T08:00:00.000Z" } });
    expect(firstRunStep(done, null)).toBeNull();
    expect(firstRunStep(done, "consent")).toBeNull();
    expect(firstRunStep(done, "summary")).toBeNull();
  });

  it("THE CLAIM QUESTION OUTRANKS THE CURSOR, on every screen after it", () => {
    /* The measured defect, as a table. `at` is set the moment somebody presses Continue on the
     * consent statement — which is correct at that instant, because the pre-consent PEEK has not
     * answered yet and no holder is named. When it does answer the derivation says "elsewhere",
     * and the cursor used to win. A person then agreed on the next screen and the install stood
     * down 4.8 s later.
     *
     * `first-run-held-mailbox.test.tsx` drives the whole sequence through a render; this is the
     * table underneath it. */
    const held = facts({
      mailbox: {
        organizerRole: "reader",
        organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
        organizerState: "held",
        organizeConsentedAt: null,
        initialImportCompletedAt: null,
      },
    });
    expect(firstRunStep(held, null)).toBe("elsewhere");
    expect(firstRunStep(held, "consent")).toBe("elsewhere");
    expect(firstRunStep(held, "window")).toBe("elsewhere");
    expect(firstRunStep(held, "ai")).toBe("elsewhere");
    // A RE-RUN is not exempt: it opens on the consent statement when the cursor is null, and that
    // is the same statement over the same held mailbox.
    expect(firstRunStep(held, null, true)).toBe("elsewhere");
  });

  it("…but Back still works, and an ANSWERED question releases the cursor", () => {
    // The two exemptions, and the flag. Without the flag "Organize here instead" — which moves
    // the cursor to `consent` two screens ahead of the write that ends the situation — would be
    // thrown straight back to the question it just answered, for ever.
    const held = facts({
      mailbox: {
        organizerRole: "reader",
        organizedBy: { kind: "cloud", name: "ohmail Cloud", since: null },
        organizerState: "held",
        organizeConsentedAt: null,
        initialImportCompletedAt: null,
      },
    });
    expect(firstRunStep(held, "mailbox")).toBe("mailbox");
    expect(firstRunStep(held, "welcome")).toBe("welcome");
    expect(firstRunStep(held, "consent", false, true)).toBe("consent");
    expect(firstRunStep(held, "window", false, true)).toBe("window");
  });

  it("AND A RE-RUN IS NOT EXEMPT — the same defect arrives through the other door", () => {
    /* The guard used to read `derived === "elsewhere"`, and `deriveOnboardingStep` row 1 answers
     * `null` for ANY account carrying a completion stamp — so on `#/first-run/again` it was
     * structurally inert. The walk is short: connect a mailbox somebody else holds, CANCEL on the
     * consent screen (cancel stamps completion, which is the whole point of the stamp), then press
     * "Run setup again". The re-run arm opens on the consent statement, the claim question is
     * never shown, Agree writes a consent the lease is about to decline.
     *
     * MUTATION: put `derived === "elsewhere"` back in front of the guard and this goes red with
     * "consent" — the released behaviour, one door over. */
    const cancelled = facts({
      mailbox: {
        organizerRole: "reader",
        organizedBy: { kind: "cloud", name: "ohmail Cloud", since: null },
        organizerState: "held",
        organizeConsentedAt: null,
        initialImportCompletedAt: null,
      },
      account: { onboardingCompletedAt: "2026-09-02T12:06:00.000Z" },
    });
    expect(firstRunStep(cancelled, null, true)).toBe("elsewhere");
    expect(firstRunStep(cancelled, "window", true)).toBe("elsewhere");
    // …and answering it releases the cursor on the re-run exactly as on a first run.
    expect(firstRunStep(cancelled, "consent", true, true)).toBe("consent");
  });

  it("AN ADD RUN CANNOT WALK PAST THE CLAIM QUESTION EITHER", () => {
    /* ── THE SAME DEFECT, THROUGH THE THIRD DOOR ──────────────────────────────────────────────
     *
     * The claim guard is gated on `flowIsOpen`, and `flowIsOpen` had to learn about the add
     * intent for the same reason it had to learn about the re-run: `deriveOnboardingStep` row 1
     * answers `null` for any account carrying a completion stamp, and an install that can offer
     * "Add mailbox" is by definition one that has been through setup. Without `add` in that
     * disjunction the guard is STRUCTURALLY INERT on every add run.
     *
     * The walk is not exotic. Add a second mailbox that ohmail Cloud already organizes: the peek
     * is an IMAP round trip, so the connect screen advances to consent before any holder is
     * known, and from that press the cursor answers every render. The person agrees, the install
     * stands down to reader on its next pass, and the summary reports organizing that was
     * refused — which is exactly the sequence measured on the released 0.13.6 for the FIRST
     * mailbox.
     *
     * MUTATION: drop `add` from `flowIsOpen` and this goes red with "consent".
     */
    const heldSecond = facts({
      mailbox: {
        organizerRole: "reader",
        organizedBy: { kind: "cloud", name: "ohmail Cloud", since: null },
        organizerState: "held",
        organizeConsentedAt: null,
        initialImportCompletedAt: null,
      },
      // The install has been set up — the fact that makes "Add mailbox" a control at all.
      account: { onboardingCompletedAt: "2026-08-01T09:00:00.000Z" },
      ai: "on",
    });
    const add = (at: Parameters<typeof firstRunStep>[1], answered = false) =>
      firstRunStep(heldSecond, at, false, answered, true);

    expect(add("consent"), "the cursor carried an add run past the claim question")
      .toBe("elsewhere");
    expect(add("window")).toBe("elsewhere");
    // …and answering it releases the cursor, exactly as on the other two entries. Without this
    // the guard would be a loop: "Organize here instead" moves the cursor to `consent`, and the
    // stamp that ends the situation is written two screens later.
    expect(add("consent", true)).toBe("consent");
    // The screens at or before it stay reachable, so Back works.
    expect(add("mailbox")).toBe("mailbox");
    expect(add("elsewhere")).toBe("elsewhere");
  });

  it("an ADD RUN OPENS at all, over an install that has finished setup", () => {
    /* The completion stamp closes the flow for a boot — correctly — and an add is not a boot.
       The intent rides the route for the same reason the re-run's does; there is deliberately no
       instruction that un-finishes onboarding. */
    const finished = facts({
      mailbox: null,
      account: { onboardingCompletedAt: "2026-08-01T09:00:00.000Z" },
      ai: "on",
    });
    expect(firstRunStep(finished, null), "a boot re-opened setup").toBeNull();
    expect(firstRunStep(finished, null, false, false, true)).toBe("mailbox");
    /* AND IT RESUMES ON WHAT THE NEW MAILBOX STILL NEEDS, not on the form again: the account
       stamp and the install's AI answer are both withheld from the derivation, because neither
       is this mailbox's business. */
    const connected = facts({
      mailbox: { ...CONNECTED, organizerRole: "reader" },
      account: { onboardingCompletedAt: "2026-08-01T09:00:00.000Z" },
      ai: "unset",
    });
    expect(firstRunStep(connected, null, false, false, true)).toBe("consent");
    const consented = facts({
      mailbox: { ...CONNECTED, organizeConsentedAt: "2026-09-02T10:00:00.000Z" },
      account: { onboardingCompletedAt: "2026-08-01T09:00:00.000Z" },
      // `unset` would put the AI question in the resume — a screen the add path cannot navigate
      // away from, because `onboardingPath` does not contain it.
      ai: "unset",
    });
    expect(firstRunStep(consented, null, false, false, true)).toBe("pull");
  });

  it("and the COMPLETION STAMP still outranks the claim question", () => {
    // Ordering: the guard reads `derived`, and `derived` is null for a stamped account — so a
    // person who chose "Just read it here" (which stamps and leaves) is not held on the screen
    // they just answered while the route unwinds.
    const done = facts({
      mailbox: {
        organizerRole: "reader",
        organizedBy: { kind: "cloud", name: "ohmail Cloud", since: null },
        organizerState: "held",
        organizeConsentedAt: null,
        initialImportCompletedAt: null,
      },
      account: { onboardingCompletedAt: "2026-09-02T12:06:00.000Z" },
    });
    expect(firstRunStep(done, "window")).toBeNull();
  });

  it("MUTATION: a cursor that outranked the completion stamp would keep the dialog open", () => {
    // The inverse of the case above, spelled out so the guard cannot be read as decorative:
    // `at ?? derived` — the obvious spelling — returns "consent" for the state below.
    const done = facts({ account: { onboardingCompletedAt: "2026-09-02T08:00:00.000Z" } });
    const naive = (f: OnboardingFacts, at: string | null) => at ?? "…";
    expect(naive(done, "consent")).toBe("consent");
    expect(firstRunStep(done, "consent")).toBeNull();
  });
});

describe("a re-run from Settings, and why it is a ROUTE and not a cleared stamp", () => {
  const done = facts({
    mailbox: { ...CONNECTED, organizeConsentedAt: "2026-09-01T10:00:00.000Z" },
    account: { onboardingCompletedAt: "2026-09-02T08:00:00.000Z" },
    ai: "off",
  });

  it("a finished account derives to NOTHING, which is right for a boot", () => {
    expect(firstRunStep(done, null)).toBeNull();
  });

  it("…and the SAME account re-runs, opening on the consent statement", () => {
    // Not the welcome (they have been here) and not the derived step (there is none). A re-run is
    // for the three things somebody comes back to change: what ohmail files, how far back, and AI.
    expect(firstRunStep(done, null, true)).toBe("consent");
  });

  it("a re-run with no mailbox is a FIRST run — there is nothing to re-run", () => {
    expect(firstRunStep(facts({ account: { onboardingCompletedAt: "x" } }), null, true))
      .toBe("mailbox");
  });

  it("the cursor still moves inside a re-run", () => {
    expect(firstRunStep(done, "window", true)).toBe("window");
  });

  it("THE INTENT RIDES THE URL, and round-trips", () => {
    // It cannot be derived and it must survive a reload, which is what makes it a route segment
    // rather than component state: `normalizedHash` rewrites any hash that does not round-trip,
    // so a re-run whose spelling the router could not reproduce would be corrected to the bare
    // form on the first render — closing the flow by fixing the address bar.
    const again = parseHash("#/first-run/again");
    expect(again.firstRun).toBe(true);
    expect(again.firstRunRerun).toBe(true);
    expect(canonicalHash(again)).toBe("#/first-run/again");

    const first = parseHash("#/first-run");
    expect(first.firstRun).toBe(true);
    expect(first.firstRunRerun).toBe(false);
    expect(canonicalHash(first)).toBe("#/first-run");
  });

  it("the stage rides BESIDE the view, so the app is still behind it", () => {
    // A `ViewId` member would have put setup in the rail, in the number keys and in every `go()`
    // call's type — and "Open ohmail meanwhile" could not leave the flow without ending it.
    expect(parseHash("#/first-run").view).toBe("ohbox");
    expect(parseHash("#/ohbox").firstRun).toBe(false);
    expect(parseHash("#/settings/mailboxes").firstRun).toBe(false);
  });
});

describe("a re-run shows the state it is about to change", () => {
  it("with nothing stored, the window is one year — the flow's own default", () => {
    expect(initialWindow()).toBe("365");
  });

  it("all-time is a MODE and is answered before any day count", () => {
    // Reading the rung off `dormancyDays` would put an account that screens EVERYTHING onto
    // whatever number happens to be stored beside the mode.
    expect(initialWindow({ dormancyDays: 90, scope: "all_time" })).toBe("all");
  });

  it("each offered rung is shown as itself", () => {
    expect(initialWindow({ dormancyDays: 90, scope: "window" })).toBe("90");
    expect(initialWindow({ dormancyDays: 180, scope: "window" })).toBe("180");
    expect(initialWindow({ dormancyDays: 365, scope: "window" })).toBe("365");
  });

  it("a stored value that is not on offer takes the NEAREST rung, not the default", () => {
    // Settings stores any day count from 1 to 365; these four are an offer, not the set of
    // storable values. Somebody who set 120 must not be shown "One year".
    expect(initialWindow({ dormancyDays: 120, scope: "window" })).toBe("90");
    expect(initialWindow({ dormancyDays: 200, scope: "window" })).toBe("180");
    expect(initialWindow({ dormancyDays: 60, scope: "window" })).toBe("90");
    expect(initialWindow({ dormancyDays: 1, scope: "window" })).toBe("90");
  });

  it("A FIRST RUN IS HANDED NOTHING, so the dial is 365 and not the product default snapped", () => {
    /* MEASURED on the released 0.13.6, on a fresh HOME: "90 days" was pre-selected while the row
     * beside it read "One year · usual". Nobody had chosen 90 or anything near it.
     *
     * The mechanism is entirely at the MOUNT and the two lines under test are each correct.
     * `consent.dormancyDays` rests at `DEFAULT_DORMANCY_DAYS` (60) — a plausible value filled in
     * deliberately, because it reaches date arithmetic — and `initialWindow` snaps a stored
     * value to the nearest OFFERED rung, and 60 is nearer 90 than 365. So handing the prop
     * unconditionally made the control report a product default as the person's own answer.
     *
     * `screeningBaselineAt` is the truth-condition for "an answer exists": written by the consent
     * transaction and by the first screener decision and by nothing else, and — unlike
     * `dormancyDays` one field along — deliberately NOT filled in with a plausible value.
     *
     * A SOURCE PIN, and weaker than a render, said out loud: what is being asserted is that the
     * prop is WITHHELD, and an absent prop does not render. MUTATION: drop the guard and the two
     * assertions below both go red, which is the released mount exactly. */
    const SHELL = read("apps/webapp/app/shell/AppShell.tsx");
    expect(SHELL, "the mount hands the flow a window nobody chose")
      .toMatch(/\{\.\.\.\(consent\.screeningBaselineAt\s*\n?\s*\? \{ screening: \{ dormancyDays: consent\.dormancyDays, scope: consent\.screeningScope \} \}\s*\n?\s*: \{\}\)\}/);
    expect(SHELL, "an unconditional `screening=` prop is back on the stage")
      .not.toMatch(/\n\s*screening=\{\{ dormancyDays: consent\.dormancyDays/);
    // And the seed with nothing stored is the number the flow writes, not the one it defaults to.
    expect(initialWindow(undefined)).toBe("365");
  });

  it("THE HOLDER'S DATE IS PASSED, and nothing passed it — the screens printed a blank", () => {
    /* `FirstRunProps.organizedSince` is interpolated into `mailboxes.readerSince*` by the claim
     * question's banner and by a reader's summary, and the ONE mount there is never supplied it:
     * both rendered "Since  · ohmail Cloud." A sentence with a hole where a date belongs reads as
     * a bug about the mailbox rather than about the copy, and the summary's own claim is that it
     * names the organizer AND since when.
     *
     * Invisible to the render tests, which pass the prop directly — which is exactly why the pin
     * is on the MOUNT. Withheld when the DTO names no instant, so the screens keep their own
     * "we do not know" arm instead of printing an empty one.
     *
     * MUTATION: delete the spread and both assertions go red. */
    const SHELL = read("apps/webapp/app/shell/AppShell.tsx");
    expect(SHELL, "the flow's holder date has no source")
      .toMatch(/\{\.\.\.\(holderSince \? \{ organizedSince: holderSince \} : \{\}\)\}/);
    expect(SHELL, "the date is derived from the row's own instant, in the app's own language")
      .toMatch(/const holderSince = useMemo\(\(\) => \{[\s\S]{0,400}?organizedBy\?\.since/);
    expect(SHELL).toMatch(/toLocaleDateString\(activeFormatLocale\(\)/);
  });
});

describe("the stage renders the derivation, and holds no step counter", () => {
  it("asks `deriveOnboardingStep` for the step", () => {
    expect(STAGE).toMatch(/deriveOnboardingStep\(facts\)/);
  });

  it("never stores a numeric step, and never increments one", () => {
    // A counter and the facts it claims to summarise drift the moment anything happens outside
    // the flow. The rail's `railAt + 1` is DISPLAY — "3 / 7" — and is derived from the step, not
    // the other way round, so it is excluded by naming the shapes rather than the word "step".
    expect(STAGE).not.toMatch(/useState<number>\(\s*0\s*\)/);
    expect(STAGE).not.toMatch(/setStep\(|step\s*\+\+|step:\s*\w+\.step\s*\+\s*1/);
  });

  it("clears the cursor on every write — `run` is the one write path", () => {
    // `setAt(keepCursor ?? null)` inside `run`, with the clear in a `finally`-guarded flow, is
    // what "re-derive after every write" means concretely.
    expect(STAGE).toMatch(/setAt\(keepCursor \?\? null\)/);
  });
});

describe("the structural rules that do not render", () => {
  it("holds the modal gate and answers EXACTLY ONE key of its own, Escape", () => {
    // The gate silences every shell binding behind the stage (a `g s` there used to unmount it with
    // nothing asked), so the stage's one key is its own listener rather than a keymap binding.
    expect(STAGE).toMatch(/useModalGate\(true\);/);
    expect([...STAGE.matchAll(/chord:\s*"([^"]+)"/g)], "the stage registered a keymap chord").toEqual([]);
    const keys = [...STAGE.matchAll(/e\.key !== "([^"]+)"/g)].map((m) => m[1]);
    expect(keys, "the stage answers a key other than Escape").toEqual(["Escape"]);
  });

  it("Escape ASKS rather than acting — a keystroke may not silently end setup", () => {
    // Cancel writes a completion stamp. A key that stamped it with no confirmation is the kind
    // of thing a person does not know they did.
    expect(STAGE).toMatch(/e\.preventDefault\(\);\s*setConfirm\(\(c\) => \(c === "cancel" \? null : "cancel"\)\);/);
  });

  it("the webapp NEVER imports the desktop's AI provider form", () => {
    // Ruling 2(d) and its claim-pin: the provider step exists on the standalone door alone, and
    // its form is `apps/desktop/src/AiProviderForm.tsx` — the same component Settings → AI
    // mounts, so there is ONE write path to the install's model file. The desktop injects the
    // node; a direct import here would be a second copy of that write path, in a bundle that
    // does not even ship the engine it writes to.
    expect(STAGE).not.toMatch(/AiProviderForm/);
    expect(STAGE, "the provider step must render the INJECTED node").toMatch(/host\.providerForm/);
  });

  it("`Agree and start organizing` is ONE call, carrying the window with the consent", () => {
    // The window cannot be a second request: `screening_baseline_at` is what the window is
    // measured from and the consent is what writes it, so a separate "set the window" call
    // leaves a gap in which the cutoff is the product default rather than the answer just given.
    const organizeCalls = [...STAGE.matchAll(/host\.organize\(/g)];
    // Two call sites: the window's press, and the re-entry claim on the elsewhere screen for a
    // mailbox that has already been consented to and has nothing left to ask.
    expect(organizeCalls).toHaveLength(2);
    expect(STAGE).toMatch(/screening: win === "all"/);
    expect(STAGE).toMatch(/scope: "all_time"/);
    expect(STAGE).toMatch(/dormancyDays: Number\(win\), scope: "window"/);
  });

  it("the window is SEEDED from truth, never from the product default", () => {
    // `DEFAULT_DORMANCY_DAYS` is 60 and is pinned twice elsewhere; onboarding writes 365 by
    // asking for it, so the dial the person sees and the dial that gets stored are the same
    // number. On a RE-RUN the seed is what the account actually holds — the behaviour of
    // `initialWindow` is driven directly in its own describe above; this pins that the control
    // reads it rather than hard-coding a rung.
    expect(STAGE).toMatch(/useState<WindowChoice>\(\(\) => initialWindow\(screening\)\)/);
  });

  it("the pull screen shows a remainder only when the SERVER has counted something", () => {
    // `serverMessageCount` is absent until a cycle has counted a folder, and a "0 still to read"
    // over a running pull is a confident wrong answer.
    expect(STAGE).toMatch(/remaining !== null \? \(/);
    expect(STAGE).toMatch(/t\("etaSoon"\)/);
  });
});

describe("each promise is rendered on the step that makes it", () => {
  /** The body of one step's branch, so a key cannot satisfy a pin from another screen. */
  const stepBody = (marker: string): string => {
    const at = STAGE.indexOf(marker);
    expect(at, `the ${marker} branch is gone`).toBeGreaterThan(-1);
    const rest = STAGE.slice(at + marker.length);
    const end = rest.indexOf('{step === "');
    return end === -1 ? rest : rest.slice(0, end);
  };

  it("`consentBody` and `consentHistory` are on the CONSENT screen", () => {
    const body = stepBody('{step === "consent"');
    expect(body).toMatch(/t\("consentBody"\)/);
    expect(body).toMatch(/t\("consentHistory"\)/);
    // And the promise that nothing has happened yet, which is true only because the consent
    // screen writes nothing at all — the write is one screen later.
    expect(body).toMatch(/t\("consentNothingYet"\)/);
    expect(body, "the consent screen writes something").not.toMatch(/host\.organize|run\(/);
  });

  it("`windowLater` is on the WINDOW screen, beside the choice it qualifies", () => {
    expect(stepBody('{step === "window"')).toMatch(/t\("windowLater"\)/);
  });

  it("`probeOk` is filled from the probe's own three answers and nothing else", () => {
    const body = stepBody('{step === "mailbox"');
    expect(body).toMatch(/host: verdict\.ok\.host, user: verdict\.ok\.user, count: verdict\.ok\.folders/);
  });

  it("the failure verdicts are the mailbox pane's `probe_*`, not a second set", () => {
    // Through the chooser the pane uses too (`probe_<reason>`, or its `_local` twin for a server on
    // this computer, or Google's `probe_auth_gmail_<hint>`): one key family and one function for both surfaces.
    expect(stepBody('{step === "mailbox"')).toMatch(/tm\(probeCopyKey\(verdict\.reason, verdict\.localServer, verdict\.transport, verdict\.authHint, preset\.id\)/);
  });

  it("`elsewhereChoiceHereWhy` is on the ELSEWHERE screen, naming the holder", () => {
    const body = stepBody('{step === "elsewhere"');
    expect(body).toMatch(/t\("elsewhereChoiceHereWhy", \{/);
    expect(body).toMatch(/t\("elsewhereQueued"\)/);
  });

  /**
   * THE CLAIM VERDICT IS ONE SENTENCE AGAIN, ON EVERY DOOR.
   *
   * It was door-aware for a day, and the test that pinned that named ITSELF as the thing to delete
   * when the standalone engine learned to promote on its next cycle. It has (since then the
   * takeover stamp is re-read at the top of every gate, so a press on a running install is
   * honoured on the next poll with no relaunch), so this is that deletion — and its replacement,
   * which pins the collapse rather than leaving the branch to rot into a vaguer sentence on one
   * door.
   */
  it("promises the pass on every door, because every door now makes it", () => {
    const body = stepBody('{step === "elsewhere"');
    expect(body).toMatch(/\{claimed \? <SettingsVerdict state="wait" headline=\{t\("elsewhereQueued"\)\} \/> : null\}/);
    expect(body, "the door-aware branch survived its own premise")
      .not.toMatch(/organizeHereQueued/);
  });


  it("`Connect and continue` is disabled until a test has PASSED", () => {
    const body = stepBody('{step === "mailbox"');
    expect(body).toMatch(/disabled: !tested/);
  });
});

/**
 * THE WAYS IN — asserted from source, and each one exists because the flow was otherwise
 * unreachable from the surface a person is actually looking at.
 */
describe("the entry points", () => {
  it("the cloud funnel hands off INTO the flow, not into a cold mail client", () => {
    // The funnel proves an address, takes a plan and connects a mailbox, and says nothing about
    // what ohmail is about to do to that mailbox. Its last screen opens the flow, which lands on
    // the consent statement because a mailbox now exists.
    const join = read("apps/webapp/app/(product)/join/JoinScreen.tsx");
    expect(join, "the funnel still ends in a bare mail client").toMatch(/href="\/#\/first-run"/);
  });

  it("and never before the address is proven, which the funnel's own order is", () => {
    // Every route the flow's first screens call is refused for an unverified address, so opening
    // it earlier would be a ceremony whose buttons all answer 403. `done` is after `verify`.
    const join = read("apps/webapp/app/(product)/join/JoinScreen.tsx");
    const rail = /const RAIL: Step\[\] = \[([^\]]+)\]/.exec(join)?.[1] ?? "";
    expect(rail).toContain('"verify"');
    expect(rail).toContain('"mailbox"');
    expect(rail.indexOf('"verify"')).toBeLessThan(rail.indexOf('"mailbox"'));
  });

  it("Settings → Mailboxes offers the way back, and asks for the RE-RUN route", () => {
    const pane = read("apps/webapp/app/(product)/mailbox/MailboxSection.tsx");
    expect(pane, "the withheld row is still withheld").toMatch(/t\("setupAgain"\)/);
    expect(pane).toMatch(/t\("setupAgainWhy"\)/);
    // The bare hash would open, find the completion stamp, and close again on the same render.
    expect(pane, "the row opens the flow without the re-run intent")
      .toMatch(/goFirstRun\(\{ rerun: true \}\)/);
  });

  it("…and only when there IS a mailbox to re-run the flow about", () => {
    // The later screens are ABOUT a mailbox: the window is measured from the consent on one, and
    // the summary reports what happened to one. With none connected the row would open a re-run
    // that is immediately a first run — which the "Connect a mailbox" form above already is.
    const pane = read("apps/webapp/app/(product)/mailbox/MailboxSection.tsx");
    expect(pane).toMatch(/stage === "list" && connected\.length > 0 \? \(/);
  });
});

/**
 * "TEST CONNECTION" ON THE MAILBOX PANE — THE second half.
 *
 * The endpoint and its copy shipped with NO caller: neither connect form had a control, so the
 * route was reachable only by hand and a connected mailbox could not be re-checked. Two forms
 * call it now — the flow's step 1 and this pane — and both render the SAME verdict component
 * from the SAME three sentences, which is the half of the row that could otherwise drift.
 */
describe("the mailbox pane can test a connection before it pays for a step-up", () => {
  const pane = read("apps/webapp/app/(product)/mailbox/MailboxSection.tsx");

  it("calls the probe endpoint, and renders the verdict in place", () => {
    expect(pane, "the pane still has no test action").toMatch(/mailboxApi\.probe\(/);
    expect(pane).toMatch(/<SettingsVerdict/);
  });

  it("reuses the flow's SUCCESS sentence rather than writing a second one", () => {
    // `probeOk` interpolates exactly the three facts the endpoint answers with. Two spellings of
    // "the server answered, signed in, N folders" is how one of them names a different number.
    expect(pane).toMatch(/tob\("probeOk", \{/);
    expect(pane).toMatch(/tob\("probeOkDetail"\)/);
  });

  it("and the pane's OWN failure vocabulary, because the refusal is the create's", () => {
    // The service throws the same `probeRefused` on the test and on the create, so the fourteen
    // `probe_*` lines already cover both. An unknown member falls back to the server's sentence.
    expect(pane).toMatch(/t\(probeCopyKey\(probeBad\.reason, false, probeBad\.transport, probeBad\.authHint, ownRefusalOf\(typed\.provider\?\.id\)\)/);
    expect(pane).toMatch(/: probeBad\.message/);
  });

  it("is withheld on the Microsoft sign-in path, where there is no password to prove", () => {
    expect(pane).toMatch(/\{!microsoftOauth \? \(\s*<Button type="button"/);
  });

  it("BOTH callers exist — the row's remaining half was that neither did", () => {
    expect(STAGE, "the flow's step 1 lost its test action").toMatch(/host\.probe\(/);
    expect(pane, "the pane lost its test action").toMatch(/mailboxApi\.probe\(/);
  });
});

/**
 * THE PAIRING STEP WAS UNREACHABLE, and this is the guard for it.
 *
 * `pair` was in `OnboardingStep`, in `onboardingPath` and in the rail's last group — and no state
 * the flow could produce rendered it: the summary's only verb stamped completion and left. A step
 * that exists in the type, the path and the rail, and in no reachable run, is the
 * built-tested-unreachable shape one layer down from the one this whole wave is about. Found while
 * building the render harness, before anything was rendered.
 */
describe("the pairing step is reachable, and only where the door pairs", () => {
  it("the summary offers it as a SECOND verb, not by making 'Open ohmail' advance", () => {
    // Making the primary advance would put a label on a button that does not do what it says: it
    // would not open ohmail, it would show another setup screen.
    expect(STAGE).toMatch(/onClick=\{\(\) => goTo\("pair"\)\}/);
    expect(STAGE).toMatch(/\{t\("pairTitle"\)\}/);
  });

  it("…and withholds the offer where the door has no pairing panel", () => {
    /* AND THE PATH DECIDES TOO. The offer was gated on the panel alone, so an ADD run — whose
       path drops `pair`, because a phone is paired to the INSTALL and not to a mailbox — still
       rendered the verb and `goTo("pair")` walked to a step the run does not contain. */
    expect(STAGE).toMatch(/host\.pairNode && path\.includes\("pair"\) \? \(/);
  });

  it("it is never a RESUME target — only a step inside a run", () => {
    // `deriveOnboardingStep` answers only with steps a truth-condition selects, and pairing is not
    // one: a person who skipped it has finished setup, and re-opening on it at the next boot would
    // be setup reappearing over a mailbox that is already organized.
    const done = facts({
      mailbox: {
        ...CONNECTED,
        organizeConsentedAt: "2026-09-01T10:00:00.000Z",
        initialImportCompletedAt: "2026-09-01T10:40:00.000Z",
      },
      ai: "off",
    });
    expect(firstRunStep(done, null)).toBe("summary");
    expect(firstRunStep(done, null, true)).toBe("consent");
  });

  it("and leaving it STAMPS, because on that path the summary's verb was not pressed", () => {
    const body = STAGE.slice(STAGE.indexOf('{step === "pair"'));
    expect(body.slice(0, 400)).toMatch(/screen\(leave,/);
  });
});

/**
 * THE TWO CODEX FINDINGS AGAINST THE PANE'S TEST ACTION, both of which are the same defect said
 * twice: a verdict that describes something other than what the next press will do.
 */
describe("the pane's verdict describes the configuration it is looking at", () => {
  const pane = read("apps/webapp/app/(product)/mailbox/MailboxSection.tsx");

  it("every probed field clears the verdict when it changes", () => {
    // A green tick describes ONE host, ONE identity and ONE password. Edit any of them and it
    // describes a configuration no longer in the form. The endpoint re-proves everything before a
    // write either way — what is at stake is the sentence on screen.
    for (const field of ["address", "pass"]) {
      expect(pane, `${field} does not clear the verdict`)
        .toContain(`${field}: e.target.value })); clearVerdict();`);
    }
    // The IMAP host goes further — it retires the HOST's evidence, which includes the verdict.
    expect(pane, "the imap host does not retire the old server's evidence")
      .toContain("imapHost: e.target.value }));");
    expect(pane).toContain("retireHostEvidence();");
  });

  it("and so does choosing a different provider", () => {
    // A provider change changes which server would be dialled, so a tick from the previous choice
    // is evidence about a different host entirely.
    // Through `retireHostEvidence`, which calls `clearVerdict` — so it retires the in-flight
    // request as well as blanking the screen, and takes the old server's TLS evidence with it.
    const pick = pane.slice(pane.indexOf("const pickProvider"), pane.indexOf("/** Open the edit form"));
    expect(pick).toContain("retireHostEvidence()");
  });

  it("the TEST dials the same transport shape the CREATE does, manual arm included", () => {
    // The generic preset's nominal 993/TLS is not what the create sends: it OMITS port and mode
    // so the server walks the 993→143 ladder and keeps the rung that answered. Sending the preset
    // pair to the probe would fail a STARTTLS-only server that the very next press accepts.
    const probeBlock = pane.slice(pane.indexOf("const r = await mailboxApi.probe("), pane.indexOf("setProbeOk(r)"));
    // The manual arm sends only what the person typed — a port after the name, never a mode — on both paths.
    expect(probeBlock).toMatch(/chosen\.manual \? splitHostPort\(/);
    expect(probeBlock).toMatch(/port: chosen\.imap\.port, secure: chosen\.imap\.secure \}/);
    // The create's body is built once in `connect` and handed to `sendCreate`, which a parked re-run repeats.
    const createBlock = pane.slice(pane.indexOf("await sendCreate(chosen.manual"), pane.indexOf("}, false);", pane.indexOf("await sendCreate(chosen.manual")));
    expect(createBlock).toMatch(/chosen\.manual \? splitHostPort\(typed\.imapHost\)/);
    // …and the identity resolves to one string on both paths.
    expect(probeBlock).toMatch(/user: typed\.user\.trim\(\) \|\| address/);
  });
});

/**
 * ROUND TWO OF THE REVIEW: the round-one fixes were only half of the rule.
 *
 * Clearing a verdict when a field changes does nothing about the test ALREADY IN FLIGHT, which
 * resolves later and does not know the form has moved. Start a test against A, edit a field to B —
 * the verdict clears, correctly — A's answer lands, and A's green tick is sitting over B, having
 * REAPPEARED with nothing pressed. The clear made that worse rather than better.
 *
 * It is sharper on the flow's step 1 than on the settings pane: there the verdict AUTHORISES,
 * because "Connect and continue" is gated on it, so a stale green arms a submit for a
 * configuration nobody proved.
 */
describe("a verdict may not arrive after the form it describes has moved", () => {
  const pane = read("apps/webapp/app/(product)/mailbox/MailboxSection.tsx");

  /**
   * ROUND THREE: THE GENERATION COUNTER ALONE DID NOT DO IT, and believing it did was the defect.
   *
   * Advancing the sequence only when a test STARTS orders concurrent presses and NOTHING else.
   * Press Test for A, edit a field to B while it is pending, and A's answer still carries the
   * current generation — so it lands, over B. The clear has to advance the sequence as well, which
   * is what makes an EDIT invalidate a request rather than merely blank the screen.
   */
  it("an EDIT retires the request in flight, not merely the sentence on screen", () => {
    expect(STAGE, "the flow's clear does not retire the request")
      .toContain("testSeq.current += 1;");
    expect(pane, "the pane's clear does not retire the request")
      .toContain("probeSeq.current += 1;");
    // …and the pending line stops claiming a request that is no longer ours.
    expect(STAGE).toMatch(/testSeq\.current \+= 1;[\s\S]{0,80}setTesting\(false\)/);
    expect(pane).toMatch(/probeSeq\.current \+= 1;[\s\S]{0,200}setProbing\(false\)/);
  });

  it("every field handler goes through the retire, not through a bare clear", () => {
    // A handler that only blanked the verdict would leave the in-flight answer free to land.
    for (const f of ["setAddress", "setPass", "setImapHost", "setImapPort", "setSmtpHost", "setSmtpPort"]) {
      expect(STAGE, `${f} does not retire`).toContain(`${f}(e.target.value); retireTest();`);
    }
  });

  it("cancelling the pane's form retires too — a reopen may not receive the old answer", () => {
    const cancel = pane.slice(pane.indexOf('setStage("list"); setTyped(emptyTyped())'));
    expect(cancel.slice(0, 500)).toContain("clearVerdict()");
  });

  it("and a SUCCESSFUL connect clears it, so a later reopen shows no tick over an empty form", () => {
    const done = pane.slice(pane.indexOf("// The password leaves this component the moment"));
    expect(done.slice(0, 900)).toContain("clearVerdict()");
  });

  /**
   * ROUND FOUR: `microsoftOauth` IS NOT A STABLE FACT ABOUT THE FORM.
   *
   * The deployment's OAuth availability is read asynchronously, so it can flip to true UNDER
   * somebody who already chose Microsoft, typed an app password and pressed Test. The fields and
   * the Test button vanish and "Continue" becomes the consent ceremony — a different act — while
   * the app-password verdict stayed on screen describing the path nobody is taking any more.
   */
  it("an OAuth door that opens mid-form retires the app-password verdict", () => {
    expect(pane).toMatch(/if \(microsoftOauth\) clearVerdict\(\);/);
  });

  it("…and no verdict renders on the OAuth path at all, so the frame before that is honest too", () => {
    // The same gate the Test button already carries. Without it there is one render between the
    // flip and the effect in which the stale verdict is on screen.
    for (const guard of ["{!microsoftOauth && probing ?",
                         "{!microsoftOauth && !probing && probeOk ?",
                         "{!microsoftOauth && !probing && probeBad ?"]) {
      expect(pane, `a verdict renders on the OAuth path: ${guard}`).toContain(guard);
    }
  });

  /**
   * ROUND FIVE: BACK ONTO THE MAILBOX STEP MUST NOT CONNECT A SECOND MAILBOX.
   *
   * That step's forward verb CREATES, and Back from the consent screen lands on it — on a run
   * whose mailbox now exists. The green verdict from before the connect was still on screen, so
   * the primary was still enabled, and pressing it called `connect` again for a mailbox that was
   * already connected, on the strength of evidence gathered before it was.
   */
  it("a run that already has a mailbox CONTINUES from that step instead of creating another", () => {
    const at = STAGE.indexOf('{step === "mailbox"');
    expect(at, "the mailbox branch is gone").toBeGreaterThan(-1);
    const body = STAGE.slice(at, STAGE.indexOf('{step === "elsewhere"'));
    expect(body).toContain("if (facts.mailbox !== null) { forward(); return; }");
    // …and the guard runs BEFORE the create, not after it.
    expect(body.indexOf("facts.mailbox !== null")).toBeLessThan(body.indexOf("connectTyped("));
  });

  /**
   * ROUND SIX: A SCREEN WHOSE EVERY CONTROL IS A LIE IS NOT FIXED BY DISARMING ONE OF THEM.
   *
   * Round five stopped the duplicate connect, and left the FORM on screen for a run whose mailbox
   * already exists — fields describing a stored mailbox, a "Test connection" that would prove a
   * login nobody is about to use, and a primary that can only navigate whatever the verdict says.
   * A person who tested, got a green tick and pressed on would have watched a successful test
   * authorise nothing at all.
   */
  it("the mailbox step is a STATEMENT once a mailbox exists, not a form", () => {
    const at = STAGE.indexOf('{step === "mailbox"');
    const body = STAGE.slice(at, STAGE.indexOf('{step === "elsewhere"'));
    expect(body).toContain("facts.mailbox !== null ? (");
    // The statement names the mailbox and offers only the forward verb.
    expect(body).toContain('tj("mailboxConnected", { address: mailboxAddress ?? "" })');
    // The form — provider picker, fields, Test — is on the OTHER arm.
    expect(body.indexOf("facts.mailbox !== null ? (")).toBeLessThan(body.indexOf("SettingsChoice"));
    expect(body.indexOf("facts.mailbox !== null ? (")).toBeLessThan(body.indexOf("void test()"));
  });

  it("and a successful connect retires the verdict that authorised it", () => {
    const at = STAGE.indexOf("await host.connect(");
    expect(at, "the connect call is gone").toBeGreaterThan(-1);
    expect(STAGE.slice(at, at + 400)).toContain("retireTest();");
  });

  /**
   * ROUND SEVEN: THE PROBE'S VERDICT IS NOT THE ONLY EVIDENCE ON THESE SCREENS.
   *
   * Two more things reported on a configuration and survived it changing — and one of them is a
   * consent rather than a sentence, which is why it is the sharper half.
   */
  it("a host change retires the PLAINTEXT CONSENT, not only the verdict", () => {
    // `allowInsecure` is sent by the create and by the test. Granted about server A and carried
    // onto server B, it offers B an exemption nobody granted it: a password in the clear to a host
    // that was never asked about. The checkbox's OWN handler must not call this, or ticking it
    // would un-tick it.
    /* The declaration, not a byte count: `sliceOfDeclaration` throws
       `anchor not found: retireHostEvidence` if it is gone, which is what the `toContain` on the
       hook spelling here was standing in for — and that spelling pinned a hook the case was never
       about, so a codemod would have reddened it with the wrong sentence. The +700 window it
       replaces cut this declaration off well short of its full length, which is why the SMTP and edit
       arms below had to be pinned from their own windows. */
    const retire = sliceOfDeclaration(pane, "retireHostEvidence");
    expect(retire).toContain("setInsecureOffer(NO_OFFER)");
    expect(retire).toContain("allowInsecure: false");
    // The SMTP consent is evidence about the SMTP server, and goes with the host the same way.
    expect(retire).toContain("allowInsecureSmtp: false");
    expect(retire).toContain("setSuggestion(null)");
    // The three sites that change WHICH server is addressed.
    expect(pane).toContain("imapHost: e.target.value }));\n                      retireHostEvidence();");
    const pick = pane.slice(pane.indexOf("const pickProvider"), pane.indexOf("/** Open the edit form"));
    expect(pick).toContain("retireHostEvidence()");
    const apply = pane.slice(pane.indexOf("const applySuggestion"), pane.indexOf("const applySuggestion") + 900);
    expect(apply).toContain("retireHostEvidence()");
  });

  /**
   * ROUND EIGHT'S OTHER HALF — THE EDIT ARM, WHICH SHARES THE STATE AND RETIRED NONE OF IT.
   *
   * The connect arm's four host-changing sites route through `retireHostEvidence`. The EDIT arm
   * renders the same `insecureOffer` and the same `suggestion` — one state, two forms — and its
   * own host fields called plain `setEdited`. Two consequences, and the first is the same defect
   * the connect arm took eight rounds to close:
   *
   *  · server A reports it has no TLS, the person ticks the opt-in, changes the host to B, and
   *    the save sends `allowInsecure` for B — a password in the clear to a server nobody was
   *    asked about;
   *  · `startEdit` left the offer and the suggestion standing, so opening a DIFFERENT mailbox's
   *    edit form showed the previous mailbox's TLS offer and its certificate's host suggestion.
   *
   * Filed rather than swept into the connect-arm slice, and taken here on its own.
   */
  it("the EDIT arm retires host evidence too — it shares the state and changed the host", () => {
    const editHost = pane.slice(pane.indexOf("{ ...v, host: e.target.value }"), pane.indexOf("{ ...v, host: e.target.value }") + 200);
    expect(editHost, "the edit form's IMAP host field").toContain("retireHostEvidence()");
    /* ANCHORED ON `setEdited`, because the connect arm writes the same field name through
       `setTyped` and appears EARLIER in the file — a bare `indexOf` on the field lands on the
       connect arm's site and would pass while the edit arm's stayed unrouted. */
    const editSmtpAt = pane.indexOf("setEdited((v) => ({ ...v, smtpHost: e.target.value }))");
    expect(editSmtpAt, "the edit form's SMTP host handler was not found").toBeGreaterThan(-1);
    const editSmtp = pane.slice(editSmtpAt, editSmtpAt + 400);
    expect(editSmtp, "the edit form's SMTP host field").toContain("retireHostEvidence()");
  });

  it("…and `retireHostEvidence` clears the EDIT form's consent, not only the connect form's", () => {
    // One function for both arms is what the fix is: the two forms render one `insecureOffer` and
    // one `suggestion`, and only one of them is on screen at a time. A second retire function
    // would be two places for the rule that a consent belongs to the host it was granted about.
    const retire = sliceOfDeclaration(pane, "retireHostEvidence");
    expect(retire).toContain("setEdited((v) => (v.allowInsecure");
  });

  it("opening ANOTHER mailbox's edit form starts with no evidence about the last one", () => {
    // `startEdit` reset the form and left the shared offer and suggestion standing, so the pane
    // switched mailbox carrying a TLS offer and a certificate hostname proved about a different
    // server entirely.
    const start = pane.slice(pane.indexOf("const startEdit = "), pane.indexOf("const startEdit = ") + 1100);
    expect(start).toContain("retireHostEvidence()");
  });

  it("…and the checkbox's own handler does NOT, or ticking it would untick it", () => {
    const box = pane.slice(pane.indexOf("allowInsecure: on"), pane.indexOf("allowInsecure: on") + 220);
    expect(box).toContain("clearVerdict()");
    expect(box).not.toContain("retireHostEvidence()");
  });

  it("the flow retires a FAILED WRITE's sentence too, not only the test's verdict", () => {
    // A refused connect writes `problem`. Editing the address afterwards left that refusal beside
    // the new configuration, and a fresh green test did not remove it — two code paths, one of
    // them retired.
    /* The declaration (635 bytes) in place of a 900-byte window off a hook spelling: narrower,
       and bounded by the code rather than by a number that drifts as the callback grows. */
    const retire = sliceOfDeclaration(STAGE, "retireTest");
    expect(retire).toContain("setProblem(null)");
  });

  /**
   * ROUND EIGHT: A WRITE CAN BE OVERTAKEN TOO, and it is the case that looks impossible.
   *
   * A test is obviously racy. A WRITE looks like it cannot be overtaken — you pressed Connect, the
   * answer is about what you pressed — but the form goes on accepting edits while it is in flight,
   * and the refusal was written unconditionally. Press Connect for A, edit the address to B, A is
   * refused: A's sentence appears over B with no B press. The evidence had been retired and then
   * came back.
   */
  it("a refused WRITE reports only if the form has not moved under it", () => {
    /* The declaration, which ends three bytes short of the comment this used to stop at — that
       comment IS the next sibling's docblock, so the helper's structural bound and the hand-typed
       one were aiming at the same place. One of them survives a rename. */
    const run = sliceOfDeclaration(STAGE, "run");
    expect(run).toContain("const mine = testSeq.current;");
    expect(run).toContain("if (testSeq.current === mine) {");
    // The CURSOR still moves — the derivation is entitled to answer over the newest facts — so the
    // guard is on the SENTENCE alone, not on the whole catch.
    //
    // THE CLEAR BECAME CONDITIONAL when the re-run loop was closed, and both halves are pinned
    // here rather than the old unconditional one being relaxed. On `#/first-run/again` there is
    // no derivation to answer — a finished account derives to "nothing to do" — so `null` means
    // the consent statement, and a failure that cleared the cursor walked back to a screen that
    // does not render the sentence explaining it. `first-run-rerun-loop.test.tsx` drives it.
    // AND THE FOUR WRITES THAT ASK TO STAY — Agree, the take-over, Connect and Forget, whose step-up 403
    // must stay on their screen with its sentence and the code prompt;
    // `first-run-agree-step-up.test.tsx` drives them.
    expect(run).toContain("setAt(rerun === true || opts.stayOnFailure === true ? here : null);");
    expect(STAGE.match(/stayOnFailure: true/g) ?? [], "only the step-up writes stay on a refusal").toHaveLength(4);
  });

  it("the pane retires a failed create's sentence on EVERY field edit, not only a host change", () => {
    // Retiring it on a host change covers "the certificate is for another name" and misses the
    // commoner one: an auth refusal, then the password is corrected, and "That mail server refused
    // the password" goes on describing a credential that is no longer in the form.
    /* The declaration alone rather than everything up to `retireHostEvidence`.
       The difference is entirely `retireHostEvidence`'s own DOCBLOCK, which the
       old bound pulled into a window judging THIS callback — prose naming `insecureOffer`,
       `allowInsecure` and `suggestion`. `setError(null)` does not appear in it, so nothing here
       was passing on a comment; the helper gives a sibling's docblock back to the sibling, so
       nothing here can start to. */
    const clear = sliceOfDeclaration(pane, "clearVerdict");
    expect(clear).toContain("setError(null)");
  });

  it("the SMTP host is the FOURTH host-changing site and routes through the same retire", () => {
    // An SMTP failure mints a suggestion about the SMTP host; leaving it after the field changes
    // lets one press replace the new host with a name proved about the old one.
    const smtp = pane.slice(pane.indexOf("smtpHost: e.target.value }));"), pane.indexOf("smtpHost: e.target.value }));") + 500);
    expect(smtp).toContain("retireHostEvidence()");
  });

  it("both callers guard the landing with a generation counter", () => {
    for (const [name, src, seq] of [["the flow", STAGE, "testSeq"], ["the pane", pane, "probeSeq"]] as const) {
      expect(src, `${name} has no generation ref`).toContain(`const ${seq} = useRef(0)`);
      expect(src, `${name} does not claim a generation`).toContain(`++${seq}.current`);
      // BOTH landings, and the busy flag with them — an overtaken test that cleared `busy` would
      // re-enable the button while a newer request is still running.
      const guards = src.split(`${seq}.current !== mine`).length - 1;
      expect(guards, `${name} guards ${guards} landings, expected 2`).toBe(2);
      expect(src).toContain(`${seq}.current === mine) set`);
    }
  });

  it("the pane's TEST sends the plaintext opt-in, because its CREATE does", () => {
    // It is the one field that decides whether a server with no TLS is acceptable at all, so a
    // test that omitted it would refuse exactly the configuration the next press stores.
    const probeBlock = pane.slice(pane.indexOf("const r = await mailboxApi.probe("), pane.indexOf("setProbeOk(r)"));
    expect(probeBlock).toMatch(/typed\.allowInsecure \? \{ allowInsecure: true \} : \{\}/);
  });

  it("…and a provider change resets that opt-in rather than carrying it across", () => {
    // It is a consent about ONE server that reported no TLS. Carrying it into another provider's
    // attempt would grant that server the same exemption on somebody else's evidence.
    // Reset inside `retireHostEvidence`, which the provider change routes through — one place
    // that retires everything learned about a server, rather than three lists that can drift.
    const pick = pane.slice(pane.indexOf("const pickProvider"), pane.indexOf("/** Open the edit form"));
    expect(pick).toContain("retireHostEvidence()");
    const retire = pane.slice(pane.indexOf("const retireHostEvidence"), pane.indexOf("const retireHostEvidence") + 700);
    expect(retire).toContain("allowInsecure: false");
  });

  it("the host SUGGESTION press clears the verdict — it rewrites a host without a field handler", () => {
    // And it can rewrite BOTH hosts at once (the vanity pair), which is exactly where a tick for
    // the old IMAP host is most likely to be left standing over a new one.
    const apply = pane.slice(pane.indexOf("const applySuggestion"), pane.indexOf("const applySuggestion") + 900);
    expect(apply).toContain("retireHostEvidence()");
  });

  it("the SMTP fields retire a verdict too, on both callers", () => {
    // Neither probe sends SMTP — but both creates do, and the verdict is what stands in front of
    // that create. A green tick that survived an SMTP edit would describe less than it appears to.
    // Through `retireHostEvidence` now — the SMTP host is a host-changing site, so it retires the
    // suggestion and the consent as well as the verdict.
    const smtp = pane.slice(pane.indexOf("smtpHost: e.target.value }));"), pane.indexOf("smtpHost: e.target.value }));") + 500);
    expect(smtp).toContain("retireHostEvidence()");
    expect(STAGE).toContain("setSmtpHost(e.target.value); retireTest();");
    expect(STAGE).toContain("setSmtpPort(e.target.value); retireTest();");
  });
});

/**
 * ═══ WHICH MAILBOX THE RUN IS ABOUT, ONCE AN INSTALL CAN HOLD MORE THAN ONE ════════════════
 *
 * `AppShell` resolved it as `facts[0]`, with a note calling that "a decision rather than an
 * oversight": the flow is about getting ONE mailbox organized, and an account with several has
 * been through it. That was true of the hosted door and stopped being true of the standalone one
 * the day it could hold two.
 *
 * WHAT `facts[0]` COSTS over two rows, and it is not cosmetic: every screen in the run reads
 * this mailbox's facts — the holder the claim question names, the consent stamp the derivation
 * turns on, the address the connect step states — and `organize` addresses `mailboxId`. So the
 * flow for the SECOND mailbox would have shown the first one's state and then consented on the
 * first one's behalf.
 *
 * Asserted over the source. Mounting `AppShell` needs a dozen providers, a mail-state poller and
 * an engine; the thing that can go wrong here is one expression, and the mutation is to restore
 * the old one.
 */
describe("the run's subject comes off the route, not off the first row", () => {
  const shell = read("apps/webapp/app/shell/AppShell.tsx");

  /* ── THE THREE RULES BELOW MOVED OUT OF THIS FILE'S SOURCE PINS ─────────────────────────────
   *
   * They were three regular expressions over `AppShell.tsx` — `facts.find((m) => m.id === …)`,
   * the `addPending` expression, the whole `firstRunMailbox` ternary — and they measured the
   * spelling of an inline expression rather than the rule. The expression is
   * `firstRunSubject` now, so the rules are DRIVEN here and the seam is asked separately, by
   * parsing, in `first-run-mount-census.test.ts`. Each finding is kept verbatim: they are the
   * record of what was measured going wrong, and the rules have not been weakened — the third
   * one is stronger, because an unresolvable id is now `vanished` rather than `null`.
   */
  const rows = [{ id: "mb-1" }, { id: "mb-2" }];

  it("resolves the named mailbox and falls back to the one row only when none is named", () => {
    expect(firstRunSubject(rows, "mb-2", false).mailbox).toBe(rows[1]);
    /* THE FALLBACK IS KEPT for a hash that names nothing on an install with ONE row. With several
       it is `choose` — the stage asks which — because the list's order put a first run on a refused
       attempt's bare row while the mailbox just connected stayed unconsented. */
    expect(firstRunSubject([rows[1]!], null, false).mailbox).toBe(rows[1]);
    expect(firstRunSubject(rows, null, false)).toEqual({ mailbox: null, state: "choose" });
  });

  it("an ADD run NEVER falls back to the first row — the window with a wrong-mailbox write", () => {
    /* ── REVIEW FINDING ─────────────────────────────────────────────────────────────────────
     *
     * `addPending` was `route.firstRunAdd && route.firstRunMailboxId === null`, which goes false
     * the instant `onConnected` puts the new id in the hash — while `facts` still holds the
     * pre-create list until `refreshFacts` round-trips. `facts.find(id)` missed and `?? facts[0]`
     * resolved the run to mailbox #1: its address on the screen, its consent stamp in the
     * derivation, its id in `mailboxId`. `run()` clears `busy` before the refetch lands, so the
     * consent press was live in that window and would have posted
     * `POST /local/mailboxes/<mailbox #1>/organize` — writing the window chosen for #2 onto #1.
     *
     * So "pending" is "the facts do not hold the row this run names", which also covers the same
     * window arriving because `GET /mailboxes` is stale or failing. */
    expect(firstRunSubject(rows, null, true)).toEqual({ mailbox: null, state: "pending" });
    expect(firstRunSubject(rows, "mb-3", true)).toEqual({ mailbox: null, state: "pending" });
  });

  it("NO run resolves to another mailbox when its hash names one the facts do not hold", () => {
    /* ── REVIEW FINDING: the add path was hardened and the RE-RUN path was not ───────────────
     *
     * The re-run names a mailbox too — the row's own "Run setup" navigates to
     * `#/first-run/again?mailbox=<id>` — and had no equivalent guard. Let the poller drop that row
     * (a removal from another surface, a stale or failing `GET /mailboxes`) and `?? facts[0]`
     * resolved the run to mailbox #1; the window screen's press then posts `organize` for THAT
     * mailbox with the window somebody chose for a different one. Same wrong-mailbox write.
     *
     * So the rule is about the HASH, not the intent: a run that NAMES a mailbox is about that
     * mailbox or about none. It is now about none BY NAME — `vanished`, which the stage refuses
     * rather than turning into the seed connect form. */
    const gone = firstRunSubject(rows, "mb-gone", false);
    expect(gone.mailbox).toBeNull();
    expect(gone.state).toBe("vanished");
  });

  it("the rail never reports a phase index it does not have", () => {
    /* ── REVIEW FINDING ─────────────────────────────────────────────────────────────────────
     *
     * `findIndex` against the full seven-group list always matched, because every step belongs to
     * a group. Against the PATH-FILTERED rail it can miss: the reachable case is `decide`, whose
     * group leaves the rail the moment a background pass drains the Screener queue to zero while
     * somebody is on that screen. `-1` printed "0 / 6" with no dot lit. */
    expect(STAGE).toMatch(/const railFound = rail\.findIndex\(/);
    expect(STAGE).toMatch(
      /const railAt = railFound === -1 \? Math\.max\(0, rail\.length - 1\) : railFound;/,
    );
  });

  it("withholds the mailbox while an ADD run has not made one yet", () => {
    /* The add run opens on the connect FORM, and the form is withheld the moment `facts.mailbox`
       is non-null — the step becomes a statement about the mailbox the run is about, which is
       right for a Back press and wrong here. On an install that already holds mailboxes the
       fallback above would hand the stage row #1, so somebody who pressed "Add mailbox" would be
       shown a statement about a mailbox they already have. */
    /* ONE GATE, not four. `addPending` used to be spelled again at each of the three props that
       could name a mailbox — the facts, `mailboxId` and `mailboxAddress` — which is three chances
       for the next edit to forget one. It resolves `firstRunMailbox` to `null` now, so every
       consumer is covered by construction. */
    expect(shell).toMatch(/mailbox: firstRunMailbox === null \? null :/);
    expect(shell).toMatch(/mailboxId=\{firstRunMailbox\?\.id \?\? null\}/);
  });

  it("hands the created mailbox's id back to the route, without a history entry", () => {
    /* `nameFirstRunMailbox` uses `replaceState`: the create is not a place somebody navigated to,
       and an assignment would stack an entry whose Back press lands on a connect form for a
       mailbox that now exists. */
    expect(shell).toMatch(/onConnected=\{nameFirstRunMailbox\}/);
    const routing = read("apps/webapp/app/shell/routing.ts");
    const fn = routing.slice(routing.indexOf("export function nameFirstRunMailbox"));
    expect(fn.slice(0, 500)).toContain("window.history.replaceState");
    /* AND THE EVENT IS DISPATCHED BY HAND. `replaceState` fires no `hashchange`, and
       `useHashRoute` subscribes to exactly that — without it the shell would go on rendering the
       old route until something else moved the hash. */
    expect(fn.slice(0, 500)).toContain('window.dispatchEvent(new Event("hashchange"))');
  });

  it("passes the add intent down, so the connect mode is never a fallback", () => {
    expect(shell).toMatch(/add=\{route\.firstRunAdd\}/);
    // The stage states the word rather than letting the host choose one.
    expect(STAGE).toMatch(/host\.connect\(mailboxInput\(\), add === true \? "add" : "seed"\)/);
  });
});

/**
 * ═══ THE CLAIM SCREEN MAY NOT OUTLIVE THE CLAIM ═══════════════════════════════════════════
 *
 * `FIRSTRUN-NO-HOLDER-SCREEN-SAYS-ANOTHER-INSTALL`, measured on the released build. The
 * `elsewhere` screen is written for one situation — SOMEBODY ELSE organizes this mailbox — and
 * every sentence on it is about that somebody: its title, its lead and the two choice
 * descriptions all name "another install", and the two choices are "let them keep it" and "take
 * it from them".
 *
 * `deriveOnboardingStep`'s row 3 is right: it requires a recorded holder, so the derivation never
 * opens this screen without one. The CURSOR does. `at` is a navigation aid that outranks the
 * derivation for every screen, and once somebody is standing on `elsewhere` the holder can go
 * away underneath them — a release on the other install, a claim that lapsed — leaving four
 * sentences about an install that no longer holds anything, and a choice between keeping it there
 * and taking it back.
 *
 * The banner inside the screen already tells the truth for that state (`readerNobodyReads`,
 * landed with the reader-row states), which is what makes the rest of the screen contradict
 * itself rather than merely being wrong. The answer is not to reword four sentences into a state
 * they were not written for: it is that the screen is not the screen for this state, so the
 * cursor releases and the derivation says where the run actually is.
 *
 * WATCH IT FAIL: delete the cursor's holder check in `firstRunStep` and this file's first two
 * cases red with `"elsewhere"` standing over a mailbox nothing organizes.
 */
describe("the elsewhere screen is not shown once nothing holds the mailbox", () => {
  /** A mailbox this account consented to, that nothing organizes any more — a completed stop. */
  const RELEASED = {
    organizerRole: "reader" as const,
    organizedBy: null,
    organizerState: null,
    organizeConsentedAt: "2026-09-01T10:00:00.000Z",
    initialImportCompletedAt: null,
  };

  it("a cursor parked on the claim question releases when the holder goes", () => {
    const f = facts({ mailbox: RELEASED });
    /* The derivation's own answer for this mailbox — consent is stamped, the import is not
       finished, so the run resumes on the pull. Whatever it is, it is not the claim question. */
    expect(firstRunStep(f, "elsewhere"),
      "a screen about another install stood over a mailbox nothing organizes")
      .not.toBe("elsewhere");
    expect(firstRunStep(f, "elsewhere"), "the run lost its place instead of resuming")
      .toBe(firstRunStep(f, null));
  });

  it("…and a RE-RUN's cursor releases too — the same screen through the other door", () => {
    const f = facts({
      mailbox: RELEASED,
      account: { onboardingCompletedAt: "2026-09-02T08:00:00.000Z" },
    });
    expect(firstRunStep(f, "elsewhere", true),
      "the re-run arm returns the cursor before the derivation is consulted")
      .not.toBe("elsewhere");
  });

  it("CONTROL — a mailbox somebody DOES hold keeps the screen, cursor or no cursor", () => {
    const held = facts({
      mailbox: {
        organizerRole: "reader",
        organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
        organizerState: "held",
        organizeConsentedAt: null,
        initialImportCompletedAt: null,
      },
    });
    expect(firstRunStep(held, "elsewhere"),
      "the claim question lost the one state it is written for").toBe("elsewhere");
    expect(firstRunStep(held, null)).toBe("elsewhere");
  });

  it("a read that carried NO ANSWER does not release the cursor", () => {
    /* THE STATE THE COLLAPSE HID. `readerHolder` maps an absent field to "nobody" — right for a
       SENTENCE, since neither state names an install — and this seam read that as "the mailbox is
       free" and took the screen away. Two shapes reach it, and the first is the ordinary one:
       the run's mailbox is not in the facts at all (a removal from another surface, a stale or
       failing list, an add whose create has not answered). Nothing was read, so nothing may be
       concluded, and the screen a person is standing on stays. */
    expect(firstRunStep(facts({ mailbox: null }), "elsewhere"),
      "a run whose mailbox the facts do not hold released the claim question")
      .toBe("elsewhere");

    /* The second shape is a row that carried no organizer field. No producer emits it today —
       both map absent to null at their own seam — and it is honoured rather than counted as a
       defence, because a wire change would reintroduce the state silently. */
    const noField = facts({
      mailbox: {
        organizerRole: "reader",
        organizerState: null,
        organizeConsentedAt: null,
        initialImportCompletedAt: null,
      },
    });
    expect(firstRunStep(noField, "elsewhere"),
      "a read that said nothing about the organizer released the claim question")
      .toBe("elsewhere");
  });

  it("CONTROL — a first run with NO holder from the first read never sees the screen", () => {
    /* The positive control, and the thing that stops the rule above from being "the screen never
       goes away": a mailbox whose read explicitly carries no holder derives to the consent
       statement with no cursor at all, and the claim question is not in the walk. */
    const free = facts({ mailbox: RELEASED });
    expect(firstRunStep(free, null), "the claim question was shown for a free mailbox")
      .not.toBe("elsewhere");
    expect(firstRunStep(free, null)).toBe(firstRunStep(free, "elsewhere"));
  });

  it("a LATE-LANDING nobody does not release the cursor; a later one does", () => {
    /* THE ORDERING HALF, and the one the content of a read cannot answer: two reads of an account
       can be in flight together and settle in either order, so a `nobody` prepared before the
       holder was recorded lands after the one that showed it and says exactly what a current one
       would say. `organizerEventAt` is what tells them apart — every writer that changes the
       organizing story stamps it in the same statement, so the read that showed the holder is a
       floor.

       The middle instant is the stamp the screen was shown under. The first is older: a read issued before the holder
       existed. The third is newer: the release actually happening. */
    const t1 = "2026-09-07T09:00:00.000Z";
    const t2 = "2026-09-07T09:05:00.000Z";
    const t3 = "2026-09-07T09:10:00.000Z";
    const freeAt = (stamp: string | null) => facts({
      mailbox: { ...RELEASED, organizerEventAt: stamp },
    });

    expect(firstRunStep(freeAt(t1), "elsewhere", false, false, false, t2),
      "a read issued before the holder existed took the claim question away")
      .toBe("elsewhere");
    expect(firstRunStep(freeAt(t3), "elsewhere", false, false, false, t2),
      "the release the person is waiting for did not move the run on")
      .not.toBe("elsewhere");
    /* EQUAL RELEASES. A read can repeat a stamp while another column moves, and refusing an equal
       one would refuse the ordinary case — which is how a rule like this becomes a screen nobody
       can leave. */
    expect(firstRunStep(freeAt(t2), "elsewhere", false, false, false, t2),
      "a read carrying the floor's own stamp was refused as older")
      .not.toBe("elsewhere");
    /* A ROW THAT WENT BACKWARDS — no stamp at all where the floor had one. Only a read issued
       before the stamp existed can do that. */
    expect(firstRunStep(freeAt(null), "elsewhere", false, false, false, t2),
      "a read that lost the stamp altogether was taken as current")
      .toBe("elsewhere");
    /* AND NO FLOOR IS NO EVIDENCE, not a refusal: with nothing to compare against the explicit
       verdict stands on its own, which is the behaviour before this rule existed. Without this
       the screen would be unleavable on any mailbox whose holder was recorded without a stamp. */
    expect(firstRunStep(freeAt(null), "elsewhere", false, false, false, null),
      "with no floor to compare against the run was parked on the claim question")
      .not.toBe("elsewhere");
  });

  it("an OMITTED organizer field is unknown; only an explicit null is nobody", () => {
    /* THE COLLAPSE THAT MADE THE `unknown` ARM UNREACHABLE. Both producers normalized an absent
       field to `null` — `mailbox-facts.ts` with `?? null`, the desktop mapper with a ternary — so
       a lagging read arrived at this seam saying "nobody organizes this mailbox" and the arm
       written for "the read did not answer" could never be entered. The service projects the
       field unconditionally and the DTO declares it non-optional, so absent is an API older than
       the field and nothing else; it is now carried as absent by both.

       Here that is asserted at the SEAM rather than at the producers, because the seam is what
       decides which screen somebody sees: the two shapes must not agree. */
    const omitted = facts({
      mailbox: {
        organizerRole: "reader",
        organizerState: null,
        organizeConsentedAt: null,
        initialImportCompletedAt: null,
        organizerEventAt: "2026-09-07T09:00:00.000Z",
      },
    });
    const explicitNull = facts({
      mailbox: { ...omitted.mailbox!, organizedBy: null },
    });
    expect(firstRunStep(omitted, "elsewhere", false, false, false, "2026-09-07T09:05:00.000Z"),
      "a read that omitted the organizer field released the claim question")
      .toBe("elsewhere");
    expect(firstRunStep(explicitNull, "elsewhere", false, false, false, null),
      "an explicit 'nobody organizes this' did not move the run on")
      .not.toBe("elsewhere");
  });

  it("CONTROL — the ordering rule never fires while a holder is still named", () => {
    /* The floor only ever refuses a `nobody`. A read that still names a holder is refused by the
       verdict one condition earlier, whatever its stamp says — so an old stamp on a held row
       cannot be read as "the holder went away and came back". */
    const held = facts({
      mailbox: {
        organizerRole: "reader",
        organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
        organizerState: "held",
        organizeConsentedAt: null,
        initialImportCompletedAt: null,
        organizerEventAt: "2026-09-07T08:00:00.000Z",
      },
    });
    expect(firstRunStep(held, "elsewhere", false, false, false, "2026-09-07T09:05:00.000Z"))
      .toBe("elsewhere");
  });

  it("CONTROL — a holder with no NAME is still a holder, and keeps the screen", () => {
    /* `readerHolder`'s middle state: the columns were written and this build cannot name the
       install. The screen's legacy label is written for exactly that, so the cursor must not
       release on it — an empty name is not an empty mailbox. */
    const unnamed = facts({
      mailbox: {
        organizerRole: "reader",
        organizedBy: { kind: null, name: "", since: "2026-08-30T09:00:00.000Z" },
        organizerState: "held",
        organizeConsentedAt: null,
        initialImportCompletedAt: null,
      },
    });
    expect(firstRunStep(unnamed, "elsewhere"),
      "a holder this build cannot name was read as no holder at all").toBe("elsewhere");
  });
});

/**
 * ═══ AND THE QUESTION THE DERIVATION PUT UP IS THE ONE NOBODY WAS GUARDING ══════════════════
 *
 * Everything above reads the release rule through the CURSOR, and that is the defect it missed.
 * The claim question's ORDINARY arrival is the derivation's: connect a mailbox somebody else
 * holds, the peek lands, row 3 puts the screen up — and nothing has been pressed, so `at` is
 * still null and the rule did not run at all. A `nobody` prepared before the peek, or a read
 * carrying no row for this mailbox, therefore moved the run on to the consent statement, where
 * Continue and then Agree authorize the takeover the choice was never kept on screen for.
 * Measured on the 0.14.2 candidate, on the connect path the file's header walks.
 *
 * `asked` is the witness, and it is the EXISTENCE of the floor ref rather than its value: the
 * screen already records "the question was shown with a holder, for this mailbox", and a host
 * that stamps no `organizerEventAt` leaves that ref's `at` null on a run that was very much
 * asked — which is why `heldStamp` cannot answer this question.
 *
 * WATCH THEM FAIL, all three measured: drop `|| (at === null && asked && !claimAnswered)` from
 * `questionUp` and the first two cases here red together with the component case in
 * `first-run-held-mailbox` (which is the released behaviour exactly); drop `!claimAnswered` and
 * the loop control reds alone; pass `false` for the flag at the screen's own call and only the
 * component case reds, every case here staying green — which is why that one is a render.
 *
 * Dropping `asked` from the term is a FOURTH mutation and it is not a discriminating one: it
 * makes `questionUp` true for every unanswered run with no cursor, so six cases red across the
 * two files, three of them pre-existing ones about where the stage OPENS. Recorded because a
 * mutation that reds half the file says nothing about the term it removed.
 */
describe("a question the DERIVATION put up survives a stale or empty read", () => {
  /** The middle instant is the stamp the screen was shown under; the first is older, the third the release itself. */
  const t1 = "2026-09-07T09:00:00.000Z";
  const t2 = "2026-09-07T09:05:00.000Z";
  const t3 = "2026-09-07T09:10:00.000Z";

  /** What a standalone connect creates, and what a lagging `nobody` read looks like. */
  const noHolder = (stamp: string | null) => facts({
    mailbox: {
      organizerRole: "reader" as const,
      organizedBy: null,
      organizerState: null,
      organizeConsentedAt: null,
      initialImportCompletedAt: null,
      organizerEventAt: stamp,
    },
  });

  it("A STALE nobody keeps the question WITH NO PRESS ANYWHERE IN THE RUN", () => {
    /* THE FIX'S OWN ASSERTION. Same facts and same floor as the ordering case above, and the one
       difference is the cursor: there somebody had pressed Continue, here nobody has touched
       anything — which is the state the released build shipped unguarded. */
    expect(firstRunStep(noHolder(t1), null, false, false, false, t2, true),
      "a read issued before the holder appeared took the question off an untouched screen")
      .toBe("elsewhere");
  });

  it("A READ THAT SAYS NOTHING keeps it too — no row is not an answer", () => {
    /* The other shape that reached the seam: the run's mailbox is not in the facts at all (a
       removal from another surface, a stale or failing list). `holderVerdict` answers `unknown`,
       and nothing may be concluded from it — least of all that the mailbox is free. */
    expect(firstRunStep(facts({ mailbox: null }), null, false, false, false, t2, true),
      "a run whose mailbox the facts do not hold released the claim question")
      .toBe("elsewhere");
  });

  it("CONTROL — a FRESH nobody releases it, and this is what stops it being a trap", () => {
    /* The positive control. Without it the rule above would read "the screen never goes away",
       which is the failure mode on the other side of it: a person waiting for the other install
       to release the mailbox has to be let through when it does. */
    expect(firstRunStep(noHolder(t3), null, false, false, false, t2, true),
      "the release the person was waiting for did not move the run on")
      .toBe("consent");
  });

  it("LOOP CONTROL — the person's own ANSWER outranks the witness", () => {
    /* `!claimAnswered` is load-bearing and it is the loop this codebase keeps producing. After
       "Organize here instead" the holder is still recorded — the consent stamp that ends the
       situation is two screens away — and a write on that stretch clears the cursor to null.
       Without the flag the new term would read that null as "the question is up" and hand the
       person straight back to the choice they had just made. */
    expect(firstRunStep(noHolder(t1), null, false, true, false, t2, true),
      "the choice that had just been made was thrown back to the question")
      .toBe("consent");

    /* AND THE SEQUENCE THAT ACTUALLY CLEARS THE CURSOR, which is the one the term is written
       for: "Organize here instead" walks forward to the consent statement and then the window,
       and the window's press is the write. It calls `run()` with no cursor to keep
       (`FirstRun.tsx:1364`), so on success `setAt(null)` runs while the holder is STILL recorded
       — the takeover is the worker's next pass, not this press. Without `!claimAnswered` that
       null reads as "the question is up", the holder is still `somebody`, and the person is
       handed back to a choice they made two screens ago. Row 5 is the honest answer here: the
       consent is stored, so the AI question is what is left. */
    const agreed = facts({
      mailbox: {
        organizerRole: "reader" as const,
        organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
        organizerState: "held" as const,
        organizeConsentedAt: "2026-09-07T09:06:00.000Z",
        initialImportCompletedAt: null,
        organizerEventAt: t1,
      },
    });
    expect(firstRunStep(agreed, null, false, true, false, t2, true),
      "the window press sent the run back to the claim question it had already answered")
      .toBe("ai");
  });

  it("CONTROL — a run never shown the question is not parked on it", () => {
    /* THE ORDINARY FIRST RUN on a free mailbox: no floor, never asked, and the claim question is
       not in its walk at all. */
    expect(firstRunStep(noHolder(t1), null, false, false, false, null, false),
      "a first run on a mailbox nothing holds opened on a screen about another install")
      .toBe("consent");
    /* AND THE FLAG IS WHAT DECIDES IT, isolated: same facts, same floor as the first case, and
       only `asked` false. The pair is not a state the screen can be in — the ref's existence is
       where both values come from — so this is a claim about the PARAMETER, which is what a
       table test of a pure function is for. It is also the only case that reds when the `asked`
       term is dropped from `questionUp` and the rest is left alone. */
    expect(firstRunStep(noHolder(t1), null, false, false, false, t2, false),
      "the question was raised for a run that had never been shown it")
      .toBe("consent");
  });
});
