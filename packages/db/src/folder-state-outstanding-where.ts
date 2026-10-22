/**
 * An outstanding filing of ours, as mail 0160's index WHERE and trigger WHEN spell it, unqualified.
 * Its own module so both schema twins can declare the index without importing the predicates'
 * module (which imports the schema). `folder-state-pending.ts` re-exports it beside
 * `ourOutstandingFiling`, which renders the same text; a test holds them equal. Changing it is a new
 * migration: the index and the triggers carry this text.
 */
export const OUTSTANDING_FILING_WHERE =
  `"reconcile_status" = 'pending' and "last_set_by" = 'us' and "desired_folder" <> "observed_folder"`;
