/**
 * THE "USE FOLDERS" FLAG'S ONE COORDINATOR — every read of the consent answer is
 * epoch-stamped, and a write invalidates the reads in flight.
 *
 * The measured race this exists for (codex round 1): a session's boot `GET /consent` can
 * resolve AFTER a `PATCH /consent/settings` the user just made, and an unguarded apply reset
 * the switch to the pre-write value for the rest of the session — the server on, the phone
 * off. User-always-wins: {@link set} bumps the epoch before it writes, so any read that
 * started earlier is discarded whatever it answers.
 *
 * Pure and renderer-free (the `live.ts` charter: screens and hooks stay logic-free), so the
 * node suite drives the race with deferred promises instead of a device. The world layer
 * builds ONE machine per session; its `apply`/`drain` close over that session and refuse a
 * superseded one, so a machine outliving its session writes nothing.
 */

export interface FoldersFlagDeps {
  /** `GET /consent` → the flag, or `null` for "could not ask" (kept, never read as off). */
  read(): Promise<{ on: boolean } | null>;
  /** `PATCH /consent/settings` → the server-confirmed value. Rejects on refusal. */
  write(on: boolean): Promise<{ on: boolean }>;
  /** Publish a server-confirmed value to the UI. */
  apply(on: boolean): void;
  /**
   * Ask the connection for an immediate drain. THE FLIP RIDES THE DELTA: the server answers
   * the PATCH by writing this account's folder creates (or deletes) into the change log, and
   * this build polls — without a drain the group says "no folders on your mail server yet"
   * over a server that just listed them, until a pull-to-refresh nobody was told to make.
   */
  drain(): void;
}

export interface FoldersFlag {
  /**
   * An epoch-stamped read: the answer applies only when nothing newer — a write, another
   * cause for invalidation — superseded it while it was in the air. A `null` answer applies
   * nothing: "could not ask" keeps the last known value, it never reads as off.
   */
  refresh(): Promise<void>;
  /**
   * The user's act. Outranks every read in flight (the epoch bumps BEFORE the request),
   * applies the server-confirmed value, and drains so the flip's folder deltas land now.
   * Resolves `false` on refusal — nothing applied, nothing drained.
   */
  set(on: boolean): Promise<boolean>;
}

export function foldersFlag(deps: FoldersFlagDeps): FoldersFlag {
  let epoch = 0;
  return {
    async refresh(): Promise<void> {
      const at = epoch;
      const ans = await deps.read();
      if (ans !== null && epoch === at) deps.apply(ans.on);
    },
    async set(on: boolean): Promise<boolean> {
      epoch += 1;
      try {
        const ans = await deps.write(on);
        deps.apply(ans.on);
        deps.drain();
        return true;
      } catch {
        return false;
      }
    },
  };
}
