import type { EngineMutation, RuleEntity as RuleDTO } from "@ohmail/wire";
import type { EntityReader, MutationResult, RoutingOpen } from "@ohmail/client-engine";
import type { ReleasePressInput } from "./routing-undo.js";

/**
 * THE SHELL'S ROUTING WINDOW, for the release presses — the one Move's rule change is held in
 * (`routing-undo.ts`), and the Undo offer every held window raises through the one door.
 */
export interface ScreenerReleaseWindow {
  /** Send a release through the filing dispatcher and keep its receipt for Undo. */
  send: (mutation: EngineMutation) => Promise<MutationResult>;
  hold: (press: ReleasePressInput) => RoutingOpen;
  /** Take back the held press about this sender; `true` only while its window was open. */
  cancel: (address: string) => boolean;
  /** Start the held press's window again from now, when its offer reaches the screen. */
  restart: (address: string) => boolean;
  toastWithUndo: (
    sentence: string,
    inverses: readonly EngineMutation[],
    held?: { cancel?: () => boolean; undone: string },
  ) => void;
  /** The rules a press past the gate plans over (`pressRules`), the routing window's; unset, the local rows. */
  planOver?: { current: ((reader: EntityReader) => readonly RuleDTO[]) | null };
}
