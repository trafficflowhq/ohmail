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

const REPLAY_GUARD_REASON =
  "IF NOT EXISTS added before release; column, type, default and NOT NULL unchanged, so the schema is identical";

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
  {
    journal: "mail",
    tag: "0214_invitation_proposals",
    recorded: "7343a3baa62f050aba6c4fb2027735853825e819c1158c968857ad7cb4761b9d",
    shipped: "a10dc0d832c1487a8dc133ab4b12478d5d429bfa7c00bf430f01bf5fc0ee871d",
    reason: REPLAY_GUARD_REASON,
  },
  {
    journal: "mail",
    tag: "0215_calendar_removed_occurrences",
    recorded: "10686a3b7e8baff72f2fa5cb58c5b374681c6d12348fe9f3980970cd6ff8f9d5",
    shipped: "a3b8a503103ab657d759cc103ef1074a8c11e2ea75bec1b76e413035a30994b7",
    reason: REPLAY_GUARD_REASON,
  },
  {
    journal: "mail",
    tag: "0216_calendar_native_move",
    recorded: "cb4e271d2635f17eedc180dc4cb1da3341afd2ddeba0077cca6efb8685097d21",
    shipped: "57261b6587c438f5cf90f8e4698a06172f3787d01ee457c94dd8085087f1ae17",
    reason: REPLAY_GUARD_REASON,
  },
  {
    journal: "mail",
    tag: "0217_calendar_portable_copy",
    recorded: "3eb593144386ac280eb8a9917ca32cc9615d0eccddd24ede4b05fd32eecd7f7c",
    shipped: "4a5ea7b4b064a1f826d05cab79829efd24bc3d76314c428ae96996ec102480fb",
    reason: REPLAY_GUARD_REASON,
  },
  {
    journal: "mail",
    tag: "0219_hosted_invitation_details",
    recorded: "ba48747593712fda9ccc22919c19c97fa0b9058939658e50be688bce4f4b2149",
    shipped: "c332f3198566c98f00cabcffb334f6cd48d3a14ed728af5749e6f76ff96d53cd",
    reason: REPLAY_GUARD_REASON,
  },
  {
    journal: "cloud",
    tag: "0106_security_notice_recipients",
    recorded: "ea2373a2a699f73a9451f000141f8d6b5286bdd7e63c3519bbe92d670f318b18",
    shipped: "6868a3224192c76c19c1a506ff77cfd02df729023e0073494663fc4610a7287d",
    reason: REPLAY_GUARD_REASON,
  },
  {
    journal: "mail",
    tag: "0227_calendar_session_scope",
    recorded: "ffc8021939a5e7e060a54661bb7ff91d55fe02ee61a59101e19e00b7a0d5df0d",
    shipped: "0cb4fd9cfc9498aac08f9456660af8d55cc006acf5304a00bc08e6ee1e31906c",
    reason:
      "the same session scope constraint is installed without a scan, then validated after the " +
      "mail journal commits; previously applied versions already have the identical validated check",
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
