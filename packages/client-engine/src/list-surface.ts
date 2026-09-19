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
