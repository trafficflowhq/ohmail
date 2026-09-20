/**
 * The named allowances: applied migrations whose executable SQL genuinely differs from the file
 * this tree ships, admitted ONE AT A TIME with the reason written down.
 *
 * An allowance is keyed on all four fields — journal, tag, the hash the row records AND the hash
 * this tree ships. Keyed on the tag alone it would admit any future edit of that file; keyed on
 * both hashes it names exactly one pair of texts and expires the moment either side moves.
 * Nothing here is a bypass: an entry states which two versions were compared BY HAND and why the
 * schemas they produce are the same.
 */
export interface MigrationAllowance {
  /** `mail` | `cloud` — the journal the row lives in. */
  readonly journal: string;
  readonly tag: string;
  /** 64-hex, what `__drizzle_migrations.hash` holds for this entry. */
  readonly recorded: string;
  /** 64-hex, `sha256` of the `.sql` this tree ships for this tag. */
  readonly shipped: string;
  readonly reason: string;
}

/**
 * ONE entry. Mail 0037 ran `ADD CONSTRAINT drafts_html_cap CHECK (octet_length(html) <= 262144)`
 * bare; the file later gained a `DO $$ ... EXCEPTION WHEN duplicate_object THEN null; END $$;`
 * wrapper so a re-run over an existing constraint is a no-op. The constraint, its name and its
 * predicate are identical on both sides, so the schema a deployment ends with is the same.
 */
export const MIGRATION_ALLOWANCES: readonly MigrationAllowance[] = [
  {
    journal: "mail",
    tag: "0037_draft_html",
    recorded: "7237cafe837fe1cd50c567f2e2de8fbd4ac57370970a9b437c79d4a61cd1ae0f",
    shipped: "45a6fbc19da51ee2ff8b7c7962c309d26036ae4a225dee9e728318bea685c48a",
    reason:
      "idempotency guard added after apply (the bare ADD CONSTRAINT gained a DO $$ ... EXCEPTION " +
      "WHEN duplicate_object block); the constraint, its name and its predicate are unchanged, " +
      "so the resulting schema is identical",
  },
  {
    journal: "mail",
    tag: "0120_held_release_dismissed",
    recorded: "a6103bca59c94c095b92b5fd59e52b608c6fb34fce486ff02cf4d311e703bb65",
    shipped: "70cc9398682838799a87387766416edd541e71dd92c06eaade3563e73b48cc7c",
    reason:
      "a DROP CONSTRAINT IF EXISTS added in front of the bare ADD CONSTRAINT after apply, so the " +
      "entry can be re-executed the way the replay guards require; the CHECK, its name and its " +
      "predicate are unchanged, and a drop of a constraint the next statement re-adds leaves the " +
      "same schema. The recorded side is the ONE released version of this file — production " +
      "applied it before the flat form was written, which is why this entry exists at all",
  },
] as const;

/** The allowance admitting exactly this drift, or null. Every field must match. */
export function allowanceFor(
  journal: string,
  tag: string,
  recorded: string,
  shipped: string,
): MigrationAllowance | null {
  return (
    MIGRATION_ALLOWANCES.find(
      (a) => a.journal === journal && a.tag === tag && a.recorded === recorded && a.shipped === shipped,
    ) ?? null
  );
}
