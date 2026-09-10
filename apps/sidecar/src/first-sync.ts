import type { Diagnostic } from "./log.js";
import type { SyncStamps } from "./sync-stamp.js";

/**
 * ═══ HOW LONG A FIRST SYNC TOOK ════════════════════════════════════════════════════════════
 *
 * Nothing in this engine marked the start or the end of a first import, so the question could
 * not be answered from a log by anybody. `sync_drain` is no substitute: it fires every poll
 * carrying `drained: true` throughout a backfill, because `drained` is per drain call and says
 * nothing about the import.
 *
 * ── THE FINISH IS THE DATABASE'S ANSWER, NOT A FLAG ───────────────────────────────────────
 *
 * `first_sync_finished` fires on {@link SyncStamps.importStamped}, the `RETURNING` of the
 * `IS NULL`-guarded write — so it is once ever, per mailbox, across relaunches. A process-local
 * "have I said this" flag would re-announce on every launch after a restart mid-import.
 *
 * ── THE START IS ONCE PER LAUNCH, AND SO IS THE CLOCK IT ANCHORS ──────────────────────────
 *
 * The import is open on every drain until it finishes, so a line per drain would be four a
 * minute for as long as it lasts. One per mailbox per launch instead, and a relaunch mid-import
 * legitimately says so again: a new launch is a new x-axis. Durations are `performance.now()`
 * deltas — a 38-minute import spans NTP steps and suspends, over which a wall-clock delta can
 * run backwards.
 */

/** What the doors call once per pass, after that pass's stamps are written. */
export interface FirstSyncReporter {
  /**
   * Report a finished pass's stamps for one mailbox.
   *
   * `countMessages` is a thunk because it is a `count(*)` over the mirror: it runs only on the
   * passes that emit, never on a settled mailbox's, which is almost every pass.
   */
  report(mailboxId: string, stamps: SyncStamps, countMessages: () => Promise<number>): Promise<void>;
}

export function createFirstSyncReporter(
  log: Diagnostic,
  opts: { monotonicMs?: () => number } = {},
): FirstSyncReporter {
  const monotonicMs = opts.monotonicMs ?? ((): number => performance.now());
  /** Mailbox → when this launch first saw its import open. Absent ⇒ nothing announced yet. */
  const openSince = new Map<string, number>();
  const bootedAt = monotonicMs();

  return {
    async report(mailboxId, stamps, countMessages): Promise<void> {
      // A settled mailbox — every pass of almost every install — costs one boolean and no read.
      if (!stamps.importWasOpen && !stamps.importStamped) return;
      const announcedAt = openSince.get(mailboxId);
      if (announcedAt !== undefined && !stamps.importStamped) return;
      try {
        const messages = await countMessages();
        if (stamps.importStamped) {
          /* An import that finished inside the first pass this launch saw gets ONE line, not two:
             a `started` here would carry the FINAL count as the floor it began from. */
          openSince.delete(mailboxId);
          log("first_sync_finished", {
            mailboxId,
            messages,
            totalMs: Math.round(monotonicMs() - (announcedAt ?? bootedAt)),
            reason: "the first import of this mailbox finished; totalMs runs from this launch's " +
              "first sight of it, so an import that spanned a relaunch reports only this part",
          });
          return;
        }
        openSince.set(mailboxId, monotonicMs());
        log("first_sync_started", {
          mailboxId,
          messages,
          reason: "this mailbox's first import is not finished and this launch is working on it; " +
            "messages is what the mirror already holds, so a resumed import is not read as a " +
            "cold one. The pass that produced this line is not inside the elapsed time reported " +
            "when it finishes",
        });
      } catch (err) {
        /* An instrument may not end a drain: the stamps are already written and the mail is
           unaffected. Reported rather than swallowed — a missing pair of lines is the silence
           this module exists to end. */
        log("first_sync_report_failed", {
          mailboxId,
          err,
          reason: "the import's progress could not be recorded; the mailbox's own stamps are " +
            "written, so this costs a measurement and nothing else",
        });
      }
    },
  };
}
