import type { SubscriptionStatus } from "../api-client";

/**
 * What to say about storage — a derivation with NO CLIENT LEFT, kept for one reason: both panes that rendered a
 * storage row have left this tree with the subscription surface, and {@link BYTES_PER_STORED_EMAIL_ESTIMATE} is
 * the client-side literal `test/landing-pricing-matches-plan-card.test.ts` pins against the server's — the
 * marketing page advertises the count derived from it. The states are few by design: below ninety percent there
 * is nothing worth saying; `near_cap` exists so the first a person hears of a cap is not the moment it bites;
 * `at_cap` says new message CONTENT stops being stored and nothing already stored is touched — a storage state
 * must never read as a threat to existing mail. Both numbers must be present: absence means "say nothing",
 * never "0 of 0".
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
 * Is there a storage row at all — the presence rule, exported because two panes ask it.
 * {@link storageState} answers "what is worth saying", and below ninety percent that is nothing;
 * a pane keyed on it alone would show storage only to accounts nearly out of it, the wrong way
 * round — the numbers are the row, the sentence is what the last tenth adds. Both panes used to
 * spell the same three type guards at the point of render; two spellings of one rule is the drift
 * this module prevents, and one had grown a redundant `storageState(...) ||` disjunct, which read
 * as though the sentence could appear without the numbers. It cannot: a non-null
 * {@link storageState} implies this.
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
 * Bytes for a sentence, in DECIMAL units — the plan card's convention (`storageBytes` is 2/5/10 × 10⁹ so
 * "2 GB" is the enforced number). One decimal under 10 GB, whole above; sub-GB steps down so a fresh
 * account reads "12 MB of 2 GB", not "0 GB of 2 GB". Bytes, deliberately, though the pricing page
 * advertises an email count: the card sells an estimate, a settings screen reports the real figure. The
 * locale is REQUIRED, which is the point: this used to interpolate the number raw, so "1.5 GB" reached a
 * German pane where a decimal point is a thousands separator and the row read as fifteen gigabytes.
 * `toLocaleString()` with no argument reads the HOST's locale — a property of the computer, not a choice
 * the reader made; a missing argument is a compile error, a wrong default would have been silent.
 */
export function formatStorageBytes(bytes: number, locale: string): string {
  const n = (v: number, decimals: number): string =>
    v.toLocaleString(locale, { minimumFractionDigits: 0, maximumFractionDigits: decimals });
  if (bytes >= 1_000_000_000) {
    const gb = bytes / 1_000_000_000;
    return `${n(gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10, 1)} GB`;
  }
  if (bytes >= 1_000_000) return `${n(Math.round(bytes / 1_000_000), 0)} MB`;
  if (bytes >= 1_000) return `${n(Math.round(bytes / 1_000), 0)} KB`;
  return `${n(bytes, 0)} B`;
}

/**
 * THE ESTIMATE THAT TURNS BYTES INTO AN EMAIL COUNT.
 *
 * A round number, and it rounds AGAINST us: an over-estimate of the average stored message
 * makes the count it produces conservative, so a person is never told they have more room than
 * they do. Restated here rather than imported because the webapp cannot import the server's
 * packages; `test/landing-pricing-matches-plan-card.test.ts` compares the two literals, so they
 * cannot drift silently.
 */
export const BYTES_PER_STORED_EMAIL_ESTIMATE = 25_000;

/**
 * Bytes → the advertised email count, floored — every step moves the number DOWN. A NUMBER, not a string, and that is
 * the whole of what this module has to say about the count. The GROUPING belongs to the catalogue: both panes'
 * strings take it as `{used, number}` / `{cap, number}`, which formats against the locale the intl provider was built
 * with — the language the reader chose in this app. Formatting it here was tried and was wrong twice over. A
 * hardcoded `toLocaleString("en-US")` put "200,000" into a German pane. Dropping the argument was worse in a subtler
 * way: it reads the HOST's locale, so German-in-app on a US machine still grouped "60,000" and switching the app's
 * language changed nothing — the one thing a reader would expect it to change. The app's locale is a preference, not
 * a property of the computer, and only the catalogue layer knows it.
 */
export function estimatedEmails(bytes: number): number {
  return Math.floor(bytes / BYTES_PER_STORED_EMAIL_ESTIMATE);
}
