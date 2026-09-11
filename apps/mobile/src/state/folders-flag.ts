/**
 * The "use folders" flag's one coordinator — every read of the consent answer is
 * epoch-stamped, and a write invalidates the reads in flight. The measured race: a session's
 * boot `GET /consent` can resolve after a `PATCH /consent/settings` the user just made, and
 * an unguarded apply reset the switch to the pre-write value for the rest of the session.
 * User-always-wins: {@link set} bumps the epoch before it writes, so any earlier read is
 * discarded whatever it answers. Pure and renderer-free (the `live.ts` charter), so the node
 * suite drives the race with deferred promises. The world layer builds one machine per
 * session; `apply`/`drain` close over that session, so a machine outliving it writes nothing.
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

/**
 * FRESHEST-SUCCESSFUL-READ-WINS — the read-only companion of {@link foldersFlag}'s seq pair,
 * for an answer NOTHING ON THIS DEVICE EVER WRITES (the signatures map rides the flag's own
 * `GET /consent`; the phone has no signature editor, so there is no user act to outrank and
 * no epoch to keep). Two overlapping reads can settle out of issue order — the session's boot
 * GET still in the air when a drain-completed refresh fires — and an older answer landing
 * LAST must not overwrite the newer one. The wrapper applies an answer only while no newer
 * read has APPLIED, and a `null` (could-not-ask) applies nothing: issuance alone supersedes
 * nothing, exactly the flag machine's round-3 rule.
 */
export function freshestRead<T>(
  apply: (ans: T) => void,
): (ask: () => Promise<T | null>) => Promise<T | null> {
  let seq = 0;
  let applied = 0;
  return async (ask) => {
    const mine = ++seq;
    const ans = await ask();
    if (ans !== null && mine > applied) {
      applied = mine;
      apply(ans);
    }
    return ans;
  };
}

export function foldersFlag(deps: FoldersFlagDeps): FoldersFlag {
  let epoch = 0;
  /**
   * Reads are ordered by issue, and a newer VALID answer supersedes: two refreshes can overlap
   * (the boot GET still in the air when a drain-completed refresh fires) and both capture the
   * same epoch, so an older response arriving last would overwrite the fresher answer. Each
   * read takes a sequence number and applies only while no newer read has APPLIED — issuance
   * alone supersedes nothing, because a newer read that fails (`null`) is not an answer, and
   * letting it invalidate the older request discarded the only valid response the session had
   * (a boot GET answering "on" thrown away because a post-drain GET timed out).
   */
  let readSeq = 0;
  let appliedSeq = 0;
  /**
   * Writes serialize, and reads run only while no write is unsettled. A read overlapping a
   * write is ambiguous — it can observe the pre-write value (resolving late, it undid the
   * confirmed write) or a value another client committed after ours — and no client-side
   * stamp can tell those apart, so reads wait until the write queue is empty. Writes queue
   * behind each other too: with overlap allowed, every per-case guard left another corner.
   * Serialized, settle order IS issue order: each confirmed echo applies and drains as it
   * lands, a rejected write changes nothing and re-asks. Waiting is ordering, not blocking —
   * every request settles, and the UI's pending flag keeps a second toggle from being asked.
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
