/**
 * THE SCREENER'S ONE MODEL PER FRAME, with no default. `useScreenerState` takes six of its inputs as optional, each
 * absent one falling to a branch that is wrong for a live account (the raw mirror as the queue, an unsubscribe
 * assumed armed, a reader taken for the organizer, no Undo). This door names every one: a caller says `null` where it
 * means none, and a missing key does not compile. Called once, where the frame is composed; never inside a pane.
 */
import type { EngineMessage } from "@ohmail/wire";
import type { EntityReader, OhmailEngine } from "@ohmail/client-engine";
import type { ScreenerRole } from "../mail-state/mail-state.js";
import type { OrganizerRefusal } from "../press/organizer-refusal.js";
import type { ScreenerReleaseWindow } from "../press/release-window.js";
import type { UndoToastFn } from "../press/undo-door.js";
import type { DecisionDestination } from "./decision.js";
import {
  useScreenerState,
  type DecisionVerdict,
  type PendingDecision,
  type ScreenerState,
  type ScreenerText,
} from "./screener-state.js";
import type { SuggestionOverlay } from "./suggestion-overlay.js";

export interface ScreenerModelInput {
  readonly engine: OhmailEngine;
  /** The host's scope, as the frame pinned it: whose journal and undo channel these are. */
  readonly scope: string;
  readonly mirrorAccount?: string;
  readonly version: number;
  /** The frame's undo door: a decision's Undo is the offer `z` takes back. */
  readonly toast: UndoToastFn;
  readonly text: ScreenerText;
  /** Suggestions bought this session; null where this host buys none. */
  readonly suggestions: SuggestionOverlay | null;
  /** The mirror as the lists present it; null only where the raw mirror is what they show (the demo). */
  readonly presented: EntityReader | null;
  /** Will a Screen out or Spam press send the one-click unsubscribe: the account's switch, read from its row. */
  readonly autoUnsubscribe: boolean;
  /** What this install may do with a decision, and the refusal a press would meet. */
  readonly role: ScreenerRole & { pressRefusal: OrganizerRefusal | null };
  /** Decisions an earlier session made that the organizer has not carried out. */
  readonly outstanding: readonly PendingDecision[];
  /** The account's own addresses; null where the mirror's own mailbox rows are the list (the demo). */
  readonly ownAddresses: readonly string[] | null;
  /** The pressed rows the lists show at a place, read at the call. */
  readonly shownAt: (subject: readonly EngineMessage[], dest: DecisionDestination) => string[];
  /** How the lists explain a confirmed decision, or null for a fixture with no account presentation. */
  readonly decisionVerdict: DecisionVerdict | null;
  /** Where Allow, Not spam and back to Waiting hold their rule change for the undo window; null offers no Undo. */
  readonly releaseWindow: ScreenerReleaseWindow | null;
}

export function useScreenerModel(input: ScreenerModelInput): ScreenerState {
  return useScreenerState(
    input.engine,
    input.scope,
    input.version,
    input.toast,
    input.text,
    input.suggestions ?? undefined,
    input.presented ?? undefined,
    input.autoUnsubscribe,
    input.role,
    input.outstanding,
    input.ownAddresses ?? undefined,
    input.shownAt,
    input.releaseWindow ?? undefined,
    input.decisionVerdict ?? undefined,
    input.mirrorAccount,
  );
}
