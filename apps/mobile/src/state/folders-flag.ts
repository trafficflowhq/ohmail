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
  /**
   * READS ARE ORDERED BY ISSUE, AND A NEWER *VALID* ANSWER SUPERSEDES (codex rounds 2 and 3):
   * two refreshes can overlap — the session's boot GET still in the air when a drain-completed
   * refresh fires — and both capture the same epoch, so an older response arriving LAST would
   * overwrite the fresher answer. Each read takes a sequence number and applies only while no
   * newer read has APPLIED — issuance alone supersedes nothing, because a newer read that
   * FAILS (`null` — any transport or non-200 outcome) is not an answer, and letting it
   * invalidate the older request discarded the only valid response the session had: a boot
   * GET answering "on" was thrown away because a post-drain GET timed out, and the folders
   * stayed off until another drain.
   */
  let readSeq = 0;
  let appliedSeq = 0;
  /**
   * WRITES SERIALIZE, AND READS RUN ONLY WHILE NO WRITE IS UNSETTLED (codex rounds 4–7, one
   * mechanism). A read that runs while any write is on the wire is AMBIGUOUS — it can observe
   * the pre-write value (round 4: resolving late, it undid the confirmed write) or a value
   * some other client committed after ours (round 5: discarding it left the phone stale) —
   * and no client-side stamp can tell those apart, so reads wait until the write queue is
   * empty. Writes queue behind each other for the same reason (rounds 6–7): with overlap
   * allowed, every per-case guard left another corner — an older write clearing a newer one's
   * barrier, a superseded echo, a survivor discarded when its successor failed. Serialized,
   * settle order IS issue order: each write's confirmed echo applies and drains as it lands,
   * a rejected write changes nothing and re-asks, and there is no overlap left to arbitrate.
   * Waiting is ordering, not blocking — every request settles, and the UI's pending flag
   * keeps a second toggle from even being asked for while one is on the wire.
   */
  let unsettled = 0;
  let tail: Promise<void> = Promise.resolve();
  const refresh = async (): Promise<void> => {
    while (unsettled > 0) await tail;
    const at = epoch;
    const mine = ++readSeq;
    const ans = await deps.read();
    if (ans !== null && epoch === at && mine > appliedSeq) {
      appliedSeq = mine;
      deps.apply(ans.on);
    }
  };
  return {
    refresh,
    async set(on: boolean): Promise<boolean> {
      // Reads already in the air captured the PRE-bump epoch and are out: a read must not
      // overwrite the user's act while the act is still possible. Reads asked for from here
      // on run only once the write queue is empty.
      epoch += 1;
      const queued = unsettled > 0;
      unsettled += 1;
      const prev = tail;
      // The PATCH waits for every earlier write to settle — dispatch order is commit order,
      // so the last set() pressed is the last value the server holds. With an empty queue it
      // dispatches synchronously: the ordinary single toggle pays no deferral at all.
      const run = queued
        ? (async () => {
            await prev;
            return deps.write(on);
          })()
        : deps.write(on);
      tail = run.then(() => undefined, () => undefined);
      try {
        const ans = await run;
        deps.apply(ans.on);
        deps.drain();
        return true;
      } catch {
        // A REJECTED write changed nothing on the server, but the epoch bump above had
        // invalidated the reads in flight — re-ask (behind any writes still queued), so the
        // authoritative value — the user's previous surviving choice, exactly as the failure
        // sentence claims — comes back on its own.
        void refresh();
        return false;
      } finally {
        unsettled -= 1;
      }
    },
  };
}
