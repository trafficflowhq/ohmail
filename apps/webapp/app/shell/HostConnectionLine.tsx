/**
 * ═══ THE COMPUTER THIS WINDOW READS THROUGH IS NOT ANSWERING ═══════════════════════════════
 *
 * A desktop paired to another computer of the person's own shows that computer's mail out of a
 * mirror. When the other machine goes to sleep, is unplugged or leaves the network, the mail on
 * screen is still real and still readable — and every write is refused, for as long as it stays
 * away. That is not an error and it is not a sync that will catch up. It is a STANDING FACT about
 * what this window can do, and it lasts until somebody presses something or the other machine
 * comes back.
 *
 * ── WHY THIS IS A SEPARATE COMPONENT FROM `SyncBar` ─────────────────────────────────────────
 *
 * Because a transient and a standing fact have to be told apart AT A GLANCE, and the rail has an
 * existing grammar for the difference:
 *
 *   syncing        `.rail-sync.busy`   tinted box, spinner, travelling track, clears itself
 *   sync blocked   `.rail-sync.warn`   tinted box, ⚠, clears itself
 *   THIS           `.rail-host`        no box, no fill, a static hollow ring, ends only when the
 *                                      other computer answers or the person changes the door
 *
 * Folding it into `SyncBar` would have meant an eighth `speech()` arm wearing the seven others'
 * chrome. Somebody would then read "the other computer is off" in the same clothes as "catching
 * up", conclude it is about to resolve itself, and wait. Which is the one wrong thing to do with
 * it: the machine has to be turned back on, or this install has to be set up on its own.
 *
 * ── AND WHY THE WORDS ARRIVE AS STRINGS ─────────────────────────────────────────────────────
 *
 * This file is compiled into the browser tab as well as into the desktop window, and a browser tab
 * has no paired desktop and never will. The sentences therefore live in the WINDOW's own catalogue
 * namespace (`desktopDoor`) and travel here on the prop, rather than being read from a key that
 * would ship to every phone and every tab as payload nothing there can render. It is the same
 * bargain `mailboxFacts` and `mirrorFreshness` strike for their data.
 *
 * ── TWO SHAPES, ONE SENTENCE ────────────────────────────────────────────────────────────────
 *
 * `variant="rail"` sits in the rail's account-line slot; `variant="shell"` is a full-width line
 * above the topbar for the widths where the rail is a closed drawer. `app.css` shows exactly one
 * of them from the SAME single `min-width: 901px` query the sync line swaps on — see the block
 * around `.rail-sync-slot` for why that has to be one rule and not two.
 */

import type { HostConnection } from "./host-connection";

export function HostConnectionLine({
  connection,
  variant = "rail",
}: {
  connection: HostConnection;
  /** The rail's own slot, or the full-width line for the widths where the rail is a drawer. */
  variant?: "rail" | "shell";
}) {
  const { words } = connection;
  /**
   * THE WHOLE SENTENCE ON THE MARK, and it is not decoration.
   *
   * In the Zero layout's collapsed rail the words are hidden and the mark is all that is left
   * (`zero-layout.css`). Without this the one state that may never disappear would be a dot with
   * nothing behind it. `title` is also what a pointer gets in every other layout, where it costs
   * nothing.
   */
  const whole = `${words.title} ${words.detail}`;

  if (variant === "shell") {
    return (
      <div className="host-strip" role="status" aria-live="polite">
        <span className="rh-mark" aria-hidden="true" title={whole} />
        <b>{words.title}</b>
        <span>{words.detail}</span>
        {words.link ? <a href={words.link.href}>{words.link.label}</a> : null}
      </div>
    );
  }

  return (
    <div className="rail-host" role="status" aria-live="polite">
      <div className="rh-line">
        <span className="rh-mark" aria-hidden="true" title={whole} />
        <b>{words.title}</b>
      </div>
      <span className="rh-detail">
        {words.detail}
        {words.link ? <> <a href={words.link.href}>{words.link.label}</a></> : null}
      </span>
    </div>
  );
}
