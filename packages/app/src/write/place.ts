/**
 * THE PLACE `write`: the letter being written in the reading column, the Drafts list beside it (`places`'), and
 * the column held: it stands and has the keys with nothing open, and on a phone it stands over the list with no
 * dock. One composer per tab, so the place needs no open letter.
 */
import type { ComponentType } from "react";
import type { PaneProps, PlaceEntry } from "../frame/contract.js";
import type { WriteEntry } from "./ports.js";

export function writePlace(entry: WriteEntry, List: ComponentType<PaneProps>): PlaceEntry {
  return {
    id: "write",
    body: "drafts",
    rail: null,
    panes: { kind: "columns", List, Reading: entry.Letter, holds: "always" },
  };
}
