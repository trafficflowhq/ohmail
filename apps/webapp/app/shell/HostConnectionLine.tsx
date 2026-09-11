/**
 * The computer this window reads through is not answering. A desktop paired to another computer shows that computer's
 * mail out of a mirror; when the other machine sleeps or leaves the network, the mail on screen is still real and
 * readable — and every write is refused for as long as it stays away. Not an error and not a sync that will catch up:
 * a STANDING FACT, lasting until the machine comes back or the door changes.
 */

/**
 * Separate from `SyncBar` because a transient and a standing fact must be told apart at a glance, in the rail's
 * existing grammar: syncing and sync-blocked are tinted boxes that clear themselves; THIS is `.rail-host` — no box, a
 * static hollow ring. Folded into `SyncBar` it would wear "catching up"'s clothes, and somebody would wait — the one
 * wrong thing to do with it.
 */

/**
 * The words arrive as strings because this file compiles into the browser tab too, and a tab has no
 * paired desktop: the sentences live in the WINDOW's own catalogue namespace (`desktopDoor`) and
 * travel on the prop, rather than shipping to every phone and tab as payload nothing there renders
 * — the bargain `mailboxFacts` and `mirrorFreshness` strike. Two shapes, one sentence:
 * `variant="rail"` in the rail's account-line slot, `variant="shell"` above the topbar where
 * the rail is a closed drawer; `app.css` shows exactly one, from the SAME single `min-width: 901px`
 * query the sync line swaps on — see `.rail-sync-slot` for why that is one rule and not two.
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
