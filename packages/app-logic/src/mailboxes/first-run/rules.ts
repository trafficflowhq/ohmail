/**
 * THE FIRST RUN'S RULES, moved out of the web shell's stage (`apps/webapp/app/shell/FirstRun.tsx`) as they stood:
 * which screen is on, the walk's next screen, the two holder waits, the window's rungs and the progress rail. Pure:
 * no React, no door, no clock. The old stage re-exports them until it leaves.
 */
import type { OnboardingFacts, OnboardingStep } from "../../doors/onboarding.js";
import type { FirstRunDecisionCount } from "../../doors/first-run-host.js";

/**
 * HOW LONG SETUP READS AGAIN WHILE IT WAITS FOR THE DOOR'S FIRST LOOK AT WHO HOLDS THE MAILBOX.
 * Past it the wait says it is slow and offers one more read; it never offers consent or Agree
 * over a look that has not answered.
 */
export const HOLDER_CHECK_MS = 60_000;

/** How often setup reads the facts again while it waits for that look. */
export const HOLDER_REREAD_MS = 2_000;

/** The history-depth options. `365` is the default and wears the word for it. */
export const WINDOWS = ["90", "180", "365", "all"] as const;
export type WindowChoice = (typeof WINDOWS)[number];

/**
 * THE RAIL — seven groups over eleven screens, because the rail names PHASES and several
 * screens are two halves of one phase (welcome/mailbox/elsewhere are all "get the mailbox in";
 * ai/provider are one question and its answer; summary/pair are both "done").
 *
 * Ordered, and the order is `onboardingPath`'s: a rail whose order disagreed with the path's
 * would light a dot the Back button walks away from.
 */
export const ALL_RAIL: ReadonlyArray<{ id: string; steps: OnboardingStep[] }> = [
  { id: "mailbox", steps: ["welcome", "mailbox", "elsewhere"] },
  { id: "organize", steps: ["consent"] },
  { id: "history", steps: ["window"] },
  { id: "ai", steps: ["ai", "provider"] },
  { id: "pull", steps: ["pull"] },
  { id: "decide", steps: ["decide"] },
  { id: "done", steps: ["summary", "pair"] },
];

/**
 * The rail this run actually walks — the groups above, filtered by the path. The list above is
 * every phase the flow HAS, not every phase a run walks: the rail used to draw all seven
 * whatever the path said, promising phases that never arrive and an `n / 7` total the person
 * never reaches (visible on the ADD run — no AI question, no pairing — and already wrong on a
 * run whose empty Screener queue skips `decide` silently). A phase survives when the path still
 * contains at least one of its steps, which keeps the groups meaningful: `ai`/`provider` are
 * one question and its answer, and a door with the question but not the form still has the
 * phase.
 */
export function railFor(path: readonly OnboardingStep[]): Array<{ id: string; steps: OnboardingStep[] }> {
  return ALL_RAIL.filter((r) => r.steps.some((step) => path.includes(step)));
}

/** The five destinations the guided decision offers, with the keycap each one wears. */
export const DECIDE_LEGEND: ReadonlyArray<{
  key: string;
  copy: "decideOhbox" | "decideReads" | "decideReceipts" | "decideScreened" | "decideSpam";
}> = [
  { key: "o", copy: "decideOhbox" },
  { key: "r", copy: "decideReads" },
  { key: "c", copy: "decideReceipts" },
  { key: "n", copy: "decideScreened" },
  { key: "x", copy: "decideSpam" },
];

/**
 * Is this read at least as new as the one that showed the holder? The whole ordering rule, with
 * its three degenerate cases together: NO BASELINE — the holder read carried no stamp (nothing
 * had happened to the mailbox, or a pre-column build); nothing to order against, so the explicit
 * verdict stands — the pre-ordering behaviour, kept rather than a refusal that could park
 * somebody on the claim question for ever. A BASELINE AND NO STAMP NOW — the row went backwards,
 * which only a read issued before the stamp existed can do: OLDER. BOTH — later or equal is
 * current (equal because a read can repeat a stamp while another column moves). Unparseable is
 * treated as absent on both sides.
 */
export function readIsNotOlder(readAt?: string | null, baseline?: string | null): boolean {
  const base = baseline ? Date.parse(baseline) : Number.NaN;
  if (!Number.isFinite(base)) return true;
  const seen = readAt ? Date.parse(readAt) : Number.NaN;
  if (!Number.isFinite(seen)) return false;
  return seen >= base;
}

/**
 * The floor only ever moves up. It is remembered from the reads that showed
 * a holder, and those arrive out of order too — an EARLIER holder read
 * landing after a later one, assigned rather than raised, would LOWER the
 * floor to its own older stamp, and a `nobody` carrying that same older
 * stamp would then pass the comparison: the ordering rule defeated by the
 * very disorder it was written for. A stamped floor is never lowered by an
 * unstamped read either — a read that carries nothing is no evidence about
 * which read is newer.
 */
export function raiseStamp(floor: string | null, seen?: string | null): string | null {
  const at = seen ? Date.parse(seen) : Number.NaN;
  if (!Number.isFinite(at)) return floor;
  const base = floor ? Date.parse(floor) : Number.NaN;
  if (!Number.isFinite(base)) return seen ?? null;
  return at > base ? (seen ?? null) : floor;
}

/**
 * THE NEXT SCREEN ALONG THE WALK — and it is never `undefined` for a step the walk does not hold.
 *
 * A cursor can sit outside its own run's path: `onboardingPath` drops `welcome` for an ADD run, and
 * "Start over" used to put the cursor exactly there. `indexOf` answered -1, `path[-1 + 1]` answered
 * `undefined`, and the intro's one control — "Set up a mailbox" — did nothing at all, every press,
 * on every driver, until the app was restarted. A step outside the walk has no next, so the honest
 * destination is the walk's START. Only a genuinely LAST step moves nowhere, which is what the
 * summary is.
 */
export function nextStep(path: readonly OnboardingStep[], step: OnboardingStep): OnboardingStep | undefined {
  const i = path.indexOf(step);
  const next = i >= 0 ? path[i + 1] : path[0];
  return next === step ? undefined : next;
}

/**
 * The window step's count, in words: all of it, more than N when the walk stopped at its bound, or
 * nothing to screen. While the first import is still reading the mailbox it is a count so far and
 * says so, never "nothing".
 */
export function decisionCountSentence(
  t: (key: string, values?: Record<string, number>) => string,
  c: FirstRunDecisionCount,
): string {
  if (!c.mirrored) {
    return c.letters === 0
      ? t("agreeCountReading")
      : t("agreeCountSoFar", { letters: c.letters, senders: c.senders });
  }
  if (c.letters === 0) return t("agreeCountNone");
  return t(c.complete ? "agreeCount" : "agreeCountFloor", { letters: c.letters, senders: c.senders });
}

/**
 * WHICH RUNG A STORED WINDOW SITS ON.
 *
 * `all_time` is a MODE and not a number, so it is answered first — reading it off `dormancyDays`
 * would put an account that screens everything onto whatever day-count happens to be stored
 * beside the mode. Everything else picks the CLOSEST offered rung, because the four on screen are
 * an offer and not the set of storable values: Settings will store any day-count from 1 to 365.
 */
export function initialWindow(screening?: {
  dormancyDays: number;
  scope: "window" | "all_time";
}): WindowChoice {
  if (!screening) return "365";
  if (screening.scope === "all_time") return "all";
  const rungs = [90, 180, 365] as const;
  let best: WindowChoice = "365";
  let bestGap = Number.POSITIVE_INFINITY;
  for (const r of rungs) {
    const gap = Math.abs(r - screening.dormancyDays);
    if (gap < bestGap) {
      bestGap = gap;
      best = String(r) as WindowChoice;
    }
  }
  return best;
}

/** The first sentence of the consent statement, re-shown under the window choice. */
export function firstSentence(s: string): string {
  const at = s.indexOf(". ");
  return at < 0 ? s : `${s.slice(0, at)}.`;
}

/**
 * WHO ORGANIZES THIS MAILBOX, by name, or `null` when nobody is NAMED. `null` is not the same as "nobody organizes
 * it": whether a holder exists at all is `readerHolder`'s question, and the surfaces ask that one first. A `null`
 * name is still not "another install" as a NAME: inventing one would read as a machine called "another install".
 * The copy has a legacy label for exactly that state.
 */
export function holderName(facts: OnboardingFacts): string | null {
  const by = facts.mailbox?.organizedBy;
  if (!by) return null;
  return by.name && by.name.trim() ? by.name : null;
}
