/**
 * `@trafficflow/db/admin` — the OPERATIONAL half of this package: schema migration,
 * search-extension provisioning, and the verified production setup command.
 *
 * It is a separate entry point on purpose. These modules pull `node:fs` (reading the
 * drizzle journal and the SQL files), drizzle's migrator, and the whole production
 * verification path — none of which any request ever executes. While they were re-exported
 * from the package ROOT, every import of `@trafficflow/db` dragged them in, which on
 * `apps/api-vercel` meant the serverless catch-all bundled the migrator and traced the
 * migration directory: cold-start work and bundle weight for code that only a human
 * operator runs, and a `Module not found: '../drizzle'` class of build hazard for a host
 * that migrates nothing.
 *
 * Runtime code imports `@trafficflow/db`. Tests, CLIs and provisioning import
 * `@trafficflow/db/admin`. If a runtime module ever needs something from here, that is the
 * signal to question the requirement, not to widen the root export.
 */
export {
  runMigrations, PartialMigrationError,
  LEGACY_MIGRATIONS_DIR, MAIL_MIGRATIONS_DIR, CLOUD_MIGRATIONS_DIR,
  MAIL_JOURNAL, CLOUD_JOURNAL, JOURNALS,
  MIGRATION_LOCK_KEY, MIGRATION_LOCK_TIMEOUT_MS,
} from "./migrate.js";
export {
  adoptBaseline, adoptionVerdict, baselineEntries, baselineObjects, readJournalOf,
  findLegacyMigrationsTable, missingObjects, AdoptionRefused,
  LEGACY_CUTOFF_WHEN, LEGACY_JOURNAL_WHENS,
  type AdoptionVerdict, type BaselineObjects, type JournalEntry, type JournalSpec,
} from "./baseline.js";
export { ensureSearchExtensions } from "./search-setup.js";
/**
 * The pre-migration duplicate guard. On `/admin` beside the migrator because it runs at the
 * same moment and for the same audience — and exported rather than kept private because
 * `runMigrations` is not the only path into the mail journal: `apps/sidecar/src/db.ts` (the
 * Desktop local engine) composes `adoptBaseline` + `migrate` itself and should call
 * `assertNoActiveAddressDuplicates` first for the same reason production does.
 */
export {
  assertNoActiveAddressDuplicates, findActiveAddressDuplicates, resolveActiveAddressDuplicates,
  activeAddressIndexExists, describeDuplicates, describeRow,
  ActiveAddressDuplicatesError, ACTIVE_ADDRESS_UQ,
  type DuplicateGroup, type DuplicateMailbox, type ResolutionOutcome,
} from "./mailbox-dedup.js";
export {
  setupProdDatabase, assertSessionUrl, assertExpectedHost, readJournals,
  readAppliedWhens, journalStatuses, journalProblems,
  TRIGRAM_INDEXES, PROD_DB_HOST_ENV,
  type ProdSetupReport, type JournalStatus, type AppliedWhens,
} from "./setup-prod.js";
