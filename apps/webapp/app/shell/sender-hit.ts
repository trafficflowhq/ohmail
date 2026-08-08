/**
 * WHOSE SENDER WAS JUST CLICKED — the hit test behind the screening popover.
 *
 * One capture-phase handler on the stage answers this for the whole product (`AppShell`'s
 * `onStageClickCapture`), rather than a per-view handler that the next view added would not
 * have. This module is the part of that handler worth asserting: which elements count as "the
 * sender", and which ancestor carries the message id.
 *
 * It lives apart from the shell because the shell is three thousand lines with an engine, a
 * router and a keymap in it, and a test that has to stand all of that up to ask "does clicking
 * an address on a stream card find the card's message?" is a test nobody writes. The answer is
 * a pure function of one element and its ancestors, so that is what it is.
 *
 * TWO IDIOMS, BECAUSE THE PRODUCT HAS TWO. A list row (`MessageRow`) renders a `<button>` with
 * `data-id`, and both the avatar and the address inside it are sender handles. A reading-stream
 * card (`StreamCard`, which is Reads and Receipts) renders an `<article>` with `data-sid`, and
 * only the address is — a card has no avatar to click. The card arm is the repair: screening was
 * reachable from every list and from the reading pane, and from nowhere in the two views whose
 * entire content is mail from senders you might want to stop hearing from. The address sat there
 * in the same grey as a row's, and clicking it selected the card.
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
