/**
 * THE DESKTOP LINK'S DOOR: the app on a computer needs a one-use code from this browser. The ceremony is the shell's
 * (the settle step, the step-up-gated mint at the press and never on load, the commitment carried by every mint, the
 * busy wait, the code removed at the server's zero); the page shows the code and the way to carry it, and nothing else.
 */
import type { StepUpDoor, StepUpProps } from "../step-up/door.js";

/** What every state with a button carries: the press in flight, a busy server's wait, and why the last press stopped. */
export interface LinkDesktopPress {
  readonly busy: boolean;
  /** A busy server is a wait with the button still live: the seconds to the next ask. */
  readonly retryIn: number | null;
  /** The shell's sentence for the last refusal. */
  readonly refusal: string | null;
  /** A factor came back after Cancel and was thrown away: no code was made. */
  readonly discarded: boolean;
  /** The mint was refused with no live session, or again after a verified factor: signing in is the way on. */
  readonly signIn: boolean;
  /** The mint met a closed step-up window: the second factor is asked over the page. */
  readonly factor: boolean;
}

export type LinkDesktopState =
  | { readonly at: "checking" }
  /** This browser holds no full session: sign in, then open the page again from the app. */
  | { readonly at: "signin" }
  | { readonly at: "unchecked" }
  | { readonly at: "refused"; readonly said: string }
  /** No code yet: the press makes one. */
  | ({ readonly at: "start" } & LinkDesktopPress)
  /**
   * A live code, the seconds it has left, and whether the app that opened this page bound it (then, and only then,
   * the code may be handed back to the app directly).
   */
  | ({
      readonly at: "code";
      readonly code: string;
      readonly remaining: number;
      readonly bound: boolean;
    } & LinkDesktopPress);

export interface LinkDesktopDoor {
  readonly state: LinkDesktopState;
  /** Make a code; during a busy wait, ask again now. */
  press(): void;
  /** Hand the bound code back to the app. */
  openApp(): void;
  /** To the sign-in page. */
  signIn(): void;
  readonly stepUp: StepUpDoor;
  readonly factor: StepUpProps;
}
