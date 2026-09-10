import type { SubscriptionStatus } from "../api-client";

/**
 * WHAT TO SAY ABOUT STORAGE — a derivation with NO CLIENT LEFT, kept for one reason.
 *
 * Both panes that rendered a storage row from it have left this tree with the rest of the
 * subscription surface, so nothing here is called by the app any more. It stays because
 * {@link BYTES_PER_STORED_EMAIL_ESTIMATE} is the client-side literal that
 * `test/landing-pricing-matches-plan-card.test.ts` pins against the server's, and the marketing
 * pricing page advertises the count derived from it. Whether the rest is deleted or a storage
 * row returns is not decided here.
 *
 * The states it derives are few by design. Below ninety percent there is nothing worth saying;
 * `near_cap` exists so the first a person hears of a cap is not the moment it bites; `at_cap`
 * says new message CONTENT stops being stored and NOTHING already stored is touched — a storage
 * state must never read as a threat to existing mail. Both numbers must be present: absence
 * means "say nothing", never "0 of 0", which renders an account as at once empty and capped.
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
 *
 * ── THE LOCALE IS A REQUIRED ARGUMENT, WHICH IS THE POINT OF IT ─────────────────────────────
 *
 * This used to interpolate the number raw, so "1.5 GB" reached a German pane — where a decimal
 * point is a thousands separator and the row read as fifteen gigabytes. It sat directly beside
 * an email count the catalogue grouped correctly, so one row carried two conventions.
 *
 * The locale is the language the reader chose in the app, which the caller has from its intl
 * provider and this module cannot know. It is REQUIRED rather than defaulted for the reason the
 * count is formatted by the catalogue: `toLocaleString()` with no argument reads the HOST's
 * locale, which is a property of the computer rather than a choice the reader made — German in
 * the app on a US machine would still say "1.5 GB", and switching the app's language would
 * change nothing. A missing argument is a compile error here; a wrong default would have been
 * silent.
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
 * Bytes → the advertised email count, floored — every step moves the number DOWN.
 *
 * A NUMBER, not a string, and that is the whole of what this module has to say about the count.
 * The GROUPING belongs to the catalogue: both panes' strings take it as `{used, number}` /
 * `{cap, number}`, which formats against the locale the intl provider was built with — the
 * language the reader chose in this app.
 *
 * Formatting it here was tried and was wrong twice over. A hardcoded `toLocaleString("en-US")`
 * put "200,000" into a German pane. Dropping the argument was worse in a subtler way: it reads
 * the HOST's locale, so German-in-app on a US machine still grouped "60,000" and switching the
 * app's language changed nothing — the one thing a reader would expect it to change. The app's
 * locale is a preference, not a property of the computer, and only the catalogue layer knows it.
 */
export function estimatedEmails(bytes: number): number {
  return Math.floor(bytes / BYTES_PER_STORED_EMAIL_ESTIMATE);
}
