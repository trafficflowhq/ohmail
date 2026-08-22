import type { SubscriptionStatus } from "../api-client";

/**
 * WHAT TO SAY ABOUT STORAGE — one derivation, `ai-credit-state.ts`'s shape for the same reason:
 * the settings row and any surface that warns must not be able to disagree, and a pure function
 * over `GET /billing/subscription` is the whole of what a test needs.
 *
 * ── WHY IT LIVES IN THE SHARED SHELL AND NOT BESIDE THE PANE THAT FIRST READ IT ─────────────
 *
 * TWO clients render a storage row over the same account row: the browser tab's billing pane
 * (`(product)/mailbox/BillingSection.tsx`) and the desktop app's subscription pane
 * (`apps/desktop/src/DesktopBilling.tsx`), which relays the same `GET /billing/subscription`
 * through its shell bridge. `shell/` is the directory both of them compile — imports run
 * `(product)` → `shell`, never back — so this is the only place a definition can sit without
 * one client either importing a route group it is not part of or keeping a second copy.
 *
 * A second copy is the failure mode worth naming: the two panes would then hold two thresholds
 * and two byte formatters, and the first thing to drift would be the number a person compares
 * between a browser tab and the app on their desk. There is one threshold, one formatter and
 * one estimate here, and both panes read them.
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

/** The two numbers a storage row is made of, once both are known to be knowable. */
export type StorageFigures = { usedBytes: number; capBytes: number };

/**
 * IS THERE A STORAGE ROW AT ALL — the presence rule, exported because two panes ask it.
 *
 * {@link storageState} answers "what is worth SAYING", and below ninety percent that is
 * deliberately nothing. A pane that keyed its row on `storageState` alone would therefore show
 * storage only to accounts nearly out of it, which is the wrong way round: the numbers are the
 * row, and the sentence is what the last tenth adds. So presence and sentence are two questions
 * and this is the first of them.
 *
 * Both panes used to spell the same three type guards out at the point of render. Two spellings
 * of one rule is the drift this module exists to prevent — and one of them had already grown a
 * redundant `storageState(...) ||` disjunct in front of it, which read as though the sentence
 * could appear without the numbers. It cannot: a non-null {@link storageState} implies this.
 */
export function storageFigures(status: SubscriptionStatus | null): StorageFigures | null {
  if (!status) return null;
  const usedBytes = status.storageUsedBytes;
  const capBytes = status.entitlements.storageBytesLimit;
  if (typeof usedBytes !== "number" || typeof capBytes !== "number" || capBytes <= 0) return null;
  return { usedBytes, capBytes };
}

export function storageState(status: SubscriptionStatus | null): StorageState {
  const figures = storageFigures(status);
  if (!figures) return null;
  const { usedBytes, capBytes } = figures;
  if (usedBytes >= capBytes) return { kind: "at_cap", usedBytes, capBytes };
  if (usedBytes >= capBytes * STORAGE_NEAR_CAP_RATIO) return { kind: "near_cap", usedBytes, capBytes };
  return null;
}

/**
 * Bytes for a sentence, in DECIMAL units — the same convention the plan card enforces
 * (`storageBytes` is 2/5/10 × 10⁹ precisely so "2 GB" is the enforced number, with no binary
 * gap to explain). One decimal under 10 GB, whole numbers above; sub-GB values step down so a
 * fresh account reads "12 MB of 2 GB" rather than "0 GB of 2 GB", which would look broken.
 *
 * BYTES are what this renders, deliberately, even though the pricing page advertises an EMAIL
 * COUNT (~80 000 on Solo). The card sells an estimate because nobody knows how many emails fit
 * in a gigabyte; a settings screen reports the real figure, because this is the one place the
 * account's own number is knowable and an estimate would be a worse answer than the truth.
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

/**
 * THE ESTIMATE THAT TURNS BYTES INTO AN EMAIL COUNT — the client-side copy of
 * `BYTES_PER_STORED_EMAIL_ESTIMATE` (`packages/db/src/billing.ts`, where the measurement and
 * the round-against-us argument live). Restated because the webapp cannot import
 * `@trafficflow/db`; `test/landing-pricing-matches-plan-card.test.ts` compares the two
 * literals, so they cannot drift silently.
 */
export const BYTES_PER_STORED_EMAIL_ESTIMATE = 25_000;

/** Bytes → the advertised email count, floored — every step moves the number DOWN. */
export function estimatedEmails(bytes: number): number {
  return Math.floor(bytes / BYTES_PER_STORED_EMAIL_ESTIMATE);
}

/**
 * The email count as a row renders it: grouped for the reader in front of it.
 *
 * NO LOCALE ARGUMENT, deliberately — the same convention as the dates in both billing panes
 * (`toLocaleDateString()`, no argument). It replaces a hardcoded `"en-US"`, which grouped
 * "200,000" into a German settings pane whose neighbouring row rendered "22.8.2026": one card,
 * two number conventions, and only one of them the reader's. A grouped count is the only thing
 * this adds over {@link estimatedEmails}, so the arithmetic still has exactly one definition.
 */
export function formatEmailCount(bytes: number): string {
  return estimatedEmails(bytes).toLocaleString();
}
