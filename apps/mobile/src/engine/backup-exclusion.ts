/**
 * IS THE COPIED MAIL OUTSIDE THIS DEVICE'S BACKUP — the seam, and the one place the app's
 * sentence about it comes from.
 *
 * The pairing credential has never ridden a backup (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`). The mail
 * it protects had no equivalent on one of the two platforms, and the About block said so rather
 * than claiming a parity the build did not have. The native half either makes that true and says
 * so or reports that it did not; this module is what it reports THROUGH, and the sentence is
 * derived from the report instead of written by hand per platform.
 */

/**
 * THREE STATES, NOT A BOOLEAN. "Not measured" is not "included": a native half that is absent on
 * an old build, or that threw, has said nothing, and speaking its silence as either answer is how
 * a false claim ships. Each of the three has its own sentence in the deck.
 */
export type BackupExclusion = "excluded" | "included" | "unknown";

/** The native module's surface — one function per act, the same on both platforms. */
export interface BackupExclusionNative {
  /** Make the item at `path` excluded where the platform allows it, and answer the read-back. */
  excludeFromBackup(path: string): Promise<boolean>;
  /** Read whether the item at `path` is excluded. No write. */
  isExcluded(path: string): Promise<boolean>;
}

/** How long the whole measurement may take before it answers "unknown". */
export const BACKUP_EXCLUSION_BUDGET_MS = 2_000;

/**
 * Ask, then READ BACK — and the read-back is the answer. `excludeFromBackup` returning true is
 * the platform saying a call did not fail, which is a different claim from the item carrying the
 * attribute; a refusal from it is not the answer either, so it is swallowed and the independent
 * read below decides. A read that throws leaves the state unknown, never false.
 */
async function ask(native: BackupExclusionNative, path: string): Promise<BackupExclusion> {
  try {
    await native.excludeFromBackup(path);
  } catch {
    /* the set's outcome is never the answer — see above */
  }
  try {
    return (await native.isExcluded(path)) ? "excluded" : "included";
  } catch {
    return "unknown";
  }
}

/**
 * ONE BUDGET, ENTERED AT THE TOP, over BOTH native calls rather than per call. This runs inside
 * the mirror's open: a native half that never settles would otherwise hold every mailbox on this
 * phone behind a claim about backups. Past the budget the answer is "unknown", which is the
 * honest one — nothing was measured — and the About block says so.
 */
export async function measureBackupExclusion(
  native: BackupExclusionNative | null,
  databasePath: string | undefined,
  budgetMs: number = BACKUP_EXCLUSION_BUDGET_MS,
): Promise<BackupExclusion> {
  if (native === null || databasePath === undefined || databasePath === "") return "unknown";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<BackupExclusion>((resolve) => {
    timer = setTimeout(() => resolve("unknown"), budgetMs);
  });
  try {
    return await Promise.race([ask(native, databasePath), expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

let measured: BackupExclusion = "unknown";
const listeners = new Set<() => void>();

/** The snapshot — `useSyncExternalStore`'s second argument. Unknown until something measures. */
export function backupExclusion(): BackupExclusion {
  return measured;
}

/** Subscribe. Returns the unsubscribe, which is `useSyncExternalStore`'s contract. */
export function subscribeBackupExclusion(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Record what was measured. Silent when nothing changed: the mirror is opened once per paired
 * server and the answer is a property of the directory they share, so a second open would
 * otherwise repaint every subscriber for no news.
 */
export function recordBackupExclusion(next: BackupExclusion): void {
  if (next === measured) return;
  measured = next;
  for (const listener of [...listeners]) listener();
}
