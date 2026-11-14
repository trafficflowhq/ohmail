/**
 * THE STATE→CONDITION TABLE, ONE TEST PER ROW.
 *
 * `deriveOnboardingStep` is the whole of the ruling "onboarding state is DERIVED from
 * truth-conditions, never a step counter" (`ONBOARDING-RULINGS.md` Boundary 2(a)). The point of
 * keeping it pure is that the table can be checked AS a table: every arm below names the row it
 * pins, and the file fails if an arm is deleted rather than passing quietly with one fewer state
 * handled.
 *
 * The ORDER of the arms is load-bearing and has its own tests at the bottom — several rows are
 * simultaneously true in ordinary states (a cancelled flow has no consent stamp for ever), and a
 * table whose rows are individually right in the wrong order is wrong.
 */
import { describe, expect, it } from "vitest";
import {
  deriveOnboardingStep,
  onboardingPath,
  ONBOARDING_STATUS_COUNTERS,
  type OnboardingFacts,
  type OnboardingMailbox,
} from "@ohmail/app-logic/doors/onboarding";

/** A mailbox that has cleared every condition — the base each row perturbs by ONE field. */
const DONE_MAILBOX: OnboardingMailbox = {
  organizerRole: "organizer",
  organizedBy: null,
  organizerState: null,
  organizeConsentedAt: "2026-09-01T10:00:00.000Z",
  initialImportCompletedAt: "2026-09-01T10:30:00.000Z",
};

/** An account mid-flow: nothing stamped, one fully-set-up mailbox, AI answered, queue empty. */
function facts(over: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return {
    door: "local",
    mailbox: DONE_MAILBOX,
    account: { onboardingCompletedAt: null },
    ai: "off",
    queuedSenders: 0,
    ...over,
  };
}

describe("the state→condition table", () => {
  it("row 1 — a flow that has been LEFT never re-opens by itself", () => {
    expect(deriveOnboardingStep(facts({
      account: { onboardingCompletedAt: "2026-09-01T11:00:00.000Z" },
    }))).toBeNull();
  });

  it("row 1 — and a CANCEL closes it just as a finish does, with consent still unwritten", () => {
    // The reason row 1 sits ahead of row 4. Somebody who cancelled on the consent screen has no
    // consent stamp and never will; without this ordering the flow would re-open on that exact
    // screen at every boot, which is the behaviour the stamp exists to prevent.
    expect(deriveOnboardingStep(facts({
      mailbox: { ...DONE_MAILBOX, organizeConsentedAt: null, initialImportCompletedAt: null },
      account: { onboardingCompletedAt: "2026-09-01T11:00:00.000Z" },
      ai: "unset",
    }))).toBeNull();
  });

  it("row 2 — no mailbox is the door's first real question", () => {
    expect(deriveOnboardingStep(facts({ mailbox: null, ai: "unset" }))).toBe("mailbox");
  });

  it("row 3 — a reader whose mailbox somebody else holds gets the CHOICE, not consent", () => {
    expect(deriveOnboardingStep(facts({
      mailbox: {
        organizerRole: "reader",
        organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
        organizerState: "held",
        organizeConsentedAt: null,
        initialImportCompletedAt: null,
      },
    }))).toBe("elsewhere");
  });

  it("row 3 — a STOPPED holder is still the elsewhere screen; the screen tells them apart", () => {
    // `organizerState` selects the copy ("organizes this" vs "stopped organizing this"), never
    // the step. Collapsing that into the derivation would make one of the two states unreachable.
    expect(deriveOnboardingStep(facts({
      mailbox: {
        organizerRole: "reader",
        organizedBy: { kind: "local", name: "mila-thinkpad", since: "2026-08-24T09:00:00.000Z" },
        organizerState: "stopped",
        organizeConsentedAt: null,
        initialImportCompletedAt: null,
      },
    }))).toBe("elsewhere");
  });

  it("row 3 — a holder is named and the role has not caught up: still the CHOICE", () => {
    /* THE ROW READS THE HOLDER, NOT THE ROLE, and this is the case that says so.
     *
     * The four holder columns are written by a PEEK — the APPEND-less lease read an install makes
     * BEFORE it has been asked to organize anything — and `organizer_role` is written by the
     * STAND-DOWN, which is a different event and happens only after somebody has already agreed.
     * The two do not move together, so a derivation that required both would wait for a demotion
     * to tell it about a claim the peek had already seen.
     *
     * It is DEFENSIVE rather than a fix for a measured failure, and that is worth saying plainly:
     * on the standalone door the row is created `organizer_role = 'reader'` at connect, so the
     * clause was satisfied there throughout. What it buys is that the screen cannot be withheld
     * by a column that says nothing about who holds the mailbox — and `!consented` already
     * carries the whole of what the clause meant, since a mailbox nobody has agreed to is by
     * construction not one this install organizes.
     *
     * MUTATION: restore `isReader &&` in front of row 3 and this goes red with "consent" — a
     * statement offering to re-arrange a mailbox while naming nobody who already organizes it. */
    expect(deriveOnboardingStep(facts({
      mailbox: {
        organizerRole: "organizer",
        organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
        organizerState: "held",
        organizeConsentedAt: null,
        initialImportCompletedAt: null,
      },
    }))).toBe("elsewhere");
  });

  it("row 3 — and with the role ABSENT entirely, on the same rule", () => {
    // A host that predates the column. Absent reads as `organizer` for every other purpose; here
    // the holder is the fact, and it is present.
    expect(deriveOnboardingStep(facts({
      mailbox: {
        organizedBy: { kind: "local", name: "studio-imac", since: null },
        organizeConsentedAt: null,
        initialImportCompletedAt: null,
      },
    }))).toBe("elsewhere");
  });

  it("row 3 — a reader with NO holder named is an ordinary un-consented mailbox, not a claim", () => {
    // The distinction the DTO guarantees by sending `organizedBy: null` as a whole. A reader with
    // nobody named is what `POST /mailboxes` creates — connected, nothing has moved — and it
    // belongs on the consent screen. Routing it to `elsewhere` would show a claim screen naming
    // nobody.
    expect(deriveOnboardingStep(facts({
      mailbox: {
        organizerRole: "reader",
        organizedBy: null,
        organizeConsentedAt: null,
        initialImportCompletedAt: null,
      },
    }))).toBe("consent");
  });

  it("row 3 — an object of three nulls counts as NOBODY named, not as a holder", () => {
    expect(deriveOnboardingStep(facts({
      mailbox: {
        organizerRole: "reader",
        organizedBy: { kind: null, name: null, since: null },
        organizeConsentedAt: null,
        initialImportCompletedAt: null,
      },
    }))).toBe("consent");
  });

  it("row 3 — a mailbox ALREADY consented to, later taken by another install, is not re-asked", () => {
    // Consent is a permission already granted; re-asking for it is how a flow teaches people to
    // click through consent screens. The banner and the claim button live in Settings.
    expect(deriveOnboardingStep(facts({
      mailbox: {
        organizerRole: "reader",
        organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
        organizerState: "held",
        organizeConsentedAt: "2026-08-01T09:00:00.000Z",
        initialImportCompletedAt: "2026-08-01T10:00:00.000Z",
      },
      ai: "off",
    }))).toBe("summary");
  });

  it("row 4 — no consent stamp is the consent screen", () => {
    expect(deriveOnboardingStep(facts({
      mailbox: { ...DONE_MAILBOX, organizeConsentedAt: null, initialImportCompletedAt: null },
    }))).toBe("consent");
  });

  it("row 4 — an ABSENT consent field reads as un-consented, the safe direction", () => {
    const mb: OnboardingMailbox = { organizerRole: "organizer", initialImportCompletedAt: null };
    expect(deriveOnboardingStep(facts({ mailbox: mb }))).toBe("consent");
  });

  it("row 4 — `window` is never a RESUME target: consent and the window are one write", () => {
    // There is no truth-condition between the two screens to resume on, which is exactly what
    // "one write" means. Nothing the function can be handed returns "window".
    const reachable = new Set<string | null>();
    for (const consented of [null, "2026-09-01T10:00:00.000Z"]) {
      for (const imported of [null, "2026-09-01T10:30:00.000Z"]) {
        for (const ai of ["unset", "off", "on-unconfigured", "on"] as const) {
          for (const queued of [0, 3]) {
            for (const door of ["local", "cloud", "selfhost"] as const) {
              reachable.add(deriveOnboardingStep(facts({
                door,
                ai,
                queuedSenders: queued,
                mailbox: {
                  ...DONE_MAILBOX,
                  organizeConsentedAt: consented,
                  initialImportCompletedAt: imported,
                },
              })));
            }
          }
        }
      }
    }
    expect(reachable.has("window")).toBe(false);
    expect(reachable.has("welcome")).toBe(false);
    expect(reachable.has("pair")).toBe(false);
  });

  it("row 5 — an unanswered AI question comes BEFORE the progress bar", () => {
    // The deliberate divergence from the plan's summary sentence, argued in `onboarding.ts`'s
    // header: the pull needs no input and continues unattended; the AI step is a real question.
    expect(deriveOnboardingStep(facts({
      mailbox: { ...DONE_MAILBOX, initialImportCompletedAt: null },
      ai: "unset",
    }))).toBe("ai");
  });

  it("row 5 — `off` is a COMPLETE answer; the flow walks past it", () => {
    expect(deriveOnboardingStep(facts({
      mailbox: { ...DONE_MAILBOX, initialImportCompletedAt: null },
      ai: "off",
    }))).toBe("pull");
  });

  it("row 6 — yes-but-nothing-to-run-it-with is the provider step, on the standalone door", () => {
    expect(deriveOnboardingStep(facts({
      door: "local",
      ai: "on-unconfigured",
      mailbox: { ...DONE_MAILBOX, initialImportCompletedAt: null },
    }))).toBe("provider");
  });

  it("row 6 — and NOT on cloud or self-host, which have no provider to configure", () => {
    for (const door of ["cloud", "selfhost"] as const) {
      expect(deriveOnboardingStep(facts({
        door,
        ai: "on-unconfigured",
        mailbox: { ...DONE_MAILBOX, initialImportCompletedAt: null },
      }))).toBe("pull");
    }
  });

  it("row 7 — a null import stamp is the first pull", () => {
    expect(deriveOnboardingStep(facts({
      mailbox: { ...DONE_MAILBOX, initialImportCompletedAt: null },
    }))).toBe("pull");
  });

  it("row 7 — an ABSENT import stamp is 'cannot tell', NOT 'still importing'", () => {
    // `mail-state.ts`'s import-floor rule. An API that predates the column has no null to offer,
    // and reading absent as null parks somebody on a progress bar that never ends — the measured
    // failure was a permanent "Syncing your mail" over a finished mirror.
    const mb: OnboardingMailbox = {
      organizerRole: "organizer",
      organizeConsentedAt: "2026-09-01T10:00:00.000Z",
    };
    expect(deriveOnboardingStep(facts({ mailbox: mb }))).toBe("summary");
  });

  it("row 8 — a non-empty Screener queue is the guided first decision", () => {
    expect(deriveOnboardingStep(facts({ queuedSenders: 1 }))).toBe("decide");
  });

  it("row 8 — an EMPTY queue skips the guided decision silently", () => {
    expect(deriveOnboardingStep(facts({ queuedSenders: 0 }))).toBe("summary");
  });

  it("row 9 — everything met and nothing stamped is the summary", () => {
    expect(deriveOnboardingStep(facts())).toBe("summary");
  });
});

describe("the order of the arms", () => {
  it("row 1 beats every other row: a stamped flow stays shut in the emptiest possible state", () => {
    expect(deriveOnboardingStep({
      door: "local",
      mailbox: null,
      account: { onboardingCompletedAt: "2026-09-01T11:00:00.000Z" },
      ai: "unset",
      queuedSenders: 40,
    })).toBeNull();
  });

  it("row 3 beats row 4: a held mailbox is claimed before it is consented to", () => {
    // Agreeing on the consent screen would organize nothing while another install holds the
    // lease, so a consent screen here would be a promise the product cannot keep this tick.
    expect(deriveOnboardingStep(facts({
      mailbox: {
        organizerRole: "reader",
        organizedBy: { kind: "local", name: "studio-imac", since: "2026-08-30T09:00:00.000Z" },
        organizeConsentedAt: null,
        initialImportCompletedAt: null,
      },
      ai: "unset",
    }))).toBe("elsewhere");
  });

  it("row 4 beats row 5: nothing is asked about AI before the mailbox is consented to", () => {
    expect(deriveOnboardingStep(facts({
      mailbox: { ...DONE_MAILBOX, organizeConsentedAt: null, initialImportCompletedAt: null },
      ai: "unset",
    }))).toBe("consent");
  });

  it("row 5 beats row 7: the question is asked before the progress bar is shown", () => {
    expect(deriveOnboardingStep(facts({
      mailbox: { ...DONE_MAILBOX, initialImportCompletedAt: null },
      ai: "unset",
      queuedSenders: 9,
    }))).toBe("ai");
  });

  it("row 7 beats row 8: the queue is not offered while the import is still filling it", () => {
    expect(deriveOnboardingStep(facts({
      mailbox: { ...DONE_MAILBOX, initialImportCompletedAt: null },
      queuedSenders: 9,
    }))).toBe("pull");
  });
});

describe("'Just read it here' — the reader ending", () => {
  it("skips steps 3–9 entirely: the stamp is what ends the flow, not a column of its own", () => {
    // The choice leaves the mailbox a consent-less reader FOR EVER, which is row 4's condition
    // permanently unmet. What closes the flow is the same stamp cancel and finish write — so no
    // "chose to read" column exists, and none is needed.
    const afterChoosingToRead = facts({
      mailbox: {
        organizerRole: "reader",
        organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
        organizerState: "held",
        organizeConsentedAt: null,
        initialImportCompletedAt: null,
      },
      account: { onboardingCompletedAt: "2026-09-02T08:00:00.000Z" },
      ai: "unset",
      queuedSenders: 12,
    });
    expect(deriveOnboardingStep(afterChoosingToRead)).toBeNull();
  });

  it("and without the stamp the same facts return to the choice — the stamp is load-bearing", () => {
    // The mutation this pins: drop the stamp write from the reader ending and the person is
    // handed the same screen on every boot.
    expect(deriveOnboardingStep(facts({
      mailbox: {
        organizerRole: "reader",
        organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-08-30T09:00:00.000Z" },
        organizerState: "held",
        organizeConsentedAt: null,
        initialImportCompletedAt: null,
      },
      account: { onboardingCompletedAt: null },
      ai: "unset",
    }))).toBe("elsewhere");
  });
});

describe("re-run from Settings — pre-filled from truth", () => {
  it("a finished account's facts still derive the LAST step, so a re-run opens pre-filled", () => {
    // "Run setup again" opens the stage explicitly; it does not clear the stamp. What makes the
    // re-run pre-filled is that every screen reads the same facts the derivation does — so this
    // asserts the facts are still legible, not that the flow re-opens by itself (row 1 covers
    // that it must not).
    const finished = facts({ account: { onboardingCompletedAt: "2026-09-02T08:00:00.000Z" } });
    expect(deriveOnboardingStep(finished)).toBeNull();
    expect(deriveOnboardingStep({ ...finished, account: { onboardingCompletedAt: null } }))
      .toBe("summary");
  });
});

describe("the walked path", () => {
  it("omits the elsewhere screen when nobody else holds the mailbox", () => {
    expect(onboardingPath(facts())).not.toContain("elsewhere");
  });

  it("OMITS IT for an install that TOOK the mailbox over and kept the old holder columns", () => {
    /* THE TWO DOORS CLEAN UP DIFFERENTLY AFTER A TAKEOVER, and the path arm has to survive both.
     * The hosted worker's `clearOrganizerStandDown` nulls all four holder columns beside the
     * role; the standalone engine's promote arm writes `organizer_role = 'organizer'` and states
     * that "the two clean-up columns are deliberately NOT touched". So a standalone install that
     * HAS taken a mailbox over is an organizer whose row still names the install it took it from.
     *
     * On the holder alone, this arm put "somebody else organizes this" into the walk for a
     * mailbox this machine organizes — one Back press from the re-run's consent statement, on a
     * screen whose claim button would then fire `organize` against itself.
     *
     * MUTATION: drop `|| mb.organizerRole === "reader"`'s guard (test the holder alone) and this
     * goes red with `elsewhere` in the path. */
    expect(onboardingPath(facts({
      mailbox: {
        ...DONE_MAILBOX,
        organizerRole: "organizer",
        organizedBy: { kind: "local", name: "the-machine-it-took-it-from", since: null },
      },
    }))).not.toContain("elsewhere");
  });

  it("…but KEEPS it for the re-entry path — consented, and another install has since taken it", () => {
    // The case the consent gate was dropped for: there is nothing left to ask, so the screen's
    // own re-entry arm claims at once. Reachable only through the path.
    expect(onboardingPath(facts({
      mailbox: {
        ...DONE_MAILBOX,
        organizerRole: "reader",
        organizedBy: { kind: "cloud", name: "ohmail Cloud", since: null },
      },
    }))).toContain("elsewhere");
  });

  it("includes it when somebody does", () => {
    expect(onboardingPath(facts({
      mailbox: {
        ...DONE_MAILBOX,
        organizerRole: "reader",
        organizedBy: { kind: "cloud", name: "ohmail Cloud", since: null },
      },
    }))).toContain("elsewhere");
  });

  it("has a provider step on the standalone door only", () => {
    expect(onboardingPath(facts({ door: "local", ai: "on-unconfigured" }))).toContain("provider");
    expect(onboardingPath(facts({ door: "cloud", ai: "on-unconfigured" }))).not.toContain("provider");
    expect(onboardingPath(facts({ door: "selfhost", ai: "on" }))).not.toContain("provider");
  });

  it("drops the provider step when AI was declined, on every door", () => {
    expect(onboardingPath(facts({ door: "local", ai: "off" }))).not.toContain("provider");
  });

  it("drops the guided decision when the queue is empty", () => {
    expect(onboardingPath(facts({ queuedSenders: 0 }))).not.toContain("decide");
    expect(onboardingPath(facts({ queuedSenders: 2 }))).toContain("decide");
  });

  it("always begins at welcome and ends at pair", () => {
    const p = onboardingPath(facts());
    expect(p[0]).toBe("welcome");
    expect(p[p.length - 1]).toBe("pair");
  });
});

describe("the status bar carries the pull's counters while the flow is left", () => {
  it("true exactly between consent and import-complete", () => {
    expect(ONBOARDING_STATUS_COUNTERS(facts({
      mailbox: { ...DONE_MAILBOX, initialImportCompletedAt: null },
    }))).toBe(true);
  });

  it("false before consent — the reader mirror is the ordinary sync strip's business", () => {
    expect(ONBOARDING_STATUS_COUNTERS(facts({
      mailbox: { ...DONE_MAILBOX, organizeConsentedAt: null, initialImportCompletedAt: null },
    }))).toBe(false);
  });

  it("false once the import completes", () => {
    expect(ONBOARDING_STATUS_COUNTERS(facts())).toBe(false);
  });

  it("false with no mailbox, and false when the build cannot tell", () => {
    expect(ONBOARDING_STATUS_COUNTERS(facts({ mailbox: null }))).toBe(false);
    expect(ONBOARDING_STATUS_COUNTERS(facts({
      mailbox: { organizerRole: "organizer", organizeConsentedAt: "2026-09-01T10:00:00.000Z" },
    }))).toBe(false);
  });
});
