/**
 * `@trafficflow/db/journal` — the migration journal specs and the adoption path, and nothing that
 * opens a server connection. `/admin` cannot serve the desktop engine: the engine migrates
 * (PGlite plus `adoptBaseline`), and `/admin` re-exports `setup-prod.js`, which reaches billing
 * and `schema-cloud` — the engine-artifact census refused exactly that, produced by ONE import.
 * This entry point deliberately does NOT re-export `runMigrations`: the postgres-js migrator
 * would drag the `postgres` package into a public AGPL download that migrates with PGlite. A new
 * export here decides what the desktop download conveys: a test asserts this file's closure stays
 * clean of hosted tables and the `postgres` driver; the engine build's census is the second line.
 */
export {
  MAIL_MIGRATIONS_DIR, CLOUD_MIGRATIONS_DIR, LEGACY_MIGRATIONS_DIR,
  MAIL_JOURNAL, CLOUD_JOURNAL, JOURNALS,
} from "./journal-specs.js";
/** Where the 1.0 line ends and 2.0 begins: data, no driver. */
export {
  OLD_HEADS, LINE_2_0_START, TRANSITION_WINDOW, entryNumber, inTransitionWindow, windowEntries,
  type ServerJournal,
} from "./journal-heads.js";
/**
 * The 2.0 transition, for a desktop's own store: the same function a server runs, on PGlite. Its
 * closure is the journal's files, the heads and its own map; no server driver, no Cloud schema.
 */
export {
  runTransition, transitionState, sealedOpener, describeEvent, TransitionRefused, TransitionFailed, NOTHING_OPENS,
  type SealedOpener, type Decrypts, type TransitionEvent, type TransitionReport, type TransitionState,
} from "./transition/index.js";
export {
  adoptBaseline, adoptReissuedOriginals, adoptionVerdict, baselineEntries, baselineObjects, readJournalOf,
  findLegacyMigrationsTable, missingObjects, AdoptionRefused,
  LEGACY_CUTOFF_WHEN, LEGACY_JOURNAL_WHENS,
  type AdoptionVerdict, type BaselineObjects, type JournalEntry, type JournalSpec,
} from "./baseline.js";
export {
  assertNoActiveAddressDuplicates, findActiveAddressDuplicates, resolveActiveAddressDuplicates,
  activeAddressIndexExists, describeDuplicates, describeRow,
  ActiveAddressDuplicatesError, ACTIVE_ADDRESS_UQ,
  type DuplicateGroup, type DuplicateMailbox, type ResolutionOutcome,
} from "./mailbox-dedup.js";
/**
 * The search extensions' tail of a migration, for the desktop engine: `pg_trgm` and `btree_gin`
 * and the trigram indexes, so a local store answers the substring and typo arms with the server's
 * own indexes. The closure is `search-setup.ts` → `concurrent-index.ts` → `migration-lock.ts`,
 * none of which opens a server connection or names the server driver.
 */
export { ensureSearchExtensions, TRIGRAM_INDEX_SPECS } from "./search-setup.js";
