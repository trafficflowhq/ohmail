/**
 * THE STORAGE CARD atop the Ohbox, decided on the server so every surface shows the same one, and its
 * dismissal, kept per account (`account_storage_prefs`). Pure: the request reads the facts and the
 * stored dismissal and calls this.
 *
 *  · `full` at the cap, or while the cap is what empties text now;
 *  · `drop` when the plan's own lower limit (the trial's, or a held drop's) is below what is stored;
 *  · `near` from {@link STORAGE_CARD_NEAR_RATIO} of the cap.
 *
 * A dismissed `near` stays hidden until the level changes or the cap does. A dismissed `full` stays
 * hidden {@link STORAGE_CARD_FULL_SNOOZE_MS}, and comes back sooner once more letters are emptied than
 * when it was dismissed, or the cap changes. A dismissed `drop` stays hidden until its date or the
 * plan's limit changes.
 */

export type StorageCardLevel = "near" | "full" | "drop";

export const STORAGE_CARD_LEVELS: readonly StorageCardLevel[] = ["near", "full", "drop"];

/** The share of the cap from which the card says storage is nearly full. */
export const STORAGE_CARD_NEAR_RATIO = 0.8;

/** How long a dismissed `full` card stays away while nothing more is emptied. */
export const STORAGE_CARD_FULL_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

export interface StorageCardFacts {
  usedBytes: number;
  capBytes: number;
  /** The plan's own limit where it is below the cap (the trial's floor or a held drop), else null. */
  planBytes: number | null;
  /** When the plan's own limit applies; null inside an unpaid trial (no date yet). */
  dropsAt: string | null;
  emptiedForSpace: number;
  emptyingNow: boolean;
}

/** What a dismissal records: the level and the facts it was dismissed at. */
export interface StorageCardDismissal {
  level: StorageCardLevel;
  /** The cap; for `drop`, the plan's own limit. */
  capBytes: number;
  emptied: number;
  dropsAt: Date | null;
  at: Date;
}

export function isStorageCardLevel(v: unknown): v is StorageCardLevel {
  return (STORAGE_CARD_LEVELS as readonly unknown[]).includes(v);
}

/** The level the facts call for, before any dismissal. */
export function storageCardLevelOf(f: StorageCardFacts): StorageCardLevel | null {
  if (f.usedBytes >= f.capBytes || f.emptyingNow) return "full";
  if (f.planBytes !== null && f.usedBytes > f.planBytes) return "drop";
  if (f.usedBytes >= f.capBytes * STORAGE_CARD_NEAR_RATIO) return "near";
  return null;
}

const instant = (iso: string | null): number | null => {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/** The dismissal a press of Dismiss records against these facts. */
export function storageDismissalOf(level: StorageCardLevel, f: StorageCardFacts, now: Date): StorageCardDismissal {
  const drops = instant(f.dropsAt);
  return {
    level,
    capBytes: level === "drop" && f.planBytes !== null ? f.planBytes : f.capBytes,
    emptied: f.emptiedForSpace,
    dropsAt: drops === null ? null : new Date(drops),
    at: now,
  };
}

/** Whether a stored dismissal still hides the card the facts call for. */
export function storageCardHidden(
  level: StorageCardLevel, f: StorageCardFacts, d: StorageCardDismissal | null, now: Date,
): boolean {
  if (d === null || d.level !== level) return false;
  switch (level) {
    case "near":
      return d.capBytes === f.capBytes;
    case "full":
      return d.capBytes === f.capBytes && f.emptiedForSpace <= d.emptied
        && now.getTime() < d.at.getTime() + STORAGE_CARD_FULL_SNOOZE_MS;
    case "drop":
      return f.planBytes !== null && d.capBytes === f.planBytes
        && (d.dropsAt?.getTime() ?? null) === instant(f.dropsAt);
  }
}

/** The card to draw: the level the facts call for, unless its dismissal still holds. */
export function storageCardOf(
  f: StorageCardFacts, d: StorageCardDismissal | null, now: Date,
): StorageCardLevel | null {
  const level = storageCardLevelOf(f);
  return level === null || storageCardHidden(level, f, d, now) ? null : level;
}
