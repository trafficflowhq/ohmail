import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "@trafficflow/db/cloud";

/**
 * THE HOSTED DATABASE HANDLES, declared where only a hosted build will see them.
 *
 * `context.ts` declares `DbRegistry` with the one member a local install can offer, and `Db` is
 * the union of whatever members the registry holds. This module adds the two a hosted deployment
 * has — a pooled per-request connection in production, an in-process one in its tests — by
 * augmenting that interface.
 *
 * ── WHY AUGMENTATION AND NOT A WIDER UNION ────────────────────────────────────────────────
 *
 * The combined schema is the hosted half: identity, the credit ledger, the operator surface. A
 * union naming it would have to sit in `context.ts`, which the local build compiles, so the
 * local source would name a module the local build does not contain. Erasure does not help — a
 * type-only import leaves nothing in the emitted JavaScript and leaves the specifier in the
 * source, and the source is what gets read.
 *
 * Augmentation moves the naming to the only program that has the module. The direction of failure
 * is what makes it safe: a build that omits this file does not get a laxer type, it gets a type
 * that does not have the member, and any code assuming a hosted handle stops compiling. There is
 * no configuration under which a local build silently believes it has the hosted schema.
 *
 * ── WHY IT EXPORTS SOMETHING ──────────────────────────────────────────────────────────────
 *
 * A file consisting only of `declare module` is a side-effect import, and a side-effect import is
 * not reliably carried into the declaration files a consumer compiles against. Exporting a name
 * that the package barrel re-exports gives every hosted consumer a reason to include this module
 * in its program, so the augmentation arrives with it.
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
