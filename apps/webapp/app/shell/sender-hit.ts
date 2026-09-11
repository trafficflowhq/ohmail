/**
 * Whose sender was just clicked — the hit test behind the screening popover. One capture-phase handler on the stage
 * answers this for the whole product (`AppShell`'s `onStageClickCapture`), rather than a per-view handler the next
 * view would not have. It lives apart from the shell because a test that must stand up an engine, a router and a
 * keymap to ask "does clicking an address find the card's message?" is a test nobody writes — the answer is a pure
 * function of one element and its ancestors.
 */

/**
 * Two idioms, because the product has two: a list row renders a `<button>` with `data-id` (avatar and address are
 * both handles); a reading-stream card renders an `<article>` with `data-sid`, address only — the card arm is the
 * repair: screening was reachable from every list and from nowhere in the two views whose entire content is mail from
 * senders you might want to stop hearing from.
 */

export interface SenderHit {
  /** The message whose sender this is. */
  id: string;
  /** What the popover is placed against — the row or the card, never the text inside it. */
  anchor: HTMLElement;
}

/** Every element that means "this is the sender", in both idioms. */
const HANDLES = ".row .av, .row .addr, .scast .addr";
/** The two carriers of a message id, in the order they nest. */
const CARRIERS = ".row[data-id], .scast[data-sid]";

export function senderHitOf(target: Element | null): SenderHit | null {
  if (!target?.closest?.(HANDLES)) return null;
  const anchor = target.closest<HTMLElement>(CARRIERS);
  // `data-id` on a row, `data-sid` on a card. A carrier with neither is a rendering fault, not
  // a click to guess about: answering `null` leaves the ordinary click to do its ordinary job.
  const id = anchor?.dataset.id ?? anchor?.dataset.sid;
  return anchor && id ? { id, anchor } : null;
}
