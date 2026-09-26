import { storageOwner } from "./storage-owner";

/**
 * THE ONE STALENESS DECISION about a `402 subscription_required`. After the service's fresh open
 * verdict, another API instance may hold the old refusal for its verdict cache's life
 * (`ACCESS_TTL_MS`, `packages/db/src/entitlements-client.ts`). Inside that window a 402 raises no
 * wall AND stands no drain loop down — the loop counts it as a transient — so a wall that has just
 * lifted cannot be re-raised, and a loop cannot stand down with no wall left to revive it.
 * Every reader asks {@link refusalIsStale}; every open or refused answer is recorded here.
 */
export const STALE_REFUSAL_MS = 60_000;

let openFor: { owner: string | null; at: number } | null = null;

/** The service answered open for `owner` (the account the request was made for). */
export function markOpenVerdict(owner: string | null, now = Date.now()): void {
  openFor = { owner, at: now };
}

/** The service answered refused, or this client forgot what it heard: no window. */
export function forgetOpenVerdict(): void {
  openFor = null;
}

/** Is a 402 arriving now, for the account this window's storage belongs to, a stale one? */
export function refusalIsStale(now = Date.now()): boolean {
  return openFor !== null && openFor.owner === storageOwner() && now - openFor.at >= 0
    && now - openFor.at < STALE_REFUSAL_MS;
}
