/**
 * THE BOOT'S OWN SYNC LINE — the quiet card at the foot of the rail, while the engine comes up.
 *
 * The window used to spend the whole of a launch behind a centred card: a wordmark and one
 * sentence, over an empty canvas, for anything from half a second to the minute a write-ahead-log
 * recovery can take. The app already has a place where it reports work that is not the reader's
 * fault and not the reader's job — the sync line at the foot of the rail (`SyncBar`'s `rail`
 * shape) — so the boot borrows that exact surface: same classes, same spinner, same travelling
 * sliver, drawn at the foot of the rail SILHOUETTE the boot skeleton is already painting. When
 * the engine serves, the real rail replaces the silhouette and the real sync line takes over in
 * the same corner; the wait and the work read as one continuous thing in one place.
 *
 * ── THE SENTENCE IS THE ENGINE'S OWN CLAIM, MAPPED — NEVER INVENTED ─────────────────────────
 *
 * {@link bootSentence} is a closed map over the phases the engine actually announces
 * (`bridge-fetch.ts`'s `bootPhase`, straight off the shell's status). Everything else — no phase
 * yet, an engine too old to narrate, a phase this build does not know — gets the one sentence
 * that is true in every one of those cases. A phase this build has never heard of must not
 * surface as itself: it is an identifier, not prose, and rendering it would be showing the user
 * a wire token.
 *
 * `role="status"` + `aria-live="polite"` for the same reason the sync line carries them: the
 * sentence changes a handful of times per boot and each change is the answer to "what is it
 * doing now". The spinner and the track are `aria-hidden`, as they are in `SyncBar` — the region
 * already says it in words.
 */

import type * as React from "react";

/** One sentence per phase the engine announces. Exported so a test can drive the whole table. */
export function bootSentence(phase: string | null | undefined): string {
  switch (phase) {
    case "creating_store":
      return "Setting up your local mail store…";
    case "opening_store":
      return "Opening your local mail store…";
    case "replaying_wal":
      return "Replaying recent changes…";
    case "migrating":
      return "Updating your local mail store…";
    default:
      // No phase yet, an engine that predates the narration, or a phase this build does not
      // know. The sentence that is true in all three.
      return "Opening your mailbox…";
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
  /**
   * Said instead of the phase map's answer, for the one state that is not an engine phase: the
   * frame before the shell has been asked anything, where even "your mailbox" would be a guess.
   */
  sentence,
}: {
  phase?: string | null;
  sentence?: string;
}) {
  return (
    <div style={AT_RAIL_FOOT} role="status" aria-live="polite">
      {/* The sync line's own classes, on purpose — `rail-sync busy` is the app's one way of
          saying "working, nothing wrong" in this corner, and a second styling of that statement
          would be a second thing to keep honest. */}
      <div className="rail-sync busy">
        <div className="rs-line">
          <span className="mbx-spin" aria-hidden="true" />
          <b>{sentence ?? bootSentence(phase)}</b>
        </div>
        <span className="rs-track" aria-hidden="true">
          <i />
        </span>
      </div>
    </div>
  );
}
