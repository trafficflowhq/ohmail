/**
 * THE POSTGRES DIALECT, NOT IN THIS BUILD — substituted for `./pg.js` where `packages/db`
 * `dialect/index` imports it.
 *
 * `dialect()` picks by the handle's brand, and the phone's store is branded `sqlite`
 * (`apps/sidecar/src/mobile.ts`), so the Postgres arm is unreachable here and refuses by name.
 * Anything calling `pgDialect()` at module load (`search-setup.ts` does) must stay off the phone's
 * graph, and the phone app's census over the built bundle names it.
 */
import type { Dialect } from "@trafficflow/db/dialect";

export function pgDialect(): Dialect {
  throw new Error(
    "the phone engine carries no Postgres dialect: pgDialect() was called; only a handle branded " +
      "sqlite exists here",
  );
}
