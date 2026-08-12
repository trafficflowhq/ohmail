import type { SchemaMarker, CheckDefinitionMarker } from "./health.js";

/**
 * WHERE THE BOTH-HALVES SCHEMA CENSUS IS REGISTERED, and why it is registered rather than
 * imported.
 *
 * `/health` probes for a set of table/column markers and answers 503 `schema_incomplete` when one
 * is missing. The hosted set names Cloud tables — the staff directory's stored password, the staff
 * session store's token digest, the billing ledger's dedup column — and `routes/health.ts` is
 * mounted by the LOCAL route table, which is bundled into the shipped desktop engine. Compiled in, those names
 * were live data in an artifact a stranger downloads: the engine build censuses its own bundle
 * for them, and after the `@trafficflow/db` barrel split closed every import edge they were the
 * last remaining occurrence.
 *
 * So the list lives in `health-cloud.ts` and reaches the route through this registry. Loading
 * `routes/index.ts` — the HOSTED route table — is what registers it; `routes/local.ts` does not
 * import it, so a local install probes the mail half alone, which is the only half its database
 * has. This is the same shape as `packages/services/src/mailbox-allowance-registry.ts`, for the
 * same reason: a value the hosted half needs as a default, which the mail half must not import.
 *
 * ── WHY UNREGISTERED FALLS BACK TO MAIL RATHER THAN FAILING ───────────────────────────────
 *
 * The allowance registry refuses when unset, because admitting would silently drop a paid limit.
 * The reasoning inverts here. `schemaTier` — declared by the host, `deps.ts` — is what says which
 * schema this deployment is supposed to have, and it is checked BEFORE this: a host that claims
 * the full tier and has not loaded the hosted route table cannot serve a single hosted route
 * either, so there is no configuration in which this silently narrows a real deployment's probe.
 * Refusing here would instead take `/health` down for the local engine, whose whole point is that
 * it legitimately has no Cloud tables — and `/health` answering 503 about a complete database is
 * the exact failure the tier flag was introduced to stop.
 */
export interface SchemaCensus {
  markers: ReadonlyArray<SchemaMarker>;
  /**
   * Constraints probed by DEFINITION rather than by name — the shape a REPLACEMENT migration
   * takes, which every name-keyed catalog is blind to. Cloud `0011` is why this field exists.
   */
  checkDefinitions: ReadonlyArray<CheckDefinitionMarker>;
  /**
   * Cloud INDEX names probed through `pg_indexes`, beyond the shared `SCHEMA_INDEX_MARKERS`
   * list — which cannot hold them, because it lives in `health.ts` and ships in the desktop
   * engine while these entries name Cloud tables. Cloud `0013` (the trial-once partial unique
   * index) is why this field exists.
   */
  indexMarkers: ReadonlyArray<string>;
  expected: number;
  through: string;
}

let registered: SchemaCensus | null = null;

/** Called by `health-cloud.ts` on load, which only the hosted route table imports. */
export function registerSchemaCensus(census: SchemaCensus): void {
  registered = census;
}

/** The hosted census, or `null` — see the header for why `null` is a mail-tier answer, not a fault. */
export function fullSchemaCensus(): SchemaCensus | null {
  return registered;
}
