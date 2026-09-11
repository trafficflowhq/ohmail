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
