import type { SchemaMarker, CheckDefinitionMarker, FunctionDefinitionMarker } from "./health.js";

/**
 * Where the both-halves schema census is registered, and why registered rather than imported. The
 * hosted marker set names Cloud tables, and `routes/health.ts` is mounted by the local route
 * table bundled into the shipped desktop engine — compiled in, those names were live data in a
 * public artifact. The list lives in `health-cloud.ts` and reaches the route through this
 * registry: loading `routes/index.ts` registers it, `routes/local.ts` does not import it.
 * Unregistered falls back to MAIL rather than failing: `schemaTier` is checked first, so no
 * configuration silently narrows a real deployment's probe, and refusing would take `/health`
 * down for the local engine.
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
  /**
   * Trigger FUNCTIONS probed by BODY — the shape a migration takes when `CREATE OR REPLACE
   * FUNCTION` is its ENTIRE content, which every name-keyed catalog and the constraint-definition
   * probe are both blind to. Cloud `0014` is why this field exists; cloud `0013` named the gap.
   */
  functionDefinitions: ReadonlyArray<FunctionDefinitionMarker>;
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
