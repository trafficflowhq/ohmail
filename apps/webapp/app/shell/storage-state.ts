/**
 * What to say about stored letter text, from the `storage` block `GET /account/access` answers for a
 * metered account with a cap. When the stored text reaches the plan's cap, ohmail empties the text of
 * the oldest letters (ratified 2026-08-21); the letters stay complete in the person's mailbox on their
 * mail server and stay listed and findable here. Nothing here ever says mail is declined or refused:
 * mail keeps arriving at the cap. Absent or malformed figures say nothing, never "0 of 0".
 * Shared by the browser and the desktop window (which reads the same block over its bridge).
 */

/**
 * The block, narrowed. `keptFrom` is "YYYY-MM": text is kept for letters from that month on (the month
 * after the newest letter the trim emptied), but for the `withheldOnArrival` letters: of
 * `emptiedForSpace`, those stored without their text because they arrived while the storage was full.
 */
export interface StorageFacts {
  usedBytes: number;
  limitBytes: number;
  emptiedForSpace: number;
  firstEmptiedAt: string | null;
  keptFrom: string | null;
  withheldOnArrival: number;
}

const count = (v: unknown): number | null =>
  (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/** Narrow `GET /account/access`'s `storage` block; `null` for an older server or a malformed one. */
export function storageFactsOf(raw: unknown): StorageFacts | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const usedBytes = count(r.usedBytes);
  const limitBytes = count(r.limitBytes);
  const emptiedForSpace = count(r.emptiedForSpace);
  if (usedBytes === null || limitBytes === null || limitBytes <= 0 || emptiedForSpace === null) return null;
  return {
    usedBytes, limitBytes, emptiedForSpace,
    firstEmptiedAt: typeof r.firstEmptiedAt === "string" && r.firstEmptiedAt.length > 0 ? r.firstEmptiedAt : null,
    keptFrom: typeof r.keptFrom === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(r.keptFrom) ? r.keptFrom : null,
    // An older server sends none; never more than the letters emptied.
    withheldOnArrival: Math.min(count(r.withheldOnArrival) ?? 0, emptiedForSpace),
  };
}

/** The letters emptied before the month text is kept from: the oldest, the arrivals left out. */
export function storageOldestEmptied(facts: StorageFacts): number {
  return Math.max(0, facts.emptiedForSpace - facts.withheldOnArrival);
}

/**
 * The sentence that says from which month text is kept, as a catalogue key: with the letters that
 * arrived while the storage was full excepted, or those letters alone when no month is recorded.
 */
export type StorageKeptLine =
  | { key: "storageNoticeKeptFrom"; values: { month: string } }
  | { key: "storageNoticeKeptFromExcept"; values: { month: string; count: number } }
  | { key: "storageNoticeOnArrival"; values: { count: number } };

export function storageKeptLine(facts: StorageFacts, locale: string): StorageKeptLine | null {
  const arrived = facts.withheldOnArrival;
  if (facts.keptFrom !== null) {
    const month = storageMonthName(facts.keptFrom, locale);
    return arrived > 0
      ? { key: "storageNoticeKeptFromExcept", values: { month, count: arrived } }
      : { key: "storageNoticeKeptFrom", values: { month } };
  }
  return arrived > 0 ? { key: "storageNoticeOnArrival", values: { count: arrived } } : null;
}

/** The approaching-cap threshold: at or past nine tenths of the cap, say so. */
export const STORAGE_NEAR_CAP_RATIO = 0.9;

/**
 * The trim band: the trim brings the counter down to nine tenths of the cap, so at or past this share
 * the current cap is what empties text. Below it (a bigger plan since, a mailbox erased) the emptied
 * letters were emptied under an earlier state, and nothing is being emptied now.
 */
export const STORAGE_TRIM_BAND_RATIO = 0.85;

/** Is the current cap what empties text now? */
export function storageEmptyingNow(facts: StorageFacts): boolean {
  return facts.usedBytes >= facts.limitBytes * STORAGE_TRIM_BAND_RATIO;
}

/**
 * The sentence a storage line adds to its numbers. `emptied` outranks the rest: once a letter's text
 * has been emptied, that is the fact; `count` is the oldest letters emptied (the arrivals are said by
 * {@link storageKeptLine}), and `current` says whether the current cap is still emptying text.
 * `full` and `near` say what will happen, never that mail stops.
 */
export type StorageState =
  | { kind: "emptied"; count: number; current: boolean } | { kind: "full" } | { kind: "near" } | null;

export function storageState(facts: StorageFacts | null): StorageState {
  if (facts === null) return null;
  if (facts.emptiedForSpace > 0) return { kind: "emptied", count: storageOldestEmptied(facts), current: storageEmptyingNow(facts) };
  if (facts.usedBytes >= facts.limitBytes) return { kind: "full" };
  if (facts.usedBytes >= facts.limitBytes * STORAGE_NEAR_CAP_RATIO) return { kind: "near" };
  return null;
}

/**
 * What more room would come from: a trial is offered a bigger plan (no add-on while trialing), an
 * active subscription the plan or the add-on. Past due, grace or anything else: nothing is offered,
 * because the operator refuses an add-on unless the subscription is active.
 */
export type StoragePlan = "trial" | "active";

export function storagePlanOf(lifecycleState: string | null | undefined): StoragePlan | null {
  return lifecycleState === "trialing" ? "trial" : lifecycleState === "active" ? "active" : null;
}

/** The device's dismissal of the emptied-text notice, per account: shown once, put away for good. */
export function storageNoticeKey(owner: string | null): string {
  return `ohmail.storage.${owner ?? "local"}.emptiedNotice`;
}

/** The notice is due while letters are emptied for space and this device has not put it away. */
export function storageNoticeDue(facts: StorageFacts | null, dismissed: boolean): facts is StorageFacts {
  return facts !== null && facts.emptiedForSpace > 0 && !dismissed;
}

/**
 * "2019-04" as the reader's month name, "April 2019". Mid-month at noon UTC, formatted in UTC, so no
 * zone can move it into a neighbouring month. The month text is kept from, not a mail stamp.
 */
export function storageMonthName(keptFrom: string, locale: string): string {
  const [y, m] = keptFrom.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 15, 12)).toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "UTC" });
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
