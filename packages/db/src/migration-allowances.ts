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
  /* MAIL 0021 and MAIL 0022, both byte-frozen at 0.19.1 and both taking the flat replayable form
   * here. Each has SEVERAL recorded sides because each file was comment-rewritten after it
   * shipped, and a row holds whichever bytes that database applied: every historical version whose
   * EXECUTABLE SQL is the released one is admitted, and the version whose executable SQL is not
   * (0021's pre-release draft) deliberately is not. `migration-allowance-coverage.test.ts` derives
   * that set from git and refuses a missing one AND an extra one. */
  {
    journal: "mail",
    tag: "0021_mailbox_address_unique",
    recorded: "023bda82bb91edc7fc936d6ab78dc5977eacb8721f82f1c9a7e5caedb41ce39e",
    shipped: "c7618c005d3a633341ef18091c606885b67e8df6620312e237265df7bb107b3f",
    reason:
      "a DROP INDEX IF EXISTS added in front of the CREATE UNIQUE INDEX after apply, so the entry " +
      "is replayable; the index, its name, its columns and its partial predicate are unchanged, " +
      "and a drop of an index the next statement rebuilds leaves the same schema",
  },
  {
    journal: "mail",
    tag: "0021_mailbox_address_unique",
    recorded: "7201608975888466d3fdc2b95ec472a50e272c30b322ad3071100e909aeb2c57",
    shipped: "c7618c005d3a633341ef18091c606885b67e8df6620312e237265df7bb107b3f",
    reason:
      "the same pair, for the earlier comment-only version of this file — a database that applied " +
      "it before the comments were rewritten records those bytes and would drift identically",
  },
  {
    journal: "mail",
    tag: "0022_message_body_html_cap",
    recorded: "f59b8717ffc8e24297395265848cf483494b95e4ec628c7204fddaf693c34483",
    shipped: "3ddfe517b312e39236fc5c52d51ca6a3ab97ecd7925c7ff5105a9957a309e3b2",
    reason:
      "a DROP CONSTRAINT IF EXISTS added in front of the bare ADD CONSTRAINT after apply, so the " +
      "entry is replayable; the CHECK, its name and its predicate are unchanged, and a drop of a " +
      "constraint the next statement re-adds leaves the same schema",
  },
  {
    journal: "mail",
    tag: "0022_message_body_html_cap",
    recorded: "ab9fcec7894aa422d5e7dfc1c0e911a25b803bb039978963c182f9d2c0efc53a",
    shipped: "3ddfe517b312e39236fc5c52d51ca6a3ab97ecd7925c7ff5105a9957a309e3b2",
    reason:
      "the same pair, for the middle comment-only version of this file — see the entry above",
  },
  {
    journal: "mail",
    tag: "0022_message_body_html_cap",
    recorded: "6c8d15b02a2fbaeece3b5aacab167566ae4aa43f43f41468bc278ccb61905d34",
    shipped: "3ddfe517b312e39236fc5c52d51ca6a3ab97ecd7925c7ff5105a9957a309e3b2",
    reason:
      "the same pair, for the first released version of this file — see the two entries above",
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
  {
    journal: "cloud",
    tag: "0038_account_isolation",
    recorded: "78c3b141c13b785d03ecbe4788ab0618554dbe72d2ebe9f57527f656251abc81",
    shipped: "13c93b9f771addc208fe17dae4a2db92131e7cae9f890a6552ba01d26bc2efd0",
    reason:
      "three DROP CONSTRAINT IF EXISTS statements added in front of the three ADD CONSTRAINTs " +
      "after apply, so the entry can be re-executed the way mail 0118 — its other half — already " +
      "can; the three keys, their names, their columns and their references are unchanged, and a " +
      "drop of a constraint the next statement re-adds leaves the same schema",
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
