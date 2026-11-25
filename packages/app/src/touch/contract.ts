/**
 * THE TOUCH LAYER'S CONTRACT: what a list hands the layer and what a row gets back. Types only; it compiles with no
 * list present. A gesture belongs to the surface, the act to the view: the layer reads the finger, and every verb it
 * presses is the row's own, handed in here.
 */
import type { ReactNode, RefObject } from "react";
import type { IconName } from "@ohmail/ui/base";
import type { RowSwipe } from "@ohmail/ui/mail";
import type { None } from "../host/index.js";

/** One side of a row: the verb as the row's menu says it, and the very call its menu item makes. */
export interface SideVerb {
  readonly label: string;
  readonly icon: IconName;
  press(): void;
}

/** What each swipe direction lands on. A side left out does not move. */
export interface RowSides {
  readonly right?: SideVerb;
  readonly left?: SideVerb;
}

/** Pull new mail, as the list already has it: the one flight's state and its press. */
export interface ListPull {
  readonly busy: boolean;
  readonly result?: { key: string; mailboxId?: string };
  run(): void;
}

export interface ListTouchProps {
  /** The list's own scroller: the layer listens on it, and a pull is taken only at its top. */
  readonly scroller: RefObject<HTMLElement | null>;
  /** No swipe starts while this holds (a selection stands). Read at the claim. */
  readonly off?: boolean;
  /** The list's pull, or none: then the layer has no pull and no room for one. */
  readonly pull: ListPull | None;
  /** The end of the run below the rows, the glass's inset (the Ohbox's); a list that ends on its own sheet says no. */
  readonly run?: boolean;
  readonly children: ReactNode;
}

/** A row's swipe, for the kit's row: undefined where no finger swipes (a mouse, or no list's layer above). */
export type UseRowSwipe = (id: string, sides: RowSides) => RowSwipe | undefined;
