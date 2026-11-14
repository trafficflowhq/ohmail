/**
 * DRAFTS' MODEL: the scheduled sends first (soonest first), then the drafts, minus the rows a Discard hides. What the
 * list may say while the mirror is owed is the mail facts' (`settled`, `owed`), handed in, never guessed.
 */
import { createContext, useContext, useMemo } from "react";
import type { EngineDraft } from "@ohmail/client-engine";
import type { UndoToastFn } from "../press/undo-door.js";
import { useDiscardWindow, type DiscardWords } from "./discard-window.js";
import type { DiscardRefusal, DraftsDoor } from "./door.js";

export interface DraftsInput {
  readonly drafts: readonly EngineDraft[];
  /** Sends set for later, in any order: the list puts the soonest first. */
  readonly scheduled: readonly EngineDraft[];
  readonly settled: boolean;
  readonly owed: boolean;
  readonly door: DraftsDoor;
  readonly report: UndoToastFn;
  readonly words: DiscardWords;
  /** An instant as a row prints it, in the seat's words (as the Ohbox's rows take theirs). */
  readonly stamp: (iso: string) => string;
  /** When a scheduled send goes, as an appointment is printed: the seat's `scheduleLabel`, never a past row's stamp. */
  readonly appointment: (iso: string) => string;
  /** The hour the held rows are judged against: the seat's clock. */
  readonly now: Date;
}

export interface DraftsModel {
  readonly scheduled: readonly EngineDraft[];
  readonly drafts: readonly EngineDraft[];
  /** The mirror is read and holds nothing: the one time the list may say it is empty. */
  readonly empty: boolean;
  /** The mirror is still owed: the list says it is on its way, never that nothing is there. */
  readonly loading: boolean;
  readonly door: DraftsDoor;
  readonly discard: (id: string) => void;
  readonly refusal: DiscardRefusal | null;
  readonly stamp: (iso: string) => string;
  readonly appointment: (iso: string) => string;
  readonly now: Date;
}

const sendsAt = (d: EngineDraft): number => {
  const at = d.sendAt ? Date.parse(d.sendAt) : Number.NaN;
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
};

export function useDraftsList(input: DraftsInput): DraftsModel {
  const { door } = input;
  const window = useDiscardWindow(door, input.report, input.words);
  const { hidden } = window;
  const scheduled = useMemo(
    () => [...input.scheduled].sort((a, b) => sendsAt(a) - sendsAt(b)),
    [input.scheduled],
  );
  const drafts = useMemo(
    () => (hidden.size === 0 ? input.drafts : input.drafts.filter((d) => !hidden.has(d.id))),
    [input.drafts, hidden],
  );
  const nothing = scheduled.length === 0 && drafts.length === 0;
  return {
    scheduled,
    drafts,
    empty: nothing && input.settled && !input.owed,
    loading: nothing && (!input.settled || input.owed),
    door,
    discard: window.discard,
    refusal: window.refusal,
    stamp: input.stamp,
    appointment: input.appointment,
    now: input.now,
  };
}

export const DraftsModelContext = createContext<DraftsModel | null>(null);

/** Drafts' model. Nothing standing above is a mistake of composition, said at once. */
export function useDraftsModel(): DraftsModel {
  const model = useContext(DraftsModelContext);
  if (model === null) throw new Error("Drafts was drawn with no model above it (DraftsModelContext)");
  return model;
}
