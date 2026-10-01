/**
 * UNKNOWN IS NOT EMPTY — the one reading every message list renders through, on every surface.
 *
 * `content`: rows exist and render, even mid-replay — real mail beats a silhouette. `skeleton`:
 * zero rows and no drain has ever completed, so the screen shows the shape of what is coming,
 * never "Nothing here". `pending`: zero rows over a mirror this screen cannot speak for — an
 * answer it depends on is in flight, or the account's own facts say mail is still on its way — so
 * the silhouette stands and the list is withheld rather than guessed. `empty`: zero rows and
 * nothing outstanding, so emptiness is a fact and the empty state speaks.
 */

export type ListSurface = "content" | "skeleton" | "empty" | "pending";

export interface ListSurfaceInput {
  /** Has ANY drain ever completed over this mirror? (`LAST_DRAIN_AT_META` is the stamp.) */
  settled: boolean;
  /** The rows this screen is about to render — its own total, not the whole mirror's. */
  count: number;
  /**
   * Is THIS list withheld for want of an answer it depends on — the phone's cutline
   * (`WorldScreener.waitingPending`), the web's "the account holds more than this device has
   * taken in". Absent ⇒ `false`, which is every list nothing is outstanding for.
   */
  pending?: boolean;
}

export function listSurface(input: ListSurfaceInput): ListSurface {
  if (input.count > 0) return "content";
  if (!input.settled) return "skeleton";
  return input.pending === true ? "pending" : "empty";
}

/**
 * The screen's factual meta line, silenced while the surface is a skeleton — and while it is
 * pending, for the same reason one step further on: "0 first-time senders waiting" over a shelf
 * this device withheld is not a small count, it is the wrong one. `undefined` rather than an
 * em-dash or a spinner-word: the silhouette already says "not yet".
 */
export function metaWhen(surface: ListSurface, meta: string): string | undefined {
  return surface === "skeleton" || surface === "pending" ? undefined : meta;
}

/**
 * MAY THIS SCREEN STATE A NUMBER ABOUT THE MAILBOX? A count is a claim about the whole pile, not
 * a description of the rows on screen, so rows arriving do not license one: mid-replay "96
 * unread" over an account holding 822 is a wrong number stated as a fact, which is the half of
 * this defect {@link metaWhen} cannot see (its surface is already `content`). Withheld until the
 * mirror has settled AND nothing is outstanding — no dash, no zero, no substitute.
 */
export function countWhen<T>(input: ListSurfaceInput, meta: T): T | undefined {
  return input.settled && input.pending !== true ? meta : undefined;
}

/**
 * May this screen say "there is nothing here" as a fact? Exactly one surface may, and naming it
 * here is what keeps the question off the call sites: a view comparing `count === 0` itself is
 * the per-view hand discipline this function replaces.
 */
export function saysEmpty(surface: ListSurface): boolean {
  return surface === "empty";
}

/** What the Screener's Waiting list knows about its set — see {@link waitingSurfaceInput}. */
export interface WaitingSurfaceFacts {
  /** Whose set it is: the store's queue, this device's derivation, or a local world's. */
  source: "store" | "device" | "local";
  /** The count the Waiting tab states. */
  storeTotal: number;
  /** Is the store's queue page in the mirror at all? */
  queueAnswered: boolean;
  settled: boolean;
  owed: boolean;
  /** Is the account's own first import still open (the hosted import floor)? */
  storeImportOpen: boolean;
  /** The rows on screen. */
  count: number;
}

/**
 * Why a withheld list is withheld, so its sentence can be true: `importing` while mail is still on
 * its way, `listing` when the store counts senders this device has already filed elsewhere.
 */
export type WaitingWhy = "importing" | "listing" | null;

/**
 * THE WAITING LIST'S OWN READING. The store's queue is exact whatever this device has taken in,
 * so this mirror's import does not withhold it: only the account's own open import does, and a
 * store that counts senders the list cannot show yet is never stated empty. Anything else reads
 * as every other list.
 */
export function waitingSurfaceInput(f: WaitingSurfaceFacts): ListSurfaceInput & { why: WaitingWhy } {
  if (f.source !== "store" || !f.queueAnswered) {
    return { settled: f.settled, count: f.count, pending: f.owed, why: f.owed ? "importing" : null };
  }
  const listing = f.count === 0 && f.storeTotal > 0;
  return {
    settled: true, count: f.count, pending: f.storeImportOpen || listing,
    why: f.storeImportOpen ? "importing" : listing ? "listing" : null,
  };
}

/** What a count of this mirror's own rows knows about its set — see {@link mirrorCountInput}. */
export interface MirrorCountFacts {
  settled: boolean;
  owed: boolean;
  /** Does the door say its copy is still taking in the account (the queue page's `copyBehind`)? */
  copyBehind: boolean;
  /** The rows on screen. */
  count: number;
}

/**
 * A LIST THE MIRROR DERIVES (Screened out, Spam) states the account's number only once the door's
 * copy holds the account. While mail is owed, or while the door says its copy is still taking the
 * account in, the count is withheld with the importing sentence: the strip's import can end before
 * the copy's, and older screened-out mail is not in it yet. A door that never says so reads as before.
 */
export function mirrorCountInput(f: MirrorCountFacts): ListSurfaceInput {
  return { settled: f.settled, count: f.count, pending: f.owed || f.copyBehind };
}
