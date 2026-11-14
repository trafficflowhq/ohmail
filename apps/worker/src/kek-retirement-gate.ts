import { makeOwnedDb, kekRetiredReferences, retiredVersionInUseFault, type RetiredKekReferences } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";

/**
 * THE KEY-RETIREMENT GATE — asked once at boot, and only by a worker whose ring declares versions
 * retired (the declaration is the ring loader's, `packages/core/src/crypto.ts`).
 *
 * Removing a key version is safe only once no stored secret names it; the re-wrap's census says so
 * when the operator removes it, but a worker booting later cannot see that census, and a secret it
 * cannot open is a mailbox that stops syncing, an OAuth refresh that fails, a sign-in code that never
 * verifies. So the supervisor asks the database here, on a short-lived connection of its own, before
 * the leader lock and before its health endpoint has answered 200 once: an instance that has not
 * reached the database answers 503, and so does a refused one, so the deployment never goes live and
 * the instance it was replacing keeps serving. A database that cannot be reached is not caught here:
 * the throw is the supervisor's to classify (it waits for a database that is away), and folding it
 * into a retirement verdict would name the wrong fault. `signal` is the supervisor's deadline on the
 * read: aborted, the connection is closed under it and the read fails.
 */
export async function kekRetirementGate(
  databaseUrl: string, retiredThrough: number, signal?: AbortSignal,
): Promise<RetiredKekReferences> {
  const owned = makeOwnedDb(databaseUrl);
  const abandon = (): void => { void owned.close().catch(() => undefined); };
  signal?.addEventListener("abort", abandon, { once: true });
  try {
    return await kekRetiredReferences(owned.db as unknown as Tx, retiredThrough);
  } finally {
    signal?.removeEventListener("abort", abandon);
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
