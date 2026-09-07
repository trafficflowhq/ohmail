import { permitsAdoption, type FolderStateRow, type MoveEvidence } from "./ports.js";

export type ReconcileAction =
  | { type: "none" }
  | { type: "move"; to: string }
  | {
      type: "adopt_external";
      newDesired: string;
      /* ── THERE IS NO `attribution` HERE, AND THE ABSENCE IS THE DECISION ───────────────────
       *
       * This member carried `attribution?: "peer"` so that a READER observing a message it
       * already holds move into a folder ohmail organizes could record "another install of this
       * account put it there". One producer supplied it (`pipeline.ts`'s reader arm) and one
       * reader consumed it (`commitChange`), and between them they wrote `last_set_by = 'peer'`
       * for a person dragging a message from `ohmail/Reads` back into `INBOX` in their own mail
       * client — `INBOX` is one of the six organized folders, so the folder test could not tell
       * the two apart. `rule-retro` admits `'peer'`, so a rule pressed afterwards moved the
       * message straight back out of the inbox the person had just filed it into.
       *
       * Adopting an EXISTING message is now always the person's hand (`'external'`), because
       * nothing on the wire says otherwise: the adapter reports that a folder changed and no more,
       * the destination cannot answer it (`INBOX` is exactly where a person drags mail), and the
       * lease says another install EXISTS, never that it moved THIS message. Reinstating the field
       * therefore needs a new per-message fact, not a new inference — and until there is one, a
       * field with no producer would leave `commitChange` with a branch nothing can reach, which
       * the next reader would take for a guarantee.
       *
       * The NEW-message seam is untouched and still records `'peer'` (`NewPlan.adoption`): a
       * message this install has never held carries no placement of ours for it to override.
       */
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
