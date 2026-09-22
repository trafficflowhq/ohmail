import type { EngineMessage, OhboxView, ResurfacedThreadRow } from "@ohmail/client-engine";

/**
 * EVERY MESSAGE THE OHBOX CAN SHOW — the list the shell resolves the reading column, the route
 * and the cursor from. It was the engine's three groups; since the Resurfaced fold, a row stands
 * for a whole conversation, and the conversation's unpinned members are in NONE of the three
 * (held out of "Earlier" because their row is at the top, absent from the pin group because
 * they carry no pin). A click on such a row handed the column an id this list did not hold, and
 * the column rested on "Nothing open." over a row plainly on screen (desktop and web, 2026-09-21).
 * The rows' members come first, each row's open target leading — that is the `data-id` the
 * cursor placer looks for — then the three groups, then the server-paged Older tail; one entry
 * per id.
 *
 * THE TAIL IS A SOURCE HERE, NOT A FOURTH GROUP. `Load older` fetches rows from beyond the
 * mirror window and the list renders them; resolving the column from the three groups alone made
 * every one of those rows unselectable and unopenable, and the way to read one was to find it
 * again through Search. It comes LAST and `take` keeps the first entry per id, which is
 * `older-mail.ts`'s own mirror-preference: a fetched item is a pre-edit snapshot, the mirror's
 * row carries this device's triage.
 *
 * ORDER IS NOT TOUCHED. This list is a reach set — what a verb may resolve — and the sections on
 * screen decide what is where. Nothing here sorts.
 */
export function ohboxSurfaceMessages(
  rows: readonly ResurfacedThreadRow[],
  view: Pick<OhboxView, "resurfaced" | "newForYou" | "previouslySeen">,
  /** The rows `Load older` has fetched, if this surface offers it. Required, so a new caller decides. */
  older: readonly EngineMessage[],
): EngineMessage[] {
  const seen = new Set<string>();
  const out: EngineMessage[] = [];
  const take = (m: EngineMessage): void => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    out.push(m);
  };
  for (const row of rows) {
    take(row.openTarget);
    for (const m of row.members) take(m);
  }
  for (const m of view.resurfaced) take(m);
  for (const m of view.newForYou) take(m);
  for (const m of view.previouslySeen) take(m);
  for (const m of older) take(m);
  return out;
}
