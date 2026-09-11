import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "@trafficflow/db/cloud";

/**
 * The hosted database handles, declared where only a hosted build sees them. `context.ts`
 * declares `DbRegistry` with the one member a local install offers; this module AUGMENTS it with
 * the hosted two. Augmentation, not a wider union: a union naming the combined schema would sit
 * in `context.ts`, which the local build compiles — erasure answers the bundling question and
 * says nothing about the source. The failure direction makes it safe: a build omitting this file
 * gets a type WITHOUT the member, and code assuming a hosted handle stops compiling. It exports a
 * name (re-exported by the barrel) because a bare `declare module` side-effect import is not
 * reliably carried into consumers' declaration files.
 */
declare module "./context.js" {
  interface DbRegistry {
    /** Production: the pooled, per-request connection. */
    pg: PostgresJsDatabase<typeof schema>;
    /** The hosted test harness: the same schema, in process. */
    pglite: PgliteDatabase<typeof schema>;
  }
}

/**
 * The hosted handle, named — the export that carries the augmentation above into a consumer's
 * program. Hosted code may use it directly where it means "the connection this deployment has"
 * rather than "whatever handle a service was given".
 */
export type CloudDb = PostgresJsDatabase<typeof schema> | PgliteDatabase<typeof schema>;
