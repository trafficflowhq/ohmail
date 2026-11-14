/**
 * THE RAIL AS IT IS FED, a part of the frame's contract (`contract.ts` hands these names on): the foot, which is no
 * place's and is fed apart from the places (`useRailFoot`), and a whole rail as a shell that still feeds one hands
 * it. Where no whole rail is fed, the places and their groups are the registrations' alone.
 */
import type { ReactNode } from "react";
import type { IconName } from "@ohmail/ui/base";
import type { PlaceId } from "./contract.js";

export interface RailEntryModel {
  readonly id: string;
  /** The place the entry stands for where its id is not the place's (today's News is fed as `reads`). */
  readonly place?: PlaceId;
  readonly kind: "place" | "sub" | "fold" | "tool";
  readonly label: string;
  readonly icon?: IconName;
  readonly hue?: number;
  readonly count?: string;
  readonly countHot?: boolean;
  readonly keyHint?: string;
  /** The key also stands at rest in the face that prints keys on its controls (Search's `/`). */
  readonly keyStands?: boolean;
  /** Its key in `aria-keyshortcuts`' own spelling ("/", "Shift+F"): said to a screen reader on the entry. */
  readonly shortcut?: string;
  readonly current?: boolean;
  readonly expanded?: boolean;
  readonly depth?: number;
  readonly title?: string;
  readonly onPress: () => void;
}
/**
 * THE RAIL'S FOOT: who is signed in, Pull new mail, and the quiet tools beside the account. It is no place's, so it
 * is fed apart from the places (`useRailFoot`), by what holds the account and the sync: the places and their groups
 * are the registrations' alone.
 */
export interface RailFootModel {
  /** The account's line in the rail's foot; null while nobody is known, and the line is withheld. */
  readonly account: {
    readonly name: string;
    readonly address: string;
    readonly note: string;
    readonly title: string;
    readonly onPress: () => void;
  } | null;
  readonly pull: {
    readonly label: string;
    readonly keyHint?: string;
    readonly busy: boolean;
    readonly onPress: () => void;
  } | null;
  /** The quiet tools at the end of the account's line (the command palette, the light and dark switch), as given. */
  readonly tools?: readonly {
    readonly icon: IconName;
    /** Its name, with its key where it has one: "Command palette · Ctrl K". */
    readonly label: string;
    readonly keyHint?: string;
    readonly onPress?: () => void;
  }[];
}
export interface RailModel extends RailFootModel {
  readonly groups: readonly {
    readonly id: string;
    readonly entries: readonly RailEntryModel[];
    readonly node?: ReactNode;
  }[];
  readonly write: {
    readonly label: string;
    readonly keyHint?: string;
    /** Its key in `aria-keyshortcuts`' own spelling ("c"): said to a screen reader on the way to write. */
    readonly shortcut?: string;
    readonly onPress: () => void;
  } | null;
  /**
   * The classes a shell's own key model finds the rail by while it feeds it (today's views: `rail open`). The rail
   * then stands in a box that carries them and draws nothing.
   */
  readonly mark?: string;
}
