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
export { ensureHotPathIndexes, HOT_PATH_INDEXES } from "./hot-path-indexes.js";
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
  TRIGRAM_INDEXES, PROD_DB_HOST_ENV, DATA_API_SETTLE_MS,
  type ProdSetupReport, type JournalStatus, type AppliedWhens, type ProdSetupOptions,
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
