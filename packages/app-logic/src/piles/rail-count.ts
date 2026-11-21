"use client";

/**
 * A PILE'S RAIL COUNT, OFF THE MAIL GROUND ALONE: how many letters the pile holds, the number its segment in the
 * piles' switch says too. A rail's count is drawn for the frame's life (the rail, the dock, behind More) while the
 * piles' own model stands only with their columns, so it reads the ground's piles (derived once a mirror's stamp for
 * every entry and the seat) and the mail state, never that model. Withheld, as the switch's numbers are, until the
 * mirror has settled and nothing is owed.
 */
import { countWhen } from "@ohmail/client-engine";
import { useMailState } from "../mail-state/mail-state-binding.js";
import { useGroundPiles } from "./live.js";
import { PILE_OF, type PileId } from "./use-piles.js";

/** How many letters the pile holds; null while it may not be stated. */
export function usePileCount(pile: PileId): number | null {
  const n = useGroundPiles()[PILE_OF[pile]].length;
  const { state } = useMailState();
  return countWhen({ settled: state.settled, count: n, pending: state.owed }, n) ?? null;
}
