import type { MutationResult } from "./engine.js";
import type { MutationRejectedError } from "./types.js";

/**
 * WHAT ONE PRESS ANSWERED, AS A SURFACE SAYS IT.
 *
 * Four engine statuses, three things a person can be told, and the mapping is HERE so that no
 * surface writes its own. `applied` happened; `refused` did not and says why; `queued` is the
 * one this module exists for — the press stands and the act has not occurred, which read as a
 * completion on every surface that folded the status to a boolean.
 *
 * The two waits stay apart inside `queued` (engine.ts's own rule): `retry` is this client's
 * outbox and the next drive may land it; `organizer` is the SERVER's record for the install that
 * organizes the mailbox, which nothing here advances. They differ in what a reader can do about
 * them, so they differ in the sentence.
 */
export type PressVerdict =
  | { kind: "applied" }
  | { kind: "queued"; wait: "retry" | "organizer"; holder: string | null }
  | { kind: "refused"; refusal: MutationRejectedError | undefined };

/**
 * A press that never reached a verdict — `mutate` resolves for every outcome it models, so a
 * throw is this client failing. Still a press that did nothing, and still owed a sentence.
 */
export const PRESS_THREW: PressVerdict = { kind: "refused", refusal: undefined };

/**
 * THE ONE READING OF A MUTATION RESULT. The `never` binding is the gate, evaluated by `tsc`: a
 * fifth `MutationStatus` cannot be added without this function being made to answer for it, and
 * because every completion sentence on both surfaces comes through here, that question is asked
 * once instead of at thirty call sites.
 */
export function pressVerdict(res: MutationResult): PressVerdict {
  switch (res.status) {
    case "confirmed":
      return { kind: "applied" };
    case "queued":
      return { kind: "queued", wait: "retry", holder: null };
    case "awaiting_organizer":
      return { kind: "queued", wait: "organizer", holder: res.queuedWith?.name ?? null };
    case "rolled_back":
      return { kind: "refused", refusal: res.error };
    default: {
      /* The belt for a build that got past the type error: the most conservative of the three
         answers, never a fourth nobody can reach. */
      const unhandled: never = res.status;
      void unhandled;
      return PRESS_THREW;
    }
  }
}

/** What a SET of presses answered — three counts that sum to the number dispatched. */
export interface PressTally {
  applied: number;
  queued: number;
  refused: number;
  /** The first refusal's own error, for the sentence a wholly refused set says. */
  firstRefusal: MutationRejectedError | undefined;
  /** The first named holder among the queued, where the server named one. */
  holder: string | null;
}

/**
 * THE SAME RULE OVER A SET, AND THE PARTIAL IS THE POINT: a set of seven where three applied,
 * two are waiting and two were refused has three separate facts, and a count of what applied
 * alone leaves four messages unaccounted for on screen.
 */
export function tallyVerdicts(verdicts: readonly PressVerdict[]): PressTally {
  const tally: PressTally = { applied: 0, queued: 0, refused: 0, firstRefusal: undefined, holder: null };
  let sawRefusal = false;
  for (const v of verdicts) {
    if (v.kind === "applied") tally.applied += 1;
    else if (v.kind === "queued") {
      tally.queued += 1;
      if (tally.holder === null) tally.holder = v.holder;
    } else {
      tally.refused += 1;
      if (!sawRefusal) { tally.firstRefusal = v.refusal; sawRefusal = true; }
    }
  }
  return tally;
}
