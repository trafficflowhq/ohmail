import { permitsAdoption, type FolderStateRow, type MoveEvidence } from "./ports.js";

export type ReconcileAction =
  | { type: "none" }
  | { type: "move"; to: string }
  | {
      type: "adopt_external";
      newDesired: string;
      /**
       * There is no `attribution` here, and the absence is the decision. It carried
       * `attribution?: "peer"` so a READER observing held mail move into an organized folder
       * could record another install's hand — and it wrote `'peer'` for a person dragging a
       * message from `ohmail/Reads` back into `INBOX`, which `rule-retro` then moved straight
       * back out on the next press. Adopting an EXISTING message is now always `'external'`:
       * nothing on the wire says otherwise. Reinstating the field needs a new per-message fact,
       * not a new inference. The NEW-message seam still records `'peer'`: a never-held message
       * carries no placement of ours to override.
       */
    };

/**
 * Pure desired-vs-observed decision: converged — none; a differing observed WITH an evidenced
 * disappearance — `adopt_external` (the user wins); otherwise — move toward desired. `evidence`
 * is REQUIRED: `adopt_external` is the only action that overwrites the user's `desired_folder`
 * with something we did not choose, and it used to fire on nothing but "reality changed under us"
 * — a stranger can change reality by delivering a second copy. No default, so the adoption branch
 * is unreachable without stated evidence. The other direction is equally a bug: requiring a
 * correlated move alone would make every unpairable user move a no-op — hence TWO adoptable
 * members; `permitsAdoption` is exhaustive.
 */
export function reconcile(
  state: FolderStateRow, observedNow: string, evidence: MoveEvidence,
): ReconcileAction {
  if (observedNow === state.desiredFolder) return { type: "none" };
  if (observedNow !== state.observedFolder && permitsAdoption(evidence)) {
    return { type: "adopt_external", newDesired: observedNow };
  }
  return { type: "move", to: state.desiredFolder };
}
