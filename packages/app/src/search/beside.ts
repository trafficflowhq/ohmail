import type { ListVerbs } from "@ohmail/app-logic/place-list";
/**
 * WHAT SEARCH'S LIST NEEDS BESIDE THE MODEL, and is not Search's to work out: how the shell writes a name, an
 * address, a time and a place; what it says of the provider's Junk folder; whether key hints show; the address
 * book for a person-first question; the calendar's events for the same words; where an address leads. The shell
 * that composes Search provides it. Nothing standing above is a mistake, said at once.
 */
import type { EngineMessage } from "@ohmail/wire";
import { createContext, useContext } from "react";
import type { AddressBookEntry } from "@ohmail/client-engine";
import type { None } from "../host/index.js";

export interface SearchWords {
  /** A sender as the row names them: the whole name, else null (the address then leads). */
  name(m: EngineMessage): string | null;
  /** The address as it is printed (the domain in its own script). */
  address(m: EngineMessage): string;
  /** When it arrived, as the row prints it. */
  stamp(m: EngineMessage): string;
  /** Where the letter is presented now (a place's name, History for a letter consent keeps there). */
  place(m: EngineMessage): string;
  /** A stored folder path as the facet names it. */
  placeOfFolder(path: string): string;
}

export interface SearchBeside {
  readonly selection?: { rows: readonly EngineMessage[]; verbs: ListVerbs };
  readonly words: SearchWords;
  /** What the empty answer says of the provider's Junk folder, which no pass searches; `none` says nothing. */
  readonly junk: { readonly named: string } | "unnamed" | None;
  /** This build can open that folder: the pointer to it is said. */
  readonly junkReadable: boolean;
  /** Key hints are shown on this device. */
  readonly keysShown: boolean;
  /** The address book, built when asked (once per mirror version), for a person-first question; `none` offers none. */
  readonly people: (() => readonly AddressBookEntry[]) | None;
  /** The current account's mirrored calendar events for the same words, where Calendar is enabled. */
  readonly events: ((text: string) => { readonly count: number; open(): void } | null) | None;
  readonly go: {
    /** An address's own view: everything from and to that person. */
    address(address: string): void;
  };
}

export const SearchBesideContext = createContext<SearchBeside | null>(null);

export function useSearchBeside(): SearchBeside {
  const beside = useContext(SearchBesideContext);
  if (beside === null)
    throw new Error("Search's list was drawn with nothing beside it (SearchBesideContext)");
  return beside;
}
