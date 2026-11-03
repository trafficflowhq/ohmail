/**
 * COUNTED TURNS FOR A LONG WALK. An organize walk on the desktop runs on the engine's own event loop
 * and outside the ingest lane, where nothing else hands the loop back, so the walk does it itself:
 * after a counted amount of work it awaits the host's turn. The counts bound work, not time, so a
 * busy or slow machine changes nothing about where a walk turns. A host that passes no turn (the
 * worker, the API, the phone) never yields.
 */

/** One turn of the host's event loop. */
export type LoopTurn = () => Promise<void>;

/** Rows a walk checks between two turns. */
export const ROWS_PER_TURN = 25;

/** Rows a walk writes between two turns: each is three or four statements. */
export const WRITES_PER_TURN = 8;

/** A counter to await once per unit of work: every `per` calls it awaits `turn` once. */
export function turnsEvery(per: number, turn?: LoopTurn): () => Promise<void> {
  if (turn === undefined) return async () => {};
  let n = 0;
  return async () => {
    if (++n % per === 0) await turn();
  };
}
