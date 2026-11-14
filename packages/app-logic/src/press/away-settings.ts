import {
  AWAY_ANSWERABLE_PILES,
  AWAY_PILE_VIEW,
  AWAY_PILES_DEFAULT,
  awayEffectivePiles,
  type AwayPile,
} from "@trafficflow/core/away-scope";

export const awayRules = {
  defaults: AWAY_PILES_DEFAULT,
  effective: (piles: readonly string[], audience: Parameters<typeof awayEffectivePiles>[1]) =>
    awayEffectivePiles(piles as readonly AwayPile[], audience),
};
export const awayPiles = AWAY_ANSWERABLE_PILES.map((pile) => ({ pile, word: AWAY_PILE_VIEW[pile] }));
