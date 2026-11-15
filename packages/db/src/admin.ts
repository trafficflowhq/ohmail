/**
 * `@trafficflow/db/admin` — the operational half: schema migration, search-extension
 * provisioning, the verified production setup. A separate entry point: these modules pull
 * `node:fs`, drizzle's migrator, and the verification path — nothing any request executes.
 * Re-exported from the root, every import dragged them in: cold-start work and bundle weight on
 * the serverless host, and a `Module not found: '../drizzle'` build hazard for a host that
 * migrates nothing. Runtime code imports `@trafficflow/db`; tests, CLIs and provisioning import
 * `@trafficflow/db/admin`. A runtime module needing something here is a signal to question the
 * requirement, not widen the root.
 */
export { ensureHotPathIndexes, HOT_PATH_INDEXES, HOT_PATH_INDEX_SPECS } from "./hot-path-indexes.js";
export {
  runMigrations, migrateToOldHeads, PartialMigrationError, TransitionNeedsRunner, type MigrateOptions,
  LEGACY_MIGRATIONS_DIR, MAIL_MIGRATIONS_DIR, CLOUD_MIGRATIONS_DIR,
  MAIL_JOURNAL, CLOUD_JOURNAL, JOURNALS,
  MIGRATION_LOCK_KEY, MIGRATION_LOCK_TIMEOUT_MS,
} from "./migrate.js";
/**
 * The 2.0 transition: one transaction that takes a store at 1.0.11's heads to 2.0, or changes
 * nothing. `runMigrations` runs it in the one state it fires in; a rehearsal calls it directly.
 */
export {
  runTransition, transitionState, sealedOpener, describeEvent, safeName, readWindow,
  TransitionRefused, TransitionFailed, NOTHING_OPENS, MAP_2_0, tablesOf, accountTablesOf, accountTablesFromCatalog,
  type StoreKind, type TransitionInput, type TransitionReport, type TransitionState, type TransitionEvent,
  type TransitionLog, type SealedOpener, type Decrypts, type Verdict, type CountLine,
} from "./transition/index.js";
/** Where the 1.0 line ends and 2.0 begins. */
export {
  OLD_HEADS, LINE_2_0_START, TRANSITION_WINDOW, entryNumber, inTransitionWindow, windowEntries,
  type ServerJournal,
} from "./journal-heads.js";

export {
  adoptBaseline, adoptionVerdict, baselineEntries, baselineObjects, readJournalOf,
  findLegacyMigrationsTable, missingObjects, AdoptionRefused,
  LEGACY_CUTOFF_WHEN, LEGACY_JOURNAL_WHENS,
  type AdoptionVerdict, type BaselineObjects, type JournalEntry, type JournalSpec,
} from "./baseline.js";
export {
  ensureSearchExtensions, ensureWordIndex, WORD_INDEX_SPEC,
  retireOldSearch, BodyVectorLockTimeout, BODY_VECTOR_INDEX, OLD_SEARCH_RETIREMENT, type OldSearchRetirement,
} from "./search-setup.js";
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
  readAppliedWhens, appliedRowsOf, digestMismatches, journalStatuses, journalProblems,
  TRIGRAM_INDEXES, PROD_DB_HOST_ENV, DATA_API_SETTLE_MS,
  type ProdSetupReport, type JournalStatus, type JournalMismatch, type AppliedRows,
  type AppliedWhens, type ProdSetupOptions,
} from "./setup-prod.js";
/**
 * The Data API half of the lockdown, for a caller that provisions a Supabase-shaped host and
 * must therefore reach a verdict about the endpoint in front of it — not just about the grants.
 * `dataApiPolicyFromEnv` is what `pnpm db:setup:prod` passes; a host with no such credentials
 * gets `unverifiable`, which a Supabase-shaped target turns into a refusal rather than a skip.
 */
export {
  dataApiPolicyFromEnv, DATA_API_ENV, SENSITIVE_PROBE_TABLES,
  type DataApiPolicy, type DataApiDeps, type DataApiTarget,
} from "./supabase-lockdown-core.js";
