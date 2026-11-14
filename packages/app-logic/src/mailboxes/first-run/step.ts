/**
 * WHICH SCREEN IS ON, or `null` when the flow must not be open at all. Moved out of the web shell's stage as it
 * stood; a table test drives it directly, because the cursor/derivation interaction is the part with rows.
 */
import { deriveOnboardingStep, importOverOf, onboardingPath } from "../../doors/onboarding.js";
import type { OnboardingFacts, OnboardingStep } from "../../doors/onboarding.js";
import { holderVerdict } from "../../reading/reader-holder.js";
import { nextStep, readIsNotOlder } from "./rules.js";

/**
 * - `heldStamp`: `organizerEventAt` AS IT STOOD ON THE READ THAT PUT A HOLDER ON THE CLAIM QUESTION, or null when no
 *   holder has been shown in this run. See `readIsNotOlder` — it is the only thing that can tell a current "nobody
 *   organizes this" from one that a slower read is still carrying about a moment that has passed.
 * - `asked`: has the claim question been on screen with a holder on it in this run, for this mailbox. The cursor is
 *   not the only way somebody arrives there: the DERIVATION puts them there straight after a connect, before any
 *   press, where `at` is still null — so a release rule written against the cursor alone did not run, and a stale or
 *   empty read carried the run on with the question never answered. The witness is the ref the floor comes from —
 *   written only while the question is rendered with a holder, keyed by mailbox. `heldStamp` cannot serve: it is
 *   null on a host that sends no `organizerEventAt`, which is a run that WAS asked.
 * - `vanished`: THE RUN NAMES A MAILBOX THIS INSTALL DOES NOT HOLD — `firstRunSubject`'s `vanished`. Answered before
 *   everything else, cursor included, because every other answer this function can give for a null mailbox is a
 *   screen that acts on one.
 * - `choose`: THE RUN NAMES NO MAILBOX AND THERE ARE SEVERAL — `firstRunSubject`'s `choose`, answered as `vanished` is.
 */
export function firstRunStep(
  facts: OnboardingFacts,
  at: OnboardingStep | null,
  rerun = false,
  claimAnswered = false,
  add = false,
  heldStamp: string | null = null,
  asked = false,
  vanished = false,
  choose = false,
): OnboardingStep | null {
  /* ── FIRST, AND BEFORE THE CURSOR ──────────────────────────────────────────────────────────
   * A run about a mailbox that is not there has nothing to re-run, and the fall-through was not a
   * dead end but a LIVE one: the re-run arm below answers `mailbox` for a null mailbox, the mailbox
   * step is a FORM, and its connect mode is `seed` because only `add === true` selects `add` — so a
   * re-run whose row had left the facts offered a connect form that reconfigures the whole install.
   * Ahead of the cursor too: a cursor carried in from an earlier screen would walk straight back
   * onto that form. `add` is not this arm's business — its hash carries an id the facts have not
   * caught up with yet, and its form writes a row beside the others rather than replacing them.
   */
  if (vanished) return "vanished";
  if (choose) return "choose";
  const derived = deriveOnboardingStep(facts);
  /* Is there a claim question outstanding — read from the FACTS, not from `derived`, which cannot answer on the path
   * that needs it most: row 1 returns `null` for any account carrying a completion stamp, so on `#/first-run/again`
   * the guard below would be structurally inert — and the walk is short: connect a mailbox somebody else holds,
   * CANCEL on the consent screen (cancel stamps completion), press "Run setup again" — the re-run opens on the
   * consent statement and Agree writes a consent the lease is about to decline. `flowIsOpen` keeps row 1's
   * authority on a BOOT: the reader ending does not re-open this screen at every launch. */
  const mb = facts.mailbox;
  const claimPending =
    mb !== null &&
    Boolean(mb.organizedBy && (mb.organizedBy.kind || mb.organizedBy.name)) &&
    !mb.organizeConsentedAt;
  const flowIsOpen = rerun || add || derived !== null;
  /* The claim question is not skippable, and the cursor used to skip it silently (measured on 0.13.6): the flow
   * opened on consent before the peek landed, Continue made `at` non-null, the peek then named a holder — and the
   * cursor won, so the one screen built for this never rendered; the person agreed, stood down to reader, and the
   * summary reported the organizing it had been refused. The cursor is a navigation aid, not evidence: it may carry
   * a run through screens, never PAST an unanswered question. `claimAnswered` makes this a guard rather than a loop
   * — "Organize here instead" moves the cursor to `consent` while the derivation still answers "elsewhere". Back
   * still works (three exempt). */
  if (
    flowIsOpen &&
    claimPending &&
    !claimAnswered &&
    at !== "welcome" &&
    at !== "mailbox" &&
    at !== "elsewhere"
  ) {
    return "elsewhere";
  }
  /* And the cursor may not keep that screen up after its subject is gone. `elsewhere` is written for one situation
   * and the cursor can hold it up after the holder went away. The release is judged by `holderVerdict` — did a read
   * ANSWER — not `readerHolder`, whose "no field = nobody" collapse released the cursor with the mailbox absent from
   * the facts, resuming on consent where Agree authorizes an unshown takeover. A holder with neither kind nor name is
   * still `somebody`; a stale `nobody` is ordered out by `organizerEventAt` against the screen-held floor
   * (`readIsNotOlder`, `heldStamp`). Up two ways (cursor, or derivation + `asked`); down one: a fresh explicit
   * `nobody`. */
  const questionUp = at === "elsewhere" || (at === null && asked && !claimAnswered);
  const kept = questionUp
    ? holderVerdict(mb) === "nobody" && readIsNotOlder(mb?.organizerEventAt, heldStamp)
      ? null
      : "elsewhere"
    : at;
  /* NOR MAY IT HOLD THE PULL PAST THE IMPORT. The pull screen asks nothing, so nothing on it writes and a cursor left
   * there (the AI answer keeps one) is never cleared: the stamp the server writes when the import drains went unread
   * and the screen said "reading the mailbox" for ever. Once the import is over the run goes on to what the walk
   * holds after the pull — row 7's rule, `=== null` is running and absent is a build that cannot tell. */
  const cursor =
    kept === "pull" && mb !== null && importOverOf(mb)
      ? (nextStep(onboardingPath(facts, add), "pull") ?? null)
      : kept;
  /* A re-run is an intent, and it outranks the completion stamp. `rerun` comes from the route (`#/first-run/again`)
   * — the only place it can: a finished account derives to "nothing to do", correctly, which is exactly what
   * somebody pressing "Run setup again" does not want. The alternative — clearing the stamp — deliberately has no
   * instruction: nothing un-finishes onboarding. It opens on the consent statement (the three things a person comes
   * back to change: what ohmail files, how far back, AI), pre-filled from what the account stored. The one exception
   * is an account with no mailbox, where the flow is a first run. */
  if (rerun) {
    if (cursor !== null) return cursor;
    return facts.mailbox === null ? "mailbox" : "consent";
  }
  /* An add is an intent too, and it opens on the connect form. Same argument as the re-run, one difference: a re-run
   * is about a mailbox that exists, an add about one that does not — and it keeps opening on the form until the
   * create has answered, which is what `facts.mailbox === null` means on this run (the shell withholds the mailbox
   * while the route names none). After the create the cursor carries the run forward (`onConnected` re-points the
   * route); the derivation is consulted for the resume, so quitting mid-add and coming back lands on the first thing
   * the new mailbox still needs. */
  if (add) {
    if (cursor !== null) return cursor;
    /* The two facts this run is not about are withheld: `account.onboardingCompletedAt` is about the INSTALL (it is
     * set — that is why "Add mailbox" is visible — so row 1 would answer `null` for every add run); `ai` is about
     * the install too, reported as `on` so the derivation flows to rows 7-9. What is left is the mailbox's own
     * truth-conditions. This does NOT describe a resume: coming back means pressing "Add mailbox" with no
     * `?mailbox=` — the connect form again; the half-added mailbox is recovered from its own row ("Run setup" → the
     * re-run). This arm is for the run in FLIGHT, once `onConnected` has put the id in the hash. */
    return deriveOnboardingStep({ ...facts, account: {}, ai: "on" }) ?? "mailbox";
  }
  // THE DERIVATION CLOSES THE FLOW AND THE CURSOR MAY NOT REOPEN IT. `null` means the completion stamp is set —
  // cancelled or finished — and a cursor left over from the press that stamped it would keep the stage on screen
  // after the person asked to leave.
  if (derived === null) return null;
  if (cursor !== null) return cursor;
  // THE ONE PLACE THE OPENING SCREEN IS NOT THE DERIVED ONE. A run with no mailbox behind it has nothing to resume, so
  // it starts at the welcome; a run that resumes onto `mailbox` because the mailbox was REMOVED has a history and does
  // not need the greeting again.
  return facts.mailbox === null && derived === "mailbox" ? "welcome" : derived;
}
