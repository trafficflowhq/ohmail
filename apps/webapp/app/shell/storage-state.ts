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
  /** What adds room: a bigger plan, or (on the largest plan) the storage add-on alone. */
  upgrade: StorageUpgrade;
  /** The server's word: is the current cap what empties text now? */
  emptyingNow: boolean;
  /** Inside the trial's storage floor: the plan's own, lower limit, else `null`. */
  planLimitBytes: number | null;
  /** When the plan's limit applies again (ISO); `null` until a first payment dates it. */
  limitDropsAt: string | null;
}

export type StorageUpgrade = "plan" | "addon";

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
  const plan = count(r.planLimitBytes);
  const planLimitBytes = plan !== null && plan > 0 && plan < limitBytes ? plan : null;
  const drops = planLimitBytes !== null && typeof r.limitDropsAt === "string" && Number.isFinite(Date.parse(r.limitDropsAt))
    ? r.limitDropsAt : null;
  return {
    usedBytes, limitBytes, emptiedForSpace,
    firstEmptiedAt: typeof r.firstEmptiedAt === "string" && r.firstEmptiedAt.length > 0 ? r.firstEmptiedAt : null,
    keptFrom: typeof r.keptFrom === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(r.keptFrom) ? r.keptFrom : null,
    // An older server sends none; never more than the letters emptied.
    withheldOnArrival: Math.min(count(r.withheldOnArrival) ?? 0, emptiedForSpace),
    // An older server names none: a bigger plan, as it said before.
    upgrade: r.upgrade === "addon" ? "addon" : "plan",
    // An older server does not say: only at the cap.
    emptyingNow: typeof r.emptyingNow === "boolean" ? r.emptyingNow : usedBytes >= limitBytes,
    planLimitBytes, limitDropsAt: drops,
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
 * Is the current cap what empties text now? The server says (at the cap, or a trim this week); text
 * emptied under an earlier cap (a bigger plan since, a mailbox erased) is not.
 */
export function storageEmptyingNow(facts: StorageFacts): boolean {
  return facts.emptyingNow;
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
 * What more room would come from: a trial is offered a bigger plan (no add-on while trialing; on the
 * largest plan, the add-on once paid), an active subscription the plan or the add-on (on the largest
 * plan the add-on alone). Past due, grace or anything else: nothing is offered,
 * because the operator refuses an add-on unless the subscription is active.
 */
export type StoragePlan = "trial" | "active";

export function storagePlanOf(lifecycleState: string | null | undefined): StoragePlan | null {
  return lifecycleState === "trialing" ? "trial" : lifecycleState === "active" ? "active" : null;
}

/**
 * How far the storage has come, least first: text emptied under an earlier cap (`past`), near the cap,
 * inside the trial's floor near or past the plan's own limit (`carry`: text is emptied when the floor
 * ends), at the cap or emptying text now (`full`). The notice says the level it is drawn at.
 */
export const STORAGE_LEVELS = ["past", "near", "carry", "full"] as const;
export type StorageLevel = (typeof STORAGE_LEVELS)[number];

export function storageLevelOf(facts: StorageFacts): StorageLevel | null {
  if (facts.usedBytes >= facts.limitBytes || (facts.emptiedForSpace > 0 && facts.emptyingNow)) return "full";
  if (facts.planLimitBytes !== null && facts.usedBytes >= facts.planLimitBytes * STORAGE_NEAR_CAP_RATIO) return "carry";
  if (facts.usedBytes >= facts.limitBytes * STORAGE_NEAR_CAP_RATIO) return "near";
  return facts.emptiedForSpace > 0 ? "past" : null;
}

/**
 * The cap a dismissal is kept under: the cap, or inside the trial's floor the plan's own limit and
 * when it applies, so the notice comes back once a payment dates it and again once it applies.
 */
export function storageNoticeCap(facts: StorageFacts): string {
  return facts.planLimitBytes === null ? String(facts.limitBytes) : `${facts.planLimitBytes}-${facts.limitDropsAt ?? "unpaid"}`;
}

/** The device's dismissal of the storage notice, per account, level and cap. */
export function storageNoticeKey(owner: string | null, level: StorageLevel, cap: number | string): string {
  return `ohmail.storage.${owner ?? "local"}.notice.${level}.${cap}`;
}

/**
 * The earlier release's one dismissal per account, of the notice it drew for emptied text alone: read
 * as put away at `past` under any cap (what that notice said holds for every cap), so only a worse
 * level brings it back.
 */
export function storageNoticeKeyBefore(owner: string | null): string {
  return `ohmail.storage.${owner ?? "local"}.emptiedNotice`;
}

/**
 * Does the notice offer more room (the offer sentence and the Manage subscription press)? Only near
 * the cap or the trial's plan limit, or past either: below both, whatever the level, it offers nothing.
 */
export function storageNoticeOffers(facts: StorageFacts, level: StorageLevel): boolean {
  if (level === "past") return false;
  const near = (limit: number) => facts.usedBytes >= limit * STORAGE_NEAR_CAP_RATIO;
  return near(facts.limitBytes) || (facts.planLimitBytes !== null && near(facts.planLimitBytes));
}

/**
 * Was a trim recorded (`firstEmptiedAt`)? A count with no date was back-filled: which letters it
 * covers and under which cap is not known, so it is said plainly, never "oldest" or "at the time".
 */
export function storageTrimRecorded(facts: StorageFacts): boolean {
  return facts.firstEmptiedAt !== null;
}

/**
 * The level the notice is due at, or `null`. Put away at a level, it stays away at that level and below
 * under the same cap; a worse level, or nearing a new cap (a bigger plan since), brings it back.
 */
export function storageNoticeDue(
  facts: StorageFacts | null, owner: string | null, putAway: (key: string) => boolean,
): StorageLevel | null {
  if (facts === null) return null;
  const level = storageLevelOf(facts);
  if (level === null) return null;
  const worse = STORAGE_LEVELS.slice(STORAGE_LEVELS.indexOf(level));
  const cap = storageNoticeCap(facts);
  if (level === "past" && putAway(storageNoticeKeyBefore(owner))) return null;
  return worse.some((l) => putAway(storageNoticeKey(owner, l, cap))) ? null : level;
}

/** The sentence that says what keeps more text, as a catalogue key. */
export function storageOfferKey(plan: StoragePlan, upgrade: StorageUpgrade):
  "storageOfferTrial" | "storageOfferTrialTop" | "storageOfferActive" | "storageOfferActiveTop" {
  if (plan === "trial") return upgrade === "addon" ? "storageOfferTrialTop" : "storageOfferTrial";
  return upgrade === "addon" ? "storageOfferActiveTop" : "storageOfferActive";
}

/**
 * "2019-04" as the reader's month name, "April 2019". Mid-month at noon UTC, formatted in UTC, so no
 * zone can move it into a neighbouring month. The month text is kept from, not a mail stamp.
 */
export function storageMonthName(keptFrom: string, locale: string): string {
  const [y, m] = keptFrom.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 15, 12)).toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "UTC" });
}

/** The day the plan's limit applies again, in the reader's language and zone: "November 8, 2026". */
export function storageDayName(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
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
