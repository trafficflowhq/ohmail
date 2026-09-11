/**
 * The away responder's pile scope — the closed set, the default and the pile words. Its own
 * module because two consumers need these values and only one can load `away-eligibility.ts`: the
 * pass decides with them, and the settings control and Ohbox banner DISPLAY with them — that file
 * imports `node:crypto` for {@link awayTextHash}, and the barrel is worse, conveying the whole
 * package's import closure into the published desktop artifact. So the vocabulary lives in a leaf
 * with NO imports, exported as `@trafficflow/core/away-scope`; `away-eligibility.ts` imports it,
 * which makes the set the engine refuses and the set the control offers the same object rather
 * than two lists that agree today.
 */

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
  "INBOX", "ohmail/Reads", "ohmail/Receipts", AWAY_SCREENER_FOLDER,
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
  "ohmail/Reads": "reads",
  "ohmail/Receipts": "receipts",
  "ohmail/Screener": "screener",
};

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
