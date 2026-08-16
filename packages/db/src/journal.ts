/**
 * `@trafficflow/db/journal` — the migration JOURNAL SPECS and the adoption path, and nothing
 * that opens a server connection.
 *
 * ## Why this exists, measured rather than argued
 *
 * `@trafficflow/db/admin` is already the operational entry point, and for the API host it is
 * the right boundary: a serverless request never migrates, so keeping the migrator out of the
 * root barrel keeps it out of the request bundle. The desktop engine is the case that entry
 * point cannot serve, because the engine DOES migrate — it composes `adoptBaseline` + PGlite's
 * own migrator itself on every launch — and `/admin` re-exports `setup-prod.js`, which reaches
 * the billing tables, the admin database handle and `schema-cloud`.
 *
 * The cost was not theoretical. A census over the built engine artifact refused it: the bundle
 * carried the hosted service's credential-material columns, its staff directory and its billing
 * ledger, plus dozens of references to the payment processor and to the hosted database host.
 * **One import produced all of it**:
 * `apps/sidecar/src/db.ts` took `MAIL_JOURNAL` and `adoptBaseline` from `/admin`. The schema
 * split had already done its half — `schema-cloud` arrives here only through `/admin`, never
 * through the schema barrel — so this is the remaining edge, not a new one.
 *
 * ## The server driver stays out, on purpose
 *
 * This entry point deliberately does NOT re-export `runMigrations`. `runMigrations` is the
 * postgres-js migrator — it opens a `postgres` connection and takes an advisory lock — and a
 * re-export of it here would drag the `postgres` package, the SOCKS client and the IP-address
 * parser into the engine's import closure, provisioning code inside a public AGPL download that
 * migrates with PGlite and never speaks the wire protocol. So the run function lives on `/admin`
 * (its only callers are hosts and tests), and this file exposes the pieces the engine composes
 * for ITS migrator: the journal specs (pure `node:path` data, from `journal-specs.js`), the
 * baseline adoption path, and the pre-migration duplicate guard. None of `journal-specs.js`,
 * `baseline.js` or `mailbox-dedup.js` reaches billing, auth, staff, the cloud schema or a server
 * driver.
 *
 * **A new export here is a decision about what the desktop download conveys**, not a
 * convenience. A test asserts this file's import closure stays clean — of hosted-service tables
 * AND of the `postgres` driver — so widening it fails in the suite rather than at a census
 * someone has to remember to run, and the engine build's census over the finished bundle is the
 * second line, because a closure test reads imports and an artifact is what ships.
 *
 * Anything provisioning-shaped (production setup, search extensions, running a journal against a
 * server) stays on `/admin`. A host that needs both imports both; the point is that the engine
 * needs one.
 */
export {
  MAIL_MIGRATIONS_DIR, CLOUD_MIGRATIONS_DIR, LEGACY_MIGRATIONS_DIR,
  MAIL_JOURNAL, CLOUD_JOURNAL, JOURNALS,
} from "./journal-specs.js";
export {
  adoptBaseline, adoptionVerdict, baselineEntries, baselineObjects, readJournalOf,
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
