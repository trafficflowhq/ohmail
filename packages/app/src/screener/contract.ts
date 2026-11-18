/**
 * THE SCREENER'S CONTRACT: its three sections, what a shell hands beside the model, the place an invitation held in
 * the Screener stands in, and the two contexts its panes read. Nothing here draws; it compiles with no pane present,
 * so the calendar's link and the failure states build on it first.
 */
import type { UnsubscribeResult } from "@ohmail/wire";
import { createContext, useContext, useSyncExternalStore, type ComponentType } from "react";
import type { NotOrganizingYet } from "@ohmail/app-logic/mail-state/mail-state";
import type { ScreenerFacts, ScreenerState, ScreenerView } from "@ohmail/app-logic/screener";
import type { None } from "../host/index.js";
import type { HeldParts, ScreenerJunk, ScreenerSuggest } from "./ports.js";

/** The three sections. With a Junk port handed, the third draws the provider's Junk folder instead of Spam. */
export type ScreenerSegment = "waiting" | "screened" | "spam";
export const SCREENER_SEGMENTS: readonly ScreenerSegment[] = ["waiting", "screened", "spam"];

/** The route's own word for the section: the frame's `sub` (`#/screener/screened`). Anything else is Waiting. */
export function segmentOf(sub: string | null): ScreenerSegment {
  return sub === "screened" || sub === "spam" ? sub : "waiting";
}

/** The place an invitation held in the Screener stands in: one letter of the Waiting section. */
export interface HeldInvitationProps {
  readonly messageId: string;
}

/**
 * WHAT A SHELL HANDS BESIDE THE MODEL. Every key is required: `none` is an answer, never a default. Keys arrive with
 * the pane that first reads them.
 */
export interface ScreenerBeside {
  /** The parts a held letter is drawn with, the same object the shell hands the reader; `none` draws its text. */
  readonly letters: HeldParts | None;
  /** The mail server's own Junk, read live; with it the third section is Junk, with `none` it is Spam. */
  readonly junk: ScreenerJunk | None;
  /** The suggestion run; `none` draws no control and spends nothing. */
  readonly suggest: ScreenerSuggest | None;
  /**
   * The one-click unsubscribe of a kept-out sender's letter, sent by the server on the person's press; `none` offers
   * no press. A refusal comes back as a throw carrying its code.
   */
  readonly unsubscribe: ((messageId: string) => Promise<UnsubscribeResult | null>) | None;
  /** A mailbox's name where the account has several (`short` on a narrow face); null where there is nothing to say. */
  readonly mailboxWord: (mailboxId: string, form?: "short") => string | null;
  /** The calendar's part for an invitation held in Waiting; `none` draws nothing in its place. */
  readonly invitation: ComponentType<HeldInvitationProps> | None;
  /** What the mail state knows: whether the queue may be called empty yet, and the mailboxes nothing organizes. */
  readonly facts: ScreenerFacts & { readonly notOrganizingYet: NotOrganizingYet | null };
  /** The frame's one undo door: true where it took something back. */
  readonly undo: () => boolean;
}

/** What a selection is kept for: each section, and the Junk folder's rows (named apart from Spam's senders). */
export type ScreenerPicked = ScreenerSegment | "junk";

/** What stands above both panes for the life of the frame. */
export interface ScreenerAboveValue {
  readonly model: ScreenerState;
  readonly beside: ScreenerBeside;
  /** The sender open in each section, kept while the person walks between them. */
  readonly selected: (segment: ScreenerPicked) => string | null;
  readonly select: (segment: ScreenerPicked, id: string | null) => void;
  /**
   * Where the list stands now (`place/section`), or null once it has left. A change commits every decision still in
   * its undo window at once.
   */
  readonly standing: (where: string | null) => void;
  /** The list's view, written by the list after each draw and read by the reading column. */
  readonly cell: ViewCell;
}

/** One value, written by the list and read by the reading column, with nothing drawn again on the list's side. */
export interface ViewCell {
  read(): ScreenerView | null;
  write(view: ScreenerView | null): void;
  subscribe(listener: () => void): () => void;
}

export function viewCell(): ViewCell {
  let value: ScreenerView | null = null;
  const listeners = new Set<() => void>();
  return {
    read: () => value,
    write(next) {
      if (next === value) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const ScreenerAboveContext = createContext<ScreenerAboveValue | null>(null);

function useAbove(): ScreenerAboveValue {
  const value = useContext(ScreenerAboveContext);
  if (value === null)
    throw new Error("a pane of the Screener was drawn with nothing above it (ScreenerAbove)");
  return value;
}

/** The one model of the frame (never made here: `useScreenerModel` of app-logic, called once at seating). */
export function useScreener(): ScreenerState {
  return useAbove().model;
}

/** What the shell handed beside the model. Throws where no `ScreenerAbove` stands. */
export function useScreenerBeside(): ScreenerBeside {
  return useAbove().beside;
}

/** The list's view as the reading column reads it: null while no list stands. */
export function useListView(): ScreenerView | null {
  const { cell } = useAbove();
  return useSyncExternalStore(cell.subscribe, cell.read, cell.read);
}

/** The selection per section and the list's standing. Throws where no `ScreenerAbove` stands. */
export function useScreenerAbove(): ScreenerAboveValue {
  return useAbove();
}
