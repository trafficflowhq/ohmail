import { makeOwnedDb, kekRetiredReferences, retiredVersionInUseFault, type RetiredKekReferences } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";

/**
 * THE KEY-RETIREMENT GATE — asked once at boot, and only by a worker whose ring declares versions
 * retired (the declaration is the ring loader's, `packages/core/src/crypto.ts`).
 *
 * Removing a key version is safe only once no stored secret names it; the re-wrap's census says so
 * when the operator removes it, but a worker booting later cannot see that census, and a secret it
 * cannot open is a mailbox that stops syncing, an OAuth refresh that fails, a sign-in code that never
 * verifies. So the supervisor asks the database here, on a short-lived connection of its own, BEFORE
 * its health endpoint answers and before the leader lock: a refused worker answers 503 from its first
 * probe, so the deployment never goes live and the instance it was replacing keeps serving. A
 * database that cannot be reached is not caught here — that is the broken-config boot failure the
 * first lock attempt already raises, and folding it into a retirement verdict would name the wrong
 * fault.
 */
export async function kekRetirementGate(databaseUrl: string, retiredThrough: number): Promise<RetiredKekReferences> {
  const owned = makeOwnedDb(databaseUrl);
  try {
    return await kekRetiredReferences(owned.db as unknown as Tx, retiredThrough);
  } finally {
    await owned.close();
  }
}

/**
 * The refusal, published as `/health`'s `error`. That endpoint is public, so the message says what to
 * put back and how, never how many rows; the counts go to the worker's own log.
 */
export class KekRetiredVersionInUseError extends Error {
  readonly code = "KEK_RETIRED_VERSION_IN_USE";
  readonly retiredThrough: number;
  constructor(refs: RetiredKekReferences) {
    super(retiredVersionInUseFault(refs));
    this.name = "KekRetiredVersionInUseError";
    this.retiredThrough = refs.retiredThrough;
  }
}
