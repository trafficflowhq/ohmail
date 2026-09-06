import { permitsAdoption, type FolderStateRow, type MoveEvidence } from "./ports.js";

export type ReconcileAction =
  | { type: "none" }
  | { type: "move"; to: string }
  | {
      type: "adopt_external";
      newDesired: string;
      /**
       * WHOSE placement is being adopted — `'peer'` when a READER observed another install of this
       * account file the message into a folder ohmail organizes; absent for everything else, which
       * is the user's own hand and commits `'external'`.
       *
       * Absent by default on purpose: `reconcile()` below never sets it, so every ORGANIZER path
       * keeps the behaviour it had. Only the reader seam in `pipeline.ts` supplies it. See
       * `pipeline.ts#readerAdoption` for why calling a reader's adoption `'external'` froze the
       * message past the reach of every mover.
       */
      attribution?: "peer";
    };

/**
 * Pure desired-vs-observed decision.
 *
 * `state` is what we last recorded (desired/observed/lastSetBy); `observedNow`
 * is where the message is reported to be right now; `evidence` is what the caller knows about a
 * DISAPPEARANCE (see {@link MoveEvidence}).
 *
 * - observedNow === desired            -> none (converged)
 * - observedNow !== recorded observed,
 *   AND a disappearance is evidenced   -> adopt_external (the user moved it -> the user wins)
 * - otherwise                          -> move toward desired (our intent not yet applied)
 *
 * ── `evidence` IS REQUIRED, AND THAT IS THE POINT ─────────────────────────────────────────────
 *
 * `adopt_external` is the only action that overwrites the user's `desired_folder` with something
 * we did not choose, and before this parameter existed it fired on nothing but "reality changed
 * under us". A stranger can change reality: delivering a second copy of a message we already hold
 * IS an observation in a folder we did not record. So the third argument is not a refinement of an
 * existing decision, it is the missing premise — and it has NO DEFAULT, so `adopt_external` is
 * unreachable without a caller stating its evidence in a diff. A default would select the
 * adoption branch invisibly, which is precisely the failure the ruling forbids by name.
 *
 * ── AND THE OTHER DIRECTION, WHICH IS EQUALLY A BUG ───────────────────────────────────────────
 *
 * Tightening this too far breaks user-always-wins the other way. If adoption required
 * `change.type === "move"` alone, then every real user move the adapter's `correlateMoves` cannot
 * pair — a message with no Message-ID, or a delete and a create landing in different batches —
 * would become a no-op, the user's move would never be adopted, and `reconcileFolders` would move
 * it straight back. Hence TWO adoptable members: a correlated move **or** a verified absence.
 * `permitsAdoption` is exhaustive over the union, so a fourth member cannot be added without
 * deciding which side of the boundary it is on.
 *
 * The `move` fallthrough is unchanged for every caller that has no evidence to offer: with
 * `observedNow === state.observedFolder` (nothing moved) the evidence is never consulted at all,
 * which is why `hey-migration.ts`'s re-route pass keeps producing exactly `none` and `move`.
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
