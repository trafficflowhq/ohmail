import { useEffect, useState } from "react";
import { DOOR_COPY } from "./door-copy.js";

/**
 * How long a phase has to last before the window says it may take minutes.
 *
 * Late enough that an ordinary launch never sees it (the whole upgrade is 25–43 ms on the machine
 * that reported this, and a first launch's schema build is seconds), early enough that somebody
 * deciding whether the app has hung reads it before they decide.
 */
export const LONG_PHASE_MS = 5_000;

/**
 * One sentence per phase the engine announces. Exported so a test can drive the whole table.
 *
 * `progress` is the schema upgrade's own count, from the engine (`db.ts`'s `MigrationProgress`,
 * carried on the phase frame). It is only spoken where there is something to count: ONE migration
 * says nothing a reader can use, and the sentence without it is the sentence this window has
 * always shown.
 */
export function bootSentence(
  phase: string | null | undefined,
  progress?: { applied?: number | undefined; pending?: number | undefined },
): string {
  switch (phase) {
    case "creating_store":
      return DOOR_COPY.bootCreatingStore;
    case "opening_store":
      return DOOR_COPY.bootOpeningStore;
    case "replaying_wal":
      return DOOR_COPY.bootReplayingWal;
    case "migrating": {
      const { applied, pending } = progress ?? {};
      return typeof applied === "number" && typeof pending === "number" && pending > 1
        ? DOOR_COPY.bootMigratingOf(applied, pending)
        : DOOR_COPY.bootMigrating;
    }
    case "compacting_store":
      // The one phase measured in minutes rather than seconds: a once-per-install rewrite of a
      // body table that had grown mostly dead space (see `reclaimBodyBloat`). The sentence says
      // work is being saved, because it is — every later launch and read is what gets faster.
      return DOOR_COPY.bootCompacting;
    default:
      // No phase yet, an engine that predates the narration, or a phase this build does not
      // know. The sentence that is true in all three — and the same one the local door's submit
      // button says while it opens a mailbox, which is why it is one key and not two.
      return DOOR_COPY.localOpening;
  }
}

export function BootStatus({
  phase,
  applied,
  pending,
  /**
   * Said instead of the phase map's answer, for the one state that is not an engine phase: the
   * frame before the shell has been asked anything, where even "your mailbox" would be a guess.
   */
  sentence,
}: {
  phase?: string | null;
  /** The schema upgrade's count, as the engine announced it. See {@link bootSentence}. */
  applied?: number;
  pending?: number;
  sentence?: string;
}) {
  /* WHETHER THIS PHASE HAS LASTED, and the clock restarts at each phase — the sentence below
     belongs to the wait that is happening, not to the launch. Armed for every phase and spoken
     for one: a five-second `opening_store` is an ordinary cold start with nothing to explain. */
  const [long, setLong] = useState(false);
  useEffect(() => {
    setLong(false);
    const t = setTimeout(() => setLong(true), LONG_PHASE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  return (
    <div className="oh-opening-line boot-foot" role="status" aria-live="polite">
      <b className="oh-opening-say">{sentence ?? bootSentence(phase, { applied, pending })}</b>
      {long && phase === "migrating" ? (
        <small className="oh-opening-note">{DOOR_COPY.bootMigratingSlow}</small>
      ) : null}
    </div>
  );
}
