import type { Diagnostic } from "./log.js";
import type { SyncStamps } from "./sync-stamp.js";

/**
 * How long a first sync took — three invariants the code depends on: the FINISH fires on {@link
 * SyncStamps.importStamped} (the `IS NULL`-guarded write's own `RETURNING`), so once ever per
 * mailbox across relaunches — a process flag would re-announce after a restart mid-import; the START
 * is once per mailbox per LAUNCH (the import is open on every drain until it ends, so a line per
 * drain is four a minute); and durations are `performance.now()` deltas, because a 38-minute import
 * spans NTP steps and suspends over which a wall-clock delta can run backwards.
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
      /* `stampSynced` cannot report a stamp on a pass that found the import closed — it returns
         before the second statement — so this is the whole of "nothing to say". */
      if (!stamps.importWasOpen) return;
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

/**
 * WHAT THIS MAILBOX'S FIRST SYNC HAS PRODUCED — the third answer `MailboxConnectionState` carries.
 *
 * `finished` is the import stamp: this mailbox has been read to the end at least once, whether it
 * held a thousand messages or none. `pending` is a first sync still working — nothing has come
 * back yet, or mail is landing. `produced_nothing_readable` is the one nothing reported before: a
 * drain has come back, the mirror holds NOT ONE message for this mailbox, and either the import
 * never finished or messages were seen and written off.
 *
 * IT LIVES HERE AND NOT IN `roster.ts`, WHICH IS WHERE ITS FIELD IS. `roster.ts` imports the IMAP
 * adapter and the worker's lease types, and `cloud-engine-census.test.ts` walks `import type`
 * edges like any other — so a type import from this module would put the organizer inside Cloud
 * mode's graph and the census refuses it by name. The dependency runs the other way: `roster.ts`
 * takes the name from here.
 */
export type FirstSyncState = "pending" | "finished" | "produced_nothing_readable";

/**
 * WHAT ONE MAILBOX'S FIRST SYNC HAS PRODUCED, KEPT AS THREE FACTS AND DERIVED — never stored.
 *
 * The state is not settable: no path can assert "this mailbox is fine", which is the whole defect
 * this closes. A mailbox reported `reachable: true` with `unreachableSince: null` while its first
 * sync had materialised nothing, and every surface rendered that as a quiet mailbox — the failure
 * looking exactly like its own healthy state.
 *
 * The three facts are the engine's own, and none of them is a clock:
 *
 *   · `importClosed` — `initial_import_completed_at`, learned from the stamps the drain itself
 *     writes ({@link SyncStamps}). A settled mailbox reports `importWasOpen: false` on its first
 *     pass, so a relaunch of one costs no read at all.
 *   · `drainEnded` — at least one drain of this mailbox has COME BACK since the door opened,
 *     however it ended. Without it a door one second old would read as unreadable.
 *   · the mirror's own two facts ({@link mirroredFirstSyncFacts}) — asked through a thunk, and
 *     only while the answer can still change, for `report`'s reason above.
 */
export interface FirstSyncTracker {
  /** The derived answer. A snapshot, like every other field the runtime exposes. */
  state(): FirstSyncState;
  /** What a drain's stamps said about the import. Called wherever `stampSynced` is. */
  noteStamps(stamps: SyncStamps): void;
  /**
   * A drain came back — whatever it came back as. `facts` is a thunk for the same reason
   * `report`'s count is: a mailbox whose first sync has settled never runs it.
   */
  noteDrainEnded(facts: () => Promise<{ hasMessage: boolean; wroteOff: boolean }>): Promise<void>;
}

export function createFirstSyncTracker(log: Diagnostic, mailboxId: string): FirstSyncTracker {
  let importClosed = false;
  let drainEnded = false;
  let hasMessage = false;
  let wroteOff = false;
  /* Seeded with the state a fresh door is in, so the ordinary launch announces nothing and a MOVE
     is the only thing that writes a line. */
  let said: FirstSyncState = "pending";

  const state = (): FirstSyncState => {
    if (!drainEnded) return "pending";
    /* Mail is landing. The import may still be running — that is a first sync working, not a
       first sync that produced nothing. */
    if (hasMessage) return importClosed ? "finished" : "pending";
    /* Nothing in the mirror. An import that never finished has not been read to the end, and one
       that DID finish having written every message off read the mailbox and kept none of it —
       both are a person looking at an empty screen over a mailbox that is not empty. */
    if (!importClosed) return "produced_nothing_readable";
    return wroteOff ? "produced_nothing_readable" : "finished";
  };

  /** Say it once per CHANGE. A line per drain would be four a minute on a settled install. */
  const announce = (): void => {
    const now = state();
    if (now === said) return;
    said = now;
    log("mailbox_first_sync_state", {
      mailboxId,
      state: now,
      reason: "what this mailbox's first sync has produced, derived from the import stamp and " +
        "what the mirror holds; produced_nothing_readable means a drain came back and not one " +
        "message could be stored, which every other field reports as healthy",
    });
  };

  return {
    state,
    noteStamps(stamps) {
      if (!stamps.importWasOpen || stamps.importStamped) importClosed = true;
      announce();
    },
    async noteDrainEnded(facts) {
      /* Settled for good: the import closed over mail that is here. Nothing can move it, so
         nothing is read. */
      if (importClosed && hasMessage) { drainEnded = true; announce(); return; }
      try {
        const answered = await facts();
        hasMessage = hasMessage || answered.hasMessage;
        wroteOff = answered.wroteOff;
      } catch (err) {
        /* THE PROBE COULD NOT ANSWER, so nothing is armed and the state stays where it was. A
           store fault is not evidence that a mailbox cannot be read, and arming on it would be
           this module inventing the state it exists to report. */
        log("first_sync_probe_failed", {
          mailboxId,
          err,
          reason: "what the mirror holds for this mailbox could not be read, so its first-sync " +
            "state is left as it stood and the next drain asks again",
        });
        return;
      }
      drainEnded = true;
      announce();
    },
  };
}
