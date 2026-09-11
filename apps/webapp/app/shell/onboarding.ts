/**
 * Where the first-run flow opens — derived from truth-conditions, never a step counter. There is no
 * `onboarding_step` column and there must never be one: a counter drifts the moment anything happens
 * outside the flow (a mailbox connected from Settings, a Screener decision, another install
 * organizing). The step is recomputed every render: the first unmet condition — which makes the flow
 * resumable, re-runnable pre-filled, and correct when somebody else did half the work. A pure function
 * in its own file so the thirteen-row table is testable with no React, no fetch, no clock. The order
 * is the progress rail's (mailbox → organize → history → AI → pull → decide → done); on resume the AI
 * question outranks the pull's progress bar, which wants nothing from the person.
 */

/**
 * THE SCREENS. Named for what they ask, not numbered — a number in a type is a step counter
 * wearing a different hat, and it would have to be renumbered every time a step is inserted.
 *
 * `welcome` and `pair` are the two that are not conditions: `welcome` is shown once at the top of
 * a run that has nothing behind it, and `pair` is offered after the flow is otherwise finished.
 * Both are in the union because the stage renders them; neither is ever RETURNED by
 * {@link deriveOnboardingStep}, which answers only with steps a truth-condition selects.
 */
export type OnboardingStep =
  | "welcome"
  | "mailbox"
  | "elsewhere"
  | "consent"
  | "window"
  | "ai"
  | "provider"
  | "pull"
  | "decide"
  | "summary"
  | "pair";

/**
 * Which door is asking — it changes which steps exist at all. `local` is the standalone desktop, the
 * only door with an AI provider step, because only there the model is a property of the install
 * (`ai-provider.ts`). `cloud` is the managed service: AI is on/off against ohmail's own key, and setup
 * begins only after the account's own address is verified — enforced by the entry point, not here;
 * this function is never asked about an unverified account. `selfhost` is like cloud, with the
 * provider step read-only from `/hello`.
 */
export type OnboardingDoor = "local" | "cloud" | "selfhost";

/**
 * The AI posture as four states, not a boolean — a boolean cannot separate "nobody has been asked"
 * from "asked, and the answer was no", and those need opposite behaviour: the first stops the flow to
 * ask, the second walks past. `unset` — never answered; the flow asks. `off` — answered no, a complete
 * answer; the flow continues without AI and the provider step does not exist for this run.
 * `on-unconfigured` — answered yes but no usable provider yet (a local install with no model chosen);
 * the provider step is the unmet condition. `on` — answered yes and usable; nothing left to ask.
 */
export type OnboardingAi = "unset" | "off" | "on-unconfigured" | "on";

/**
 * THE MAILBOX FACTS THE DERIVATION READS — the four fields of the polled `GET /mailboxes` row
 * that carry onboarding truth, and nothing else.
 *
 * Every field is OPTIONAL and every absent field reads as the state a server too old to send it
 * would actually be in. That rule is not politeness, it is the deploy-skew contract the rest of
 * this codebase keeps (`MailboxFacts.initialImportCompletedAt` carries the long version): a
 * bundle talking to an API deployed before mail 0083 must degrade to a coherent flow, not to a
 * crash and not to a wrong branch.
 */
export interface OnboardingMailbox {
  /**
   * Absent reads as `organizer` — every install was one before the column existed, so a host
   * that cannot say has not demoted anybody. The dangerous default is the other one: it would
   * put the "somebody else organizes this" screen over a mailbox this install organizes.
   *
   * READ BY THE SCREENS, NOT BY THE DERIVATION. It selects the summary's two shapes — a reader
   * reports what it reads, an organizer reports what it filed — and it deliberately does not
   * select the `elsewhere` step, which turns on {@link organizedBy} instead. See row 3.
   */
  organizerRole?: "organizer" | "reader";
  /**
   * Who holds it, when somebody else does. `null`/absent ⇒ nobody is named.
   *
   * THE PEEK'S ANSWER, and therefore the one fact that is available BEFORE anybody consents:
   * both doors fill these columns from the APPEND-less lease read rather than from a claim, so
   * a mailbox this install has looked at and not touched still says who organizes it. That is
   * why row 3 turns on this and not on {@link organizerRole}.
   */
  organizedBy?: { kind: string | null; name: string | null; since: string | null } | null;
  /** Whether that holder is still renewing. Read by the SCREEN, not by this derivation. */
  organizerState?: "held" | "stopped" | null;
  /**
   * When what this row says about its organizer last changed — the one fact that orders two reads of
   * the same mailbox. Not read by this derivation (a pure function of one read) but by `firstRunStep`,
   * which is not: two reads can settle in either order, so a `nobody` prepared before a holder was
   * recorded can land after the read that showed it, and acting on it puts somebody one press from
   * authorizing a takeover they were never offered. Every writer that changes the organizing story
   * stamps this in the same statement, so an older stamp is an older read. `null` is a mailbox nothing
   * has happened to; absent is a build that predates the column — both mean "no ordering evidence".
   */
  organizerEventAt?: string | null;
  /**
   * WHEN somebody agreed to let ohmail organize this mailbox. Absent and `null` both mean
   * "nobody has", which is what makes the consent step the unmet condition — the safe direction,
   * because the cost of being wrong is a consent screen shown twice, and the cost of the inverse
   * is organizing somebody's mailbox without having asked.
   */
  organizeConsentedAt?: string | null;
  /**
   * WHEN the first import finished. `null` is "still importing"; ABSENT is an API that predates
   * the column and must NOT read as null — the pre-0038 behaviour is "this build cannot tell",
   * and a build that cannot tell must not park somebody on a progress bar for ever. This is the
   * one field where absent and null genuinely differ, and `mail-state.ts` documents the measured
   * failure that established it.
   */
  initialImportCompletedAt?: string | null;
}

/** The account-level facts, from `GET /consent`. */
export interface OnboardingAccount {
  /**
   * WHEN the flow was last LEFT — finished or cancelled. Non-null closes the flow: it is the one
   * fact that is about the flow rather than about the mailbox, and it is what stops a finished
   * account re-opening setup on every boot.
   */
  onboardingCompletedAt?: string | null;
}

/** Everything the derivation is allowed to read. */
export interface OnboardingFacts {
  door: OnboardingDoor;
  /** The mailbox the flow is about — `null` when the account has none yet. */
  mailbox: OnboardingMailbox | null;
  account: OnboardingAccount;
  ai: OnboardingAi;
  /**
   * HOW MANY SENDERS ARE WAITING in the Screener queue. `0` skips the guided decision SILENTLY —
   * a guided "take your first decision" screen with nothing on it is worse than no screen, and
   * on a mailbox whose backlog was all known senders it is the ordinary case.
   */
  queuedSenders: number;
}

/**
 * Where the flow opens, or `null` when it must not open at all — the most common answer: every boot of
 * an account that has been through setup. Each arm is one row and one test, in order:
 *  1. completed → null; 2. no mailbox → "mailbox"; 3. holder named + no consent → "elsewhere" (the
 *  choice, never a dead end); 4. no consent → "consent"; 5. AI unset → "ai" (a question, ahead of the
 *  progress bar); 6. AI on, no provider → "provider" (local door only); 7. import not done → "pull"
 *  (leaving it is allowed); 8. queue non-empty → "decide"; 9. otherwise → "summary".
 * `welcome` and `pair` are never returned — see {@link OnboardingStep}.
 */
export function deriveOnboardingStep(facts: OnboardingFacts): OnboardingStep | null {
  // ROW 1 — THE FLOW HAS BEEN LEFT. First, and before every other arm, because it is the only
  // condition that can be true while conditions further down are ALSO unmet: somebody who
  // cancelled on the consent screen has no consent stamp for ever, and without this arm ahead of
  // row 4 the flow would re-open on that same screen at every boot. Cancel and finish write the
  // same stamp precisely so that one arm covers both (`setOnboardingCompleted`'s docblock).
  if (facts.account.onboardingCompletedAt) return null;

  // ROW 2 — NOTHING TO ORGANIZE. The only state in which the flow has no mailbox to talk about.
  if (facts.mailbox === null) return "mailbox";

  const mb = facts.mailbox;
  const consented = Boolean(mb.organizeConsentedAt);
  // A HOLDER IS NAMED — not merely "the object exists". `organizedBy` is null as a whole when
  // nobody is named (the DTO guarantees that rather than an object of three nulls), and a reader
  // with no holder is an ordinary un-consented mailbox, which is row 4's business and not row
  // 3's. Testing `kind`/`name` rather than the object is what keeps a server that starts sending
  // `{null,null,null}` from routing everybody through the wrong screen.
  const heldByOther = Boolean(mb.organizedBy && (mb.organizedBy.kind || mb.organizedBy.name));

  // Row 3 — somebody else organizes it. Ahead of consent because the consent screen would be a lie
  // here: agreeing would not start organizing anything until the claim is taken. Gated on `!consented`
  // so a mailbox this account has consented to, and another install later took, is not asked again —
  // its banner and "Organize here instead" live in Settings. The holder is the condition and the role
  // is not: the holder columns are written by a peek (`notePreConsentHolder` / `refreshReaderHolder`)
  // while the role is written by the stand-down, so on a pre-consent mailbox the two do not move
  // together — the old `isReader &&` clause skipped this screen, and a fresh standalone connect to a
  // mailbox ohmail Cloud holds walked past it, agreed, and stood down to reader on its next pass.
  // `!consented` carries the old clause's meaning: an unconsented mailbox is not one this install
  // organizes, whatever `organizer_role` says.
  if (heldByOther && !consented) return "elsewhere";

  // ROW 4 — NO CONSENT. The re-arrangement statement and, on its heels, the window: they are two
  // screens and ONE write (`POST /mailboxes/:id/organize` carries consent, baseline, window and
  // scope in one transaction), so the derivation names only the first of them. Reaching "window"
  // is forward navigation inside a run, never a resume target — there is no truth-condition
  // between them to resume ON, which is exactly what "one write" means.
  if (!consented) return "consent";

  // ROW 5 — THE AI QUESTION IS UNANSWERED. Ahead of the pull deliberately; the divergence from
  // the plan's summary sentence, and why, is argued in this file's header.
  if (facts.ai === "unset") return "ai";

  // ROW 6 — YES, BUT NOTHING TO RUN IT WITH. Only the standalone door can be in this state and
  // only it has a provider step: on Cloud the provider is ohmail's own key and on self-host it is
  // the operator's, so neither has anything for a person to configure here. Guarding on the door
  // as well as the posture keeps a Cloud account that somehow reports `on-unconfigured` — a
  // deploy skew, a bug — out of a screen that door does not have, rather than into a dead end.
  if (facts.ai === "on-unconfigured" && facts.door === "local") return "provider";

  // ROW 7 — THE FIRST PULL IS STILL RUNNING. `=== null` and NOT falsy: `undefined` is an API that
  // predates the column and cannot answer, and a build that cannot tell must not park somebody in
  // front of a progress bar with no end. This is `mail-state.ts`'s import-floor rule, and the
  // measured failure behind it is a permanent "Syncing your mail" over a finished mirror.
  if (mb.initialImportCompletedAt === null) return "pull";

  // ROW 8 — SOMEBODY IS WAITING IN THE SCREENER. Skipped SILENTLY at zero: the guided decision
  // needs a sender to decide about, and an empty queue is an ordinary outcome (every sender in
  // the backlog already had a rule). A screen that says "take your first decision" over nothing
  // is a dead end the plan forbids.
  if (facts.queuedSenders > 0) return "decide";

  // ROW 9 — EVERYTHING IS DONE AND NOBODY HAS SEEN THE SUMMARY. `pair` follows it inside the run;
  // it is optional and skippable, so it is never a resume target of its own.
  return "summary";
}

/**
 * THE STEPS THE PERSON WALKS, in rail order — the stage's forward/back path.
 *
 * Separate from {@link deriveOnboardingStep} because they answer different questions: that one
 * says where a run RESUMES, this one says what comes next inside a run. They must not be the same
 * list, because two of these are never resume targets ({@link OnboardingStep}) and two more are
 * conditional on the door.
 */
export function onboardingPath(
  facts: OnboardingFacts,
  /**
   * Is this an "add a mailbox" run — the third intent, off the route (`Route.firstRunAdd`). A
   * standalone install can hold more than one mailbox, and the second is not a first run. Four screens
   * leave the walk, each for its own reason: `welcome` (the person already uses ohmail); `ai` and
   * `provider` (the model is a property of the install, `ai-provider.ts` — asking per mailbox implies
   * a per-mailbox answer nothing stores); `pair` (the phone is paired to the install). The window IS
   * asked again — it is written by the consent transaction this run performs onto the account row
   * (ruling (a): a per-mailbox window is refused). Defaulted false: every caller predating
   * multi-mailbox is a first run or a re-run.
   */
  add = false,
): OnboardingStep[] {
  const out: OnboardingStep[] = add ? ["mailbox"] : ["welcome", "mailbox"];
  const mb = facts.mailbox;
  // The elsewhere screen is in the path only when it is actually the situation. The holder is the
  // condition (row 3's note), and here it is not the holder alone: `!consented || isReader`, because a
  // promoted install keeps its old holder columns. The hosted worker's `clearOrganizerStandDown` nulls
  // all four with the role, but the standalone engine's promote arm writes `organizer_role =
  // 'organizer'` and deliberately leaves the clean-up columns — so on the holder alone this arm would
  // put "somebody else organizes this" into the walk for a mailbox this machine organizes, one Back
  // press from a claim button firing `organize` against itself. The re-entry case the clause serves is
  // unaffected: a mailbox this account consented to and another install has since taken is a `reader`.
  if (mb
      && Boolean(mb.organizedBy && (mb.organizedBy.kind || mb.organizedBy.name))
      && (!mb.organizeConsentedAt || mb.organizerRole === "reader")) {
    out.push("elsewhere");
  }
  out.push("consent", "window");
  // THE AI PAIR IS THE INSTALL'S QUESTION, ASKED ONCE. See the `add` parameter.
  if (!add) {
    out.push("ai");
    // The provider step exists on the standalone door alone (ruling 2(d)); on the other two doors
    // it is a sentence on the AI screen, not a step.
    if (facts.door === "local" && facts.ai !== "off") out.push("provider");
  }
  out.push("pull");
  if (facts.queuedSenders > 0) out.push("decide");
  out.push("summary");
  // Pairing is per INSTALL, not per mailbox — offered at the end of the run that set the install
  // up, and never again for each further mailbox added to it.
  if (!add) out.push("pair");
  return out;
}

/**
 * WHETHER THE STATUS BAR CARRIES THE PULL'S TWO COUNTERS — true exactly while the flow's own
 * progress screen would be showing them and the person is somewhere else.
 *
 * The plan's promise is that leaving the pull screen does not lose the pull: "the person may
 * leave this screen; the pull continues and the status bar carries the counters". This is the
 * predicate behind that sentence, kept here rather than in the strip so that the flow and the
 * strip cannot disagree about when the import is finished.
 */
export function ONBOARDING_STATUS_COUNTERS(facts: OnboardingFacts): boolean {
  const mb = facts.mailbox;
  if (mb === null) return false;
  // Consent first: before it there is no organizing to report on, and the mirror that is building
  // is the reader mirror, which the ordinary sync strip already narrates.
  if (!mb.organizeConsentedAt) return false;
  // `=== null`, on row 7's rule: absent is "cannot tell", and a build that cannot tell must not
  // put a permanent pair of counters on the strip.
  return mb.initialImportCompletedAt === null;
}
