/**
 * WHAT THE OHBOX'S LIST NEEDS BESIDE THE MODEL, and is not the Ohbox's to work out: how the shell writes a name, an
 * address, a time and a tag; what the mail state says; the Screener's doorbell; the pull. The shell that composes
 * the Ohbox provides it. Nothing standing above is a mistake, said at once (a default `settled` would say "Nothing
 * in your Ohbox" over unread mail).
 */
import type { EngineMessage } from "@ohmail/wire";
import { createContext, useContext, type ReactNode } from "react";
import type { RowAsk } from "@ohmail/app-logic/ohbox";
import type { NotOrganizingYet } from "@ohmail/app-logic/mail-state/mail-state";
import type { None } from "../host/index.js";

export interface OhboxWords {
  /** A sender as the row names them: the whole name, else the address. */
  name(m: EngineMessage): string;
  /** The address after the name, as it is printed (the domain in its own script). */
  address(m: EngineMessage): string | undefined;
  /** When it arrived, as the row prints it, the exact instant for the pointer, and as a screen reader says it. */
  stamp(m: EngineMessage): { when: string; title?: string; spoken?: string };
  /** Our own letter: who it went to, as "Me → Nora" says it; null for a letter somebody else wrote. */
  sentTo(m: EngineMessage): { label: string } | null;
  /** A mailbox's address as it is printed (the domain in its own script). */
  mailbox(address: string): string;
  /** The letter's first tag, whole, or none. */
  tag(m: EngineMessage): { name: string; hue: number } | null;
}

export interface OhboxBeside {
  words: OhboxWords;
  mail: {
    /** How many mailboxes the account has; null until known. Zero draws the way to connect one. */
    mailboxes: number | null;
    /** Mail arrived and the Screener holds it: the empty Ohbox says where it went. */
    screenerCandidate: boolean;
    /** How many letters arrived and were filed elsewhere, for the empty Ohbox's sentence. */
    arrived: number;
  };
  doorbell: { count: number; settled: boolean };
  notOrganizing: NotOrganizingYet | null;
  /** Pull new mail, where this host can; none hides the item. */
  pull: { busy: boolean; result?: { key: string; mailboxId?: string }; run(): void } | None;
  /** Key hints are shown on this device. */
  keysShown: boolean;
  askRow?: (ask: RowAsk) => void;
  canDelete?: (id: string) => boolean;
  /** A press on a row's time turns every time in the list to its other form; left out, a time is no press. */
  flipTime?: () => void;
  /** The letter a search or a link just took the person to: its row is marked while this names it. */
  located?: string | null;
  /** The rows as shape, never words (the design's list before the first mail): drawn where the rows will be while the
   *  list is still owed, and gone the moment it is read. The shell draws it (its own grace, zero text nodes, hidden
   *  from the screen reader); left out, the list draws none. */
  shape?: ReactNode;
  /** What a shell stands over the list's head, on the list's sheet, as it is given (today's offers and cards). */
  over?: ReactNode;
  /** What a shell stands as the scroller's first block (today's away line and storage card): a line that pins itself
   *  sticks under nothing, and the rest scrolls with the rows. */
  first?: ReactNode;
  /** Where the doorbell, the end of the list and the empty Ohbox lead. */
  go: {
    screener(): void;
    history(): void;
    mailboxes(): void;
    /** Where `mailboxes` goes, when it is an address the browser can follow: the empty Ohbox's way on is then a link
     *  there. Left out (a window whose address is its own), it is the press. */
    mailboxesHref?: string;
    /** The first run again, for one mailbox nobody agreed to organize. */
    organize(mailboxId: string): void;
  };
}

/** The host’s decorative placeholder for an Ohbox that has yet to load. */
export const OhboxShapeContext = createContext<ReactNode>(null);

export const OhboxBesideContext = createContext<OhboxBeside | null>(null);

export function useOhboxBeside(): OhboxBeside {
  const beside = useContext(OhboxBesideContext);
  if (beside === null)
    throw new Error("the Ohbox's list was drawn with nothing beside it (OhboxBesideContext)");
  return beside;
}
