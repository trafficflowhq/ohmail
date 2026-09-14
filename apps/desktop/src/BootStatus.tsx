/**
 * THE BOOT'S OWN SYNC LINE — the quiet card at the foot of the rail while the engine comes
 * up. The window used to spend the whole launch behind a centred card, half a second to the
 * minute a write-ahead-log recovery takes. The app already reports background work at the
 * sync line (`SyncBar`'s `rail` shape), so the boot borrows that exact surface, drawn at the
 * foot of the rail SILHOUETTE the boot skeleton paints; when the engine serves, the real sync
 * line takes over in the same corner. The sentence is the ENGINE'S OWN CLAIM, mapped —
 * {@link bootSentence} is a closed map over the phases the engine announces
 * (`bridge-fetch.ts`'s `bootPhase`); everything else gets the one sentence true in every
 */

/*
 * case, because an unknown phase is an identifier, not prose. `role="status"` +
 * `aria-live="polite"` as the sync line carries them; the spinner and track are `aria-hidden`.
 */

import * as React from "react";
import { Spinner } from "@ohmail/ui";

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

/**
 * Where the card sits: at the foot of the boot skeleton's rail column, which `app.css` draws at
 * `inset: 16px` with a 224px rail padded `22px 12px 18px 16px`. The numbers below place this box
 * exactly inside that padding — restated rather than shared, the same bargain the skeleton itself
 * strikes with the real deck's geometry: the only property needed is "sits where the rail's own
 * sync line will sit", and inheriting a future rail change would move a surface that only has to
 * be close. Inline because nothing else in either product needs this placement.
 */
const AT_RAIL_FOOT: React.CSSProperties = {
  position: "absolute",
  left: 32,
  bottom: 34,
  width: 196,
  zIndex: 1,
};

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
  const [long, setLong] = React.useState(false);
  React.useEffect(() => {
    setLong(false);
    const t = setTimeout(() => setLong(true), LONG_PHASE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  return (
    <div style={AT_RAIL_FOOT} role="status" aria-live="polite">
      {/* The sync line's own classes, on purpose — `rail-sync busy` is the app's one way of
          saying "working, nothing wrong" in this corner, and a second styling of that statement
          would be a second thing to keep honest. */}
      <div className="rail-sync busy">
        <div className="rs-line">
          <Spinner className="mbx-spin" />
          <b>{sentence ?? bootSentence(phase, { applied, pending })}</b>
        </div>
        {/* THE SECOND LINE, in the sync line's own shape for the volatile half (`SyncBar`'s
            `rs-num`): the store upgrade is the one phase measured in minutes on a large mailbox,
            and a still card for four of them is read as a hang. Only after the wait has proved
            itself — see {@link LONG_PHASE_MS}. */}
        {long && phase === "migrating" ? (
          <span className="rs-num num">{DOOR_COPY.bootMigratingSlow}</span>
        ) : null}
        <span className="rs-track" aria-hidden="true">
          <i />
        </span>
      </div>
    </div>
  );
}
