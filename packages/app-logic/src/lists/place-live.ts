/**
 * WHAT A PLACE'S LIVE HOOK TAKES. A place's behaviour lives in this package, which cannot read the frame. So the
 * place's seat (`packages/app/src/<place>/Seat.tsx`) hands its live hook, `use<Place>Live(args: PlaceLiveArgs)`, the
 * frame's side as one record: `usePlaceLiveArgs()` of `@ohmail/app/frame`. Everything else the hook reads itself:
 * the mail ground's readers (`useConsent()`, `usePartition()`, `usePresented()`, the mail state), the engine, and
 * the place's own state.
 *
 * The shapes are the frame's own, said again with the members a hook uses. The frame's record is assigned to this
 * one where it is made (`usePlaceLiveArgs`): the route's place is read as a `PlaceName` and a `PlaceName` is handed
 * to the frame's `go`, so a member or a place's name that drifts on either side does not compile there.
 *
 * What only a file of `packages/app` can read (a node of the document, an answer of the host, the text reader,
 * another feature's reader that lives there) the seat hands as a second record of the place's own, typed in the
 * place's `live.ts`: `use<Place>Live(args, own)`.
 *
 * A live hook MAY NEVER: take a second seam, scope, route or report beside this record's; keep one of its members
 * where it outlives the render (a member is read when it is used: the record is new whenever the address moves); or
 * send a person to a place by a name that is not a `PlaceName`.
 */
import type { ToastFn } from "../press/report.js";
import type { ShellDispatch } from "../press/shell-dispatch.js";

/** The places, by the frame's own names for them: where a person is, and where a hook may send them. */
export type PlaceName =
  | "ohbox"
  | "news"
  | "receipts"
  | "screener"
  | "later"
  | "parked"
  | "resurface"
  | "history"
  | "drafts"
  | "trash"
  | "tags"
  | "folder"
  | "address"
  | "search"
  | "write"
  | "settings";

/** Where the person is, as the address names it. */
export interface PlaceLiveRoute {
  /** The place on screen. */
  readonly place: PlaceName;
  /** The place's own word: a Screener segment, a tag's, folder's or correspondent's id, a Settings pane. */
  readonly sub: string | null;
  /** The letter open in it. */
  readonly open: string | null;
  readonly words: Readonly<Record<string, string>>;
}

/** Where a hook sends a person: the place, and what of it the hook names. What it leaves out is none. */
export interface PlaceLiveTarget {
  readonly place: PlaceName;
  readonly sub?: string | null;
  readonly open?: string | null;
  readonly words?: Readonly<Record<string, string>>;
}

/** The frame's commands a place's behaviour runs. */
export interface PlaceLiveCommands {
  /**
   * To another place, or to this one under another word. `entered`: the letter the target names is opened as
   * entered (a hit a person chose), which the place that lists it takes once from its own record's `entered`.
   */
  readonly go: (to: PlaceLiveTarget, how?: { readonly entered?: true }) => void;
  /** Opens a letter of this place beside or over its list; `null` closes the open one. */
  readonly open: (letter: string | null, how?: "replace", wholeThread?: true) => void;
  /** To a new letter. */
  readonly write: () => void;
}

/** What of the window's layout a place's behaviour asks: how many columns stand, on what device, under what pointer. */
export interface PlaceLivePlan {
  readonly columns: 1 | 2;
  readonly device: "desktop" | "fold" | "phone";
  readonly pointer: "fine" | "coarse";
}

export interface PlaceLiveArgs {
  /** The frame's one press seam: every press of the place leaves through it, and its Undo is the frame's. */
  readonly press: ShellDispatch;
  /**
   * Whose frame this is: the scope every stored choice and journal of the place is kept under. Fixed for the hook's
   * life (another scope mounts the frame, and the place, again), and never one the frame refuses.
   */
  readonly scope: string;
  readonly route: PlaceLiveRoute;
  readonly commands: PlaceLiveCommands;
  readonly plan: PlaceLivePlan;
  /** The frame's one report slot. */
  readonly report: ToastFn;
  /**
   * The letter that was opened INTO this place as entered (another place's `go(to, { entered: true })`), while the
   * address names it; null for every other way in (a link, a reload, Back: previews). The place enters that
   * letter's row and calls `taken` once.
   */
  readonly entered: { readonly letter: string | null; readonly taken: () => void };
}
