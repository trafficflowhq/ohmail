/**
 * The away responder's pile scope — the closed set, the default and the pile words. Its own
 * module because two consumers need these values and only one can load `away-eligibility.ts`: the
 * pass decides with them, and the settings control and Ohbox banner DISPLAY with them — that file
 * imports `node:crypto` for {@link awayTextHash}, and the barrel is worse, conveying the whole
 * package's import closure into the published desktop artifact. So the vocabulary lives in a leaf
 * whose only import is the import-free `types.ts` (the exports map carries the `node` condition
 * that relative import requires), exported as `@trafficflow/core/away-scope`;
 * `away-eligibility.ts` imports it, which makes the set the engine refuses and the set the
 * control offers the same object rather than two lists that agree today.
 */

// Stored scopes and old installs still say `ohmail/Reads`; both spellings are the News pile.
import { canonicalDestination } from "./types.js";

/** Where a first-contact stranger waits. Its own name because two rules read it by name. */
export const AWAY_SCREENER_FOLDER = "ohmail/Screener";

/**
 * The piles a responder may be asked to answer, as FOLDER names. The pile a person calls "Ohbox"
 * is the folder `INBOX`; there is NO folder `ohmail/Ohbox` — the responder's own fixture once
 * carried that string. The compared value is `folder_state.desired_folder`, so this holds
 * destinations and {@link AWAY_PILE_VIEW} translates. Receipts is offered because
 * `neverAutoReply` refuses the machine mail per header; the Screener because the audience decides
 * FIRST and the write door refuses that pile beside `screened_in`. `ohmail/Screened` and
 * `ohmail/Quarantine` stay never-answered. The settings control imports this — a control offering
 * a pile the engine refuses appears to save and changes nothing.
 */
export const AWAY_ANSWERABLE_PILES = [
  "INBOX", "ohmail/News", "ohmail/Receipts", AWAY_SCREENER_FOLDER,
] as const;

export type AwayPile = (typeof AWAY_ANSWERABLE_PILES)[number];

/**
 * The piles answered when nobody has chosen — the Ohbox, alone.
 *
 * The NARROW member, unlike the throttle's default, which is the middle of its range. Widening
 * what a standing order reaches is the only irreversible thing this feature does: a reply sent to
 * somebody its owner did not mean cannot be recalled. Being answered later is recoverable, so the
 * value nobody chose reaches fewest people.
 */
export const AWAY_PILES_DEFAULT: readonly AwayPile[] = ["INBOX"];

/** Is this stored member one the engine will act on? The `text[]` column's own CHECK, in TS. */
export function isAwayPile(v: unknown): v is AwayPile {
  return typeof v === "string" && (AWAY_ANSWERABLE_PILES as readonly string[]).includes(v);
}

/**
 * The pile WORD for each answerable folder — what a person calls it, as a key the surface
 * translates. Deliberately only the four: this is the labelling of a control, not a second copy
 * of `VIEW_OF_FOLDER`, which still owns the full six-way mapping for every other surface.
 */
export const AWAY_PILE_VIEW: Readonly<Record<AwayPile, "ohbox" | "reads" | "receipts" | "screener">> = {
  "INBOX": "ohbox",
  "ohmail/News": "reads",
  "ohmail/Receipts": "receipts",
  "ohmail/Screener": "screener",
};

/**
 * WHICH DOOR A PILE SCOPE ARRIVED THROUGH — the published profile DOCUMENT, or a
 * `profile.update` REQUEST one of this account's installs sent. They admit different sets ON
 * PURPOSE. A request is this build talking to itself, so an unknown member is a refusal somebody
 * can act on; a document is read by installs of every version, so an unknown member is a NEWER
 * ohmail's and travels on for the importer — dropping it at the parse would make a round trip
 * through an older install narrow somebody's scope. The relation is stated, not merely true
 * today: the request's set is a SUBSET of the document's, driven by
 * `away-piles-one-validator.test.ts`.
 */
export type AwayPilesDoor = "request" | "document";

/** What one door made of the value it was handed. */
export type AwayPilesReading =
  /** The key was absent or null — "this says nothing about scope", never "answer nobody". */
  | { state: "unstated" }
  /** A real answer, deduped and in the order given. An EMPTY list is "answer nobody". */
  | { state: "stated"; piles: string[] }
  /** Unreadable. `member` names the offending value when there is one, for the door's sentence. */
  | { state: "unreadable"; reason: "not_an_array" | "not_a_member"; member?: string };

/**
 * THE ONE NARROWING for the away responder's pile scope, whichever door it came through.
 *
 * It was two — `pilesOf` in the document's parser, `validPiles` on the settings endpoint —
 * written three weeks apart with nothing asserting they agreed about which members exist: the day
 * one list moved, a scope would leave one door and be refused at the other while the person was
 * told it saved. DEDUPED at both, because the value is a SET everywhere else. A non-string member
 * is `not_an_array` and not `not_a_member` — the sentence is about the shape it was handed.
 */
export function readAwayPiles(v: unknown, door: AwayPilesDoor): AwayPilesReading {
  if (v === undefined || v === null) return { state: "unstated" };
  if (!Array.isArray(v)) return { state: "unreadable", reason: "not_an_array" };
  const piles: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") return { state: "unreadable", reason: "not_an_array" };
    // The pre-0.22 spelling of the News pile means the News pile, whichever door: a stored
    // scope or an older install's request must not narrow to "unreadable" over the rename.
    const member = canonicalDestination(raw);
    if (door === "request" && !isAwayPile(member)) {
      return { state: "unreadable", reason: "not_a_member", member: raw };
    }
    if (!piles.includes(member)) piles.push(member);
  }
  return { state: "stated", piles };
}

/**
 * MAY THIS SCOPE BE STORED BESIDE THIS AUDIENCE? — the one coupling between the two settings.
 *
 * `ohmail/Screener` holds strangers nobody has decided about, and `audience: 'screened_in'`
 * refuses them outright. A row asking for both states a scope the pass can never act on, so the
 * write doors refuse it and the settings control disables the box. Named here, in the leaf both
 * the doors and the control already import, so there is one statement of the rule.
 */
export function awayScopeFitsAudience(piles: readonly string[], audience: string): boolean {
  return audience === "everyone" || !piles.includes(AWAY_SCREENER_FOLDER);
}

/**
 * WHAT THE RESPONDER ACTUALLY ANSWERS — the display projection of `awayEligibility`'s ordered
 * rules, for the settings control and the banner sentence.
 *
 * The audience is asked first there, so a stored `ohmail/Screener` beside `screened_in` is INERT:
 * no waiting stranger is answered. A surface that drew that box ticked would state a reply going
 * out where none is. `away-eligibility.test.ts` holds the two together — a pile is answered iff it
 * is in this list.
 */
export function awayEffectivePiles(
  piles: readonly string[], audience: string,
): readonly string[] {
  return awayScopeFitsAudience(piles, audience)
    ? piles
    : piles.filter((p) => p !== AWAY_SCREENER_FOLDER);
}
