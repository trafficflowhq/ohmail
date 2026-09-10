import { UNMETERED_STORAGE_CAP, type Logger, type StorageCap } from "@trafficflow/core/mail";
import { accessOf, type EntitlementsComposition } from "@trafficflow/db";

/**
 * THE ORGANIZER'S STORAGE-CAP RESOLVER — the one composition that turns the entitlements port's
 * answer into the `storageCap` every `runSyncCycle` must be handed.
 *
 * Resolved once per account per TTL, on `screeningFor`'s exact caching discipline (30 s: a plan
 * change takes effect within a cycle or two, without a billing read per mailbox per cycle), and
 * threaded in as a value — the engine never reads billing.
 *
 * ── THE TWO FAIL-OPEN ARMS ARE DIFFERENT DECISIONS, both deliberate ─────────────────────────
 *
 *  · a `null` limit is UNBOUNDED — an unmetered install, or an account whose operator sets no
 *    cap. Mapped to the typed unmetered value and CACHED like any other answer.
 *  · a READ FAULT resolves to unmetered FOR THIS RESOLUTION ONLY and is NOT cached: a transient
 *    blip must never start withholding a paying customer's mail bodies, and must not stick.
 *    The exposure is bounded by the fault's own duration — at worst a few cycles of storage the
 *    cap would have declined, on an account already at its ceiling.
 *
 * What is NOT here is any absent-config arm: `SyncDeps.storageCap` is required, so a
 * composition that forgets this resolver is a compile error, not an unmetered cap.
 */
export interface StorageCapResolver {
  (accountId: string): Promise<StorageCap>;
}

export function makeStorageCapResolver(
  entitlements: EntitlementsComposition,
  log: Pick<Logger, "warn">,
  opts: { ttlMs?: number; now?: () => Date } = {},
): StorageCapResolver {
  const ttlMs = opts.ttlMs ?? 30_000;
  const now = opts.now ?? ((): Date => new Date());
  const cache = new Map<string, { at: number; value: StorageCap }>();
  return async (accountId: string): Promise<StorageCap> => {
    const at = now().getTime();
    const hit = cache.get(accountId);
    if (hit && at - hit.at < ttlMs) return hit.value;
    try {
      const verdict = await accessOf(entitlements, accountId);
      const cap = verdict.ok ? verdict.limits.storageBytes : null;
      const value: StorageCap = cap === null ? UNMETERED_STORAGE_CAP : cap;
      cache.set(accountId, { at, value });
      return value;
    } catch (err) {
      log.warn("storage_cap_read_failed", { accountId, err });
      return UNMETERED_STORAGE_CAP;
    }
  };
}
