/**
 * THE AWAY RESPONDER'S PILE SCOPE — the closed set, the default and the pile words.
 *
 * ── WHY IT IS ITS OWN MODULE AND NOT PART OF `away-eligibility.ts` ──────────────────────────
 *
 * Two consumers need these values and only one of them can load that file. The pass decides with
 * them; the settings control and the Ohbox banner DISPLAY with them — and `away-eligibility.ts`
 * imports `node:crypto` for {@link awayTextHash}, so a browser reaching for the constants there
 * would drag a node builtin into a client bundle. `@trafficflow/core`'s barrel is worse: a value
 * import from it conveys the whole package's import closure into the published desktop artifact.
 *
 * So the vocabulary lives here, in a leaf with NO imports at all, exported as
 * `@trafficflow/core/away-scope` (the shape `./folder-name` and `./ics` already use — a source
 * path, transpiled by whichever bundler asks for it). `away-eligibility.ts` imports it, which is
 * what makes the set the engine refuses and the set the control offers the same object rather
 * than two lists that agree today.
 */

/** Where a first-contact stranger waits. Its own name because two rules read it by name. */
export const AWAY_SCREENER_FOLDER = "ohmail/Screener";

/**
 * THE PILES A RESPONDER MAY BE ASKED TO ANSWER, as FOLDER names.
 *
 * ── FOLDERS, AND THE DIFFERENCE HAS ALREADY BITTEN ONCE ─────────────────────────────────────
 *
 * The pile a person calls "Ohbox" is the folder `INBOX`. `VIEW_OF_FOLDER` (client-engine) maps
 * the six destinations onto the six pile words, and `ohmail/Quarantine` is the one a person calls
 * "Spam". THERE IS NO FOLDER `ohmail/Ohbox` — the away responder's own test fixture carried that
 * string for three cases, so each measured a placement the router cannot produce.
 *
 * The value compared at decision time is `folder_state.desired_folder`, which holds a
 * destination. So this set holds destinations and {@link AWAY_PILE_VIEW} does the translation.
 *
 * ── FOUR MEMBERS, AND THE TWO THAT WERE ADDED ───────────────────────────────────────────────
 *
 * Receipts and the Screener are offered. Both were argued against here when the set was two, and
 * both arguments are answered rather than dropped:
 *
 *   RECEIPTS was refused as "machine mail about a transaction the account started". Most of it
 *   is, and `neverAutoReply` is what refuses it — per header, for every pile, whether or not this
 *   box is ticked. What is left is a receipt a person typed, in a pile its owner chose to answer,
 *   which is their decision and not this module's. It is no longer in the never-answered map, so
 *   ticking the box has an effect.
 *
 *   THE SCREENER was refused because it is the AUDIENCE's population and two settings ruling on
 *   one population would contradict. They cannot now: the audience decides FIRST (a stranger
 *   still held there is refused outright unless `audience: 'everyone'`), the pile decides second,
 *   and the write door refuses `ohmail/Screener` in the scope of a `screened_in` responder, so
 *   the contradictory row is not representable.
 *
 * `ohmail/Screened` and `ohmail/Quarantine` stay out and stay in the never-answered map: one is
 * the durable "no" of a screening decision, the other is mail the pipeline judged hostile.
 *
 * THE SETTINGS CONTROL IMPORTS THIS. A control offering a pile the engine refuses is a setting
 * that appears to save and changes nothing.
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
