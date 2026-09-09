/**
 * THE AWAY RESPONDER'S PILE SCOPE — the closed set, the default, the pile words and the ONE
 * derivation the banner's sentence is chosen by.
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

/**
 * THE PILES A RESPONDER MAY BE ASKED TO ANSWER, as FOLDER names.
 *
 * ── FOLDERS, AND THE DIFFERENCE HAS ALREADY BITTEN ONCE ─────────────────────────────────────
 *
 * The pile a person calls "Ohbox" is the folder `INBOX`. `VIEW_OF_FOLDER` (client-engine) maps
 * the six destinations onto the six pile words, and `ohmail/Quarantine` is the one a person calls
 * "Spam". THERE IS NO FOLDER `ohmail/Ohbox` — the away responder's own test fixture carried that
 * string for three cases, so each measured a placement the router cannot produce, and nothing
 * read the value closely enough to notice until the pile rule did.
 *
 * The value compared at decision time is `folder_state.desired_folder`, which holds a
 * destination. So this set holds destinations and {@link AWAY_PILE_VIEW} does the translation,
 * once.
 *
 * ── WHY TWO MEMBERS AND NOT SIX ─────────────────────────────────────────────────────────────
 *
 * Receipts, Screened and Quarantine are refused by the never-answered map in
 * `away-eligibility.ts` — a receipt is machine mail about a transaction the account started, and
 * the other two are the pipeline's and the account's own "no". `ohmail/Screener` is deliberately
 * absent for a different reason: it is the AUDIENCE's decision, and `audience: 'everyone'` exists
 * precisely to answer the strangers waiting there. Offering it as a pile too would let two
 * settings rule on one population, and whichever was consulted second would silently win.
 *
 * So what is left to choose is Reads, beside the Ohbox, which is always answerable because a
 * responder that answers nothing is not a responder.
 *
 * THE SETTINGS CONTROL IMPORTS THIS. A control offering a pile the engine refuses is a setting
 * that appears to save and changes nothing.
 */
export const AWAY_ANSWERABLE_PILES = ["INBOX", "ohmail/Reads"] as const;

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
 * translates. Deliberately only the two: this is the labelling of a control, not a second copy of
 * `VIEW_OF_FOLDER`, which still owns the full six-way mapping for every other surface.
 */
export const AWAY_PILE_VIEW: Readonly<Record<AwayPile, "ohbox" | "reads">> = {
  "INBOX": "ohbox",
  "ohmail/Reads": "reads",
};

/**
 * WHICH SENTENCE THE BANNER AND THE SETTING SAY — one key per reachable state of the column.
 *
 * ── WHY A DERIVED KEY AND NOT THE ARRAY ─────────────────────────────────────────────────────
 *
 * The scope has to appear inside a sentence that already varies by audience and by rate, and ICU
 * `select` needs a finite selector — an array is not one. A key per combination of all three would
 * be sixteen sentences to write and keep in agreement, where the failure mode is one of the
 * sixteen quietly describing a responder that behaves differently. So the scope collapses to one
 * of four words here, once, and the catalogue carries one sentence with three enumerated parts.
 *
 * ── IT IS TOTAL, AND THAT IS THE POINT ──────────────────────────────────────────────────────
 *
 * The column's CHECK is CONTAINMENT (`<@`), so all four subsets are representable, including the
 * empty one. Three of them are reachable through the product today and the fourth — Reads without
 * the Ohbox — is reachable through the API. Every one gets a key that is TRUE of it rather than a
 * fall-through to the commonest case: a scope sentence that names the Ohbox for a responder which
 * is not answering the Ohbox is a false claim about mail leaving somebody's account, and it is the
 * kind that reads perfectly.
 *
 * An unknown member in the stored array is IGNORED for this purpose rather than given a fifth
 * key. It cannot be acted on (the rule's `includes` refuses it), so a sentence must not imply it
 * is — and the two members that decide this answer are read by name, so a widening migration that
 * lands ahead of its code still produces a true sentence about what is happening today.
 */
export type AwayScope = "ohbox" | "reads" | "ohbox_reads" | "none";

export function awayScopeKey(piles: readonly string[]): AwayScope {
  const ohbox = piles.includes("INBOX");
  const reads = piles.includes("ohmail/Reads");
  if (ohbox && reads) return "ohbox_reads";
  if (ohbox) return "ohbox";
  if (reads) return "reads";
  return "none";
}
