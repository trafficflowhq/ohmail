import type { SubscriptionStatus } from "../../api-client";

/**
 * WHAT TO SAY ABOUT STORAGE — one derivation, `ai-credit-state.ts`'s shape for the same reason:
 * the settings row and any surface that warns must not be able to disagree, and a pure function
 * over `GET /billing/subscription` is the whole of what a test needs.
 *
 * The states are deliberately few. Below ninety percent there is nothing worth saying — the row
 * shows the numbers and stops. `near_cap` exists so the first a person hears of the cap is not
 * the moment it bites; `at_cap` states what is now true: mail keeps arriving and keeps being
 * organized, and new message CONTENT stops being stored on the hosted side. Nothing already
 * stored is touched — a storage state must never read as a threat to existing mail, because it
 * is not one.
 *
 * ── WHY BOTH NUMBERS MUST BE PRESENT ────────────────────────────────────────────────────────
 *
 * `storageUsedBytes` and `entitlements.storageBytesLimit` are optional on the wire (an older
 * server omits them), and absence means "say nothing about storage" — never "0 of 0", which
 * would render every account as at once empty and capped. The same read discipline as
 * `trialCredits`. A cap of 0 also says nothing: it is the zero-entitlement shape, whose
 * `syncEnabled: false` already stops ingest, and a full-red storage row on a suspended account
 * would name the wrong problem.
 */
export type StorageState =
  | { kind: "near_cap"; usedBytes: number; capBytes: number }
  | { kind: "at_cap"; usedBytes: number; capBytes: number }
  | null;

/** The approaching-cap threshold: at or past nine tenths of the cap, say so. */
export const STORAGE_NEAR_CAP_RATIO = 0.9;

export function storageState(status: SubscriptionStatus | null): StorageState {
  if (!status) return null;
  const usedBytes = status.storageUsedBytes;
  const capBytes = status.entitlements.storageBytesLimit;
  if (typeof usedBytes !== "number" || typeof capBytes !== "number" || capBytes <= 0) return null;
  if (usedBytes >= capBytes) return { kind: "at_cap", usedBytes, capBytes };
  if (usedBytes >= capBytes * STORAGE_NEAR_CAP_RATIO) return { kind: "near_cap", usedBytes, capBytes };
  return null;
}

/**
 * Bytes for a sentence, in DECIMAL units — the same convention the plan card enforces
 * (`storageBytes` is 5/15/50 × 10⁹ precisely so "5 GB" is the enforced number, with no binary
 * gap to explain). One decimal under 10 GB, whole numbers above; sub-GB values step down so a
 * fresh account reads "12 MB of 5 GB" rather than "0 GB of 5 GB", which would look broken.
 */
export function formatStorageBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    const gb = bytes / 1_000_000_000;
    return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
  }
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}
