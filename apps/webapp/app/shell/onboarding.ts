/**
 * WHERE THE FIRST-RUN FLOW OPENS — derived from truth-conditions, never from a step counter.
 *
 * ── THE RULING THIS FILE IS ────────────────────────────────────────────────────────────────
 *
 * Onboarding state is DERIVED. There is no
 * `onboarding_step` column and there must never be one, because a counter and the facts it
 * claims to summarise drift the moment anything happens outside the flow — a mailbox connected
 * from Settings, a Screener decision taken in the app, an install that organizes the mailbox
 * from another machine. Every one of those moves the person forward, and a counter would not
 * know. So the step is recomputed from what the product actually stored, every render:
 *
 *   current step = the FIRST unmet condition.
 *
 * That single rule is what makes the flow resumable across restarts, re-runnable from Settings
 * pre-filled, and correct on a door where somebody else did half the work.
 *
 * ── WHY THIS IS A PURE FUNCTION IN ITS OWN FILE ────────────────────────────────────────────
 *
 * The inputs come from four places (a polled `GET /mailboxes` row, `GET /consent`, the door's AI
 * posture, the Screener queue) and three doors compose them differently — Cloud reads a REST DTO,
 * the standalone desktop reads the sidecar, the self-host reads both plus `/hello`. Keeping the
 * DECISION separate from all three is what makes the state→condition table testable as a table:
 * every row below is one test with no React, no fetch and no clock. The alternative — the
 * decision spread across the component's render — is the shape in which a table like this stops
 * being checkable, and this one has thirteen rows.
 *
 * ── THE ORDER, AND ONE DIVERGENCE THAT IS DELIBERATE ───────────────────────────────────────
 *
 * The order below is the one the flow's own progress rail shows and the one its screens are
 * numbered in: mailbox → organize → history → AI → pull → decide → done. An alternative ordering
 * was considered that puts the import ahead of the AI question. The two disagree only on RESUME,
 * and only in one state: quit during the first pull with AI still unanswered.
 *
 * The rail wins there, and the reason is what the two screens are. The AI step is an unanswered
 * QUESTION and takes a second; the pull step is a progress bar that needs no input and continues
 * whether or not anybody is looking at it (the status bar carries its counters — {@link
 * ONBOARDING_STATUS_COUNTERS}). Resuming onto the progress bar would park the person in front of
 * a screen that wants nothing from them while an actual question waits behind it.
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
 * WHICH DOOR IS ASKING. Not cosmetic: it changes which steps exist at all.
 *
 *  · `local`    — the standalone desktop. The only door with an AI PROVIDER step, because it is
 *                 the only one where the model is a property of the install (`ai-provider.ts`).
 *  · `cloud`    — the managed service. AI is on/off against ohmail's own key; the provider step
 *                 is informational. On this door setup begins only after the account's own email
 *                 address has been verified — a mailbox may not be connected before that — and
 *                 that rule is enforced by the ENTRY POINT, not here: this function is never asked
 *                 about an account that has not verified.
 *  · `selfhost` — like cloud, with the provider step read-only from `/hello`.
 */
export type OnboardingDoor = "local" | "cloud" | "selfhost";

/**
 * THE AI POSTURE, as the four states that select different screens — not a boolean.
 *
 * A boolean cannot express the difference between "nobody has been asked" and "asked, and the
 * answer was no", and those two need opposite behaviour: the first stops the flow to ask, the
 * second walks past. That distinction is the reason this is a union, and collapsing it is how
 * the AI step would either nag somebody who already declined or silently skip somebody who was
 * never asked.
 *
 *  · `unset`          — never answered. The flow asks.
 *  · `off`            — answered no. A COMPLETE answer; the flow continues without AI, and the
 *                       provider step does not exist for this run.
 *  · `on-unconfigured` — answered yes, but no usable provider yet (a local install with no model
 *                       chosen). The provider step is the unmet condition.
 *  · `on`             — answered yes and usable. Nothing left to ask.
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
 * WHERE THE FLOW OPENS, or `null` when it must not open at all.
 *
 * `null` is a real answer and the most common one: every boot of every account that has been
 * through setup returns it. The caller renders nothing.
 *
 * ── THE TABLE, IN ORDER. Each arm is one row, and one test. ────────────────────────────────
 *
 *  1. completed          → null       the flow has been left; never re-opens by itself
 *  2. no mailbox         → "mailbox"  nothing to organize; the door's first real question
 *  3. a holder is named → "elsewhere" somebody else organizes it — the choice, never a dead end
 *     + no consent
 *  4. no consent         → "consent"  the re-arrangement statement, then the window
 *  5. AI unset           → "ai"       an unanswered question, ahead of the progress bar
 *  6. AI on, no provider → "provider" local door only; elsewhere "on" needs no configuring
 *  7. import not done    → "pull"     the progress bar; leaving it is allowed and expected
 *  8. queue non-empty    → "decide"   the guided first decision
 *  9. otherwise          → "summary"  what ohmail did
 *
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

  // ROW 3 — SOMEBODY ELSE ORGANIZES IT. Ahead of consent because the consent screen would be a
  // lie here: agreeing would not start organizing anything until the claim is taken, and the
  // claim is what this screen is for. Gated on `!consented` so a mailbox this account HAS
  // consented to, and that another install later took, is not asked for consent a second time —
  // its banner and its "Organize here instead" button live in Settings, not in first-run setup.
  //
  // ── THE HOLDER IS THE CONDITION. THE ROLE IS NOT, AND ASKING FOR BOTH SKIPPED THIS SCREEN ──
  //
  // This arm read `isReader && heldByOther && !consented`, and the extra clause bought nothing
  // while it could take the screen away. The four holder columns are written by a PEEK — the
  // APPEND-less lease read (`notePreConsentHolder` on the standalone door,
  // `refreshReaderHolder` on the hosted one) — and the ROLE is written by a different event
  // entirely: the stand-down. So on a pre-consent mailbox the two do not move together, and a
  // build that has looked and seen a live foreign claim must act on what it saw rather than
  // wait for a demotion that only happens after somebody has already agreed.
  //
  // `!consented` carries the whole of the old clause's meaning anyway: a mailbox nobody has
  // agreed to is by construction not one this install organizes, whatever `organizer_role`
  // says. The dangerous direction here is the one that was measured — a fresh standalone
  // connect to a mailbox ohmail Cloud holds walked past this screen, agreed, and stood down to
  // reader on its next pass, having been shown a consent statement instead of the choice.
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
   * IS THIS AN "ADD A MAILBOX" RUN — the third intent, off the route (`Route.firstRunAdd`).
   *
   * A standalone install can hold more than one mailbox, and the second one is not a first run.
   * Four screens come out of the walk and each for its own reason, not as a shortening:
   *
   *  · `welcome` — "one sentence about what ohmail does" to somebody who has been using it;
   *  · `ai` and `provider` — the model is a property of the INSTALL (`ai-provider.ts`), answered
   *    once when it was set up. Asking again per mailbox would imply a per-mailbox answer that
   *    nothing stores, and answering "no" here would look like it turned AI off for the install;
   *  · `pair` — the phone is paired to the install, not to a mailbox, for the same reason.
   *
   * What is left is 1, 2, 3, 4, 7, 8, 9: connect it, say who organizes it if somebody does,
   * agree, choose the window, watch the pull, take a decision, read the summary. The window IS
   * asked again because it is written by the consent transaction this run performs — it is
   * pre-filled from `GET /consent` and it writes the ACCOUNT row, which is where the standalone
   * door's window lives (ruling (a): "a per-mailbox window is REFUSED").
   *
   * DEFAULTED FALSE, and that default is the pre-existing behaviour rather than a choice about a
   * new one: every caller that predates multi-mailbox is a first run or a re-run.
   */
  add = false,
): OnboardingStep[] {
  const out: OnboardingStep[] = add ? ["mailbox"] : ["welcome", "mailbox"];
  const mb = facts.mailbox;
  // The elsewhere screen is in the PATH only when it is actually the situation. Walking somebody
  // through "somebody else organizes this" when nobody does would be a screen with no content.
  //
  // THE HOLDER IS THE CONDITION, and the ROLE is not — row 3's note carries the argument, and it
  // applies here for the sharper reason: the path decides where `forward()` goes, so a path that
  // omitted the screen the derivation resumes on would make Continue walk away from the screen
  // the facts had just selected.
  //
  // ── AND IT IS NOT THE HOLDER ALONE, BECAUSE A PROMOTED INSTALL KEEPS ITS OLD HOLDER ──────
  //
  // `!consented || isReader`, and the second clause is what row 3 does not need. Row 3 is gated
  // on `!consented`, so a consented mailbox can never route it wrong; the PATH is walked, and
  // the two doors clean up differently after a takeover. The hosted worker's
  // `clearOrganizerStandDown` nulls all four holder columns with the role; the standalone
  // engine's promote arm writes `organizer_role = 'organizer'` and says in so many words that
  // "the two clean-up columns are deliberately NOT touched". So a standalone install that HAS
  // taken a mailbox over is `organizer` with `organized_by_*` still naming the install it took
  // it from — and on the holder alone this arm would put "somebody else organizes this" into
  // the walk for a mailbox this machine organizes, one Back press from the re-run's consent
  // statement, with a claim button that would fire `organize` against itself.
  //
  // The re-entry case the clause exists for is unaffected: a mailbox this account consented to
  // and another install has since TAKEN is a `reader`, which is the arm that screen serves.
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
