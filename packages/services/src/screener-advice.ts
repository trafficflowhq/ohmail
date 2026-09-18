import type { Destination, OhboxPolicy, SenderSignals } from "@trafficflow/core/mail";
import { CLASSIFY_DESTINATIONS, rationaleHoldsAtGate } from "@trafficflow/core/mail";

/**
 * How a stored classifier verdict reads as Screener advice — the derivation, in ONE place, for
 * THREE readers: `ScreenerService`'s fresh and stored paths, and `materializeScreenerSuggestion`
 * (`dto/materialize.ts`), which puts the same reading on `/sync` so a chip cannot say one thing
 * on the page and another in the mirror. Moved out of `screener-service.ts` unchanged when the
 * materializer became the third reader; the service re-exports nothing — every caller imports
 * from here. Pure functions over the row and the account's posture; no I/O, nothing to spend.
 */

/** The bulk-actionable reading of one verdict. See {@link SCREEN_DISPOSITION} for `hold`. */
export type ScreenDecision = "yes" | "no" | "hold";

/**
 * WHAT EACH ROUTING DESTINATION MEANS TO THE SCREENER. `Record<Destination, …>`, NOT a lookup
 * with a default, because the default is what broke: adding a folder to `Destination` without
 * deciding what it means for a stranger at the gate is now a COMPILE error, not a silent "yes".
 * This replaces a DENYLIST answering `false` (⇒ admit) for everything unnamed — and
 * `ohmail/Screener` was unnamed, though the taxonomy DEFINES it as right for a first-contact
 * sender; with "Apply all" that is a consent gate granting consent in bulk. A denylist is the
 * wrong shape for a question whose safe answer is "don't act".
 */
export const SCREEN_DISPOSITION: Record<Destination, ScreenDecision> = {
  "INBOX": "yes",
  "ohmail/Reads": "yes",        // posture may tighten this to "no" — see suggestionDecision
  "ohmail/Receipts": "yes",     // idem
  "ohmail/Screened": "no",
  "ohmail/Quarantine": "no",
  // NOT "no". The model declined to place this sender, it did not decline the sender. Turning that
  // into a decline would auto-screen-out real first-contact people on the same bulk control that
  // used to auto-admit them — a different wrong answer, not a fix.
  "ohmail/Screener": "hold",
};

/**
 * The Yes/No/Hold reading of a classifier verdict UNDER THE ACCOUNT'S OHBOX POSTURE — every
 * reader goes through here, so a suggestion cannot read one way fresh, another on the next page
 * load, and a third in a client's mirror. "hold" is advice with no action. POSTURE TIGHTENS
 * "YES": under `people_only` a first-contact sender filed into `ohmail/Reads`/`ohmail/Receipts`
 * reads "no". THE RATIONALE IS CROSS-CHECKED: prose concluding "hold at the Screener" beside a
 * `destination` past the gate downgrades to "hold" (`rationaleHoldsAtGate`). Total over strings,
 * not over the union: it reads a `text` column a past version may have written — an unrecognised
 * label becomes the gate, which is `hold`, never a guess.
 */
export function suggestionDecision(
  destination: string, spam: boolean, rationale: string, ohboxPolicy: OhboxPolicy,
): ScreenDecision {
  // Spam is the model's own hard "no" and outranks everything, including the label.
  if (spam) return "no";
  const disposition = SCREEN_DISPOSITION[destination as Destination] ?? "hold";
  if (disposition !== "yes") return disposition;
  if (rationaleHoldsAtGate(rationale)) return "hold";
  if (ohboxPolicy === "people_only"
    && (destination === "ohmail/Reads" || destination === "ohmail/Receipts")) return "no";
  return "yes";
}

/**
 * ONE stored row, read as advice — the decision AND the answer the decision collapses. The
 * shared-ness makes a change here retroactive: stored rows re-read through it with no backfill.
 * `destination` is normalised against the taxonomy for the reason {@link suggestionDecision} is
 * total over strings; an unrecognised label becomes the gate.
 */
export function suggestionAdvice(
  destination: string, spam: boolean, rationale: string, ohboxPolicy: OhboxPolicy,
): { decision: ScreenDecision; destination: Destination; spam: boolean } {
  const dest: Destination = CLASSIFY_DESTINATIONS.includes(destination as Destination)
    ? (destination as Destination)
    : "ohmail/Screener";
  return {
    decision: suggestionDecision(dest, spam, rationale, ohboxPolicy),
    destination: dest,
    spam: spam === true,
  };
}

/**
 * THE REASON'S OWN WORDS — ohmail's, never the sender's: the brand comes out of the curated
 * dictionary and the count out of the set we just measured, so a surface may render both.
 * Built in one place because three paths emit them and a second spelling is a second answer.
 */
export function reasonDetail(signals: SenderSignals): { reasonBrand?: string; reasonCount?: number } {
  if (signals.reasonCode === "impersonation" && signals.impersonation) {
    return { reasonBrand: signals.impersonation.brand };
  }
  if (signals.reasonCode === "campaign" && signals.campaign) {
    return { reasonCount: signals.campaign.count };
  }
  return {};
}
