/**
 * The "handled in your browser" card, as data: what a window draws in place of Devices, Security or Account when it
 * cannot ask a second factor again. Every verb of those panes is guarded by a fresh factor, so the card offers one
 * thing: the same section in the browser, where the person is already signed in. It draws a {@link WayOutModel}
 * and reaches nothing; its hook opens the browser through a {@link WayOutDoor}.
 *
 * The card names a section, never an address: which page a section opens is the shell's.
 */

/** The sections a window hands on to the browser. */
export type WayOutSection = "devices" | "security" | "account";

/** How a host opens the browser on the section it was filled for. */
export interface WayOutDoor {
  /** `false`: this computer would not start a browser. It never throws. */
  open(): Promise<boolean>;
}

/** What the card draws. */
export interface WayOutModel {
  readonly section: WayOutSection;
  /** The last press could not start a browser: the card says where the page is. */
  readonly noBrowser: boolean;
  open(): void;
}

/** The card's state without its section and its verb. */
export type WayOutState = Pick<WayOutModel, "noBrowser">;

/** The door answered a press: a browser was started, or none could be. */
export interface WayOutEvent {
  readonly kind: "answered";
  readonly opened: boolean;
}

export const WAY_OUT_START: WayOutState = { noBrowser: false };

/** One answer, applied: "no browser" stands from a press that started none until a press starts one. */
export function wayOutStep(state: WayOutState, event: WayOutEvent): WayOutState {
  return state.noBrowser === !event.opened ? state : { noBrowser: !event.opened };
}
