/**
 * THE RETURN AFTER PAYING'S DOOR. The ceremony is the shell's: one session read, the return confirmed once, and the
 * way on to the app with its wait armed. The page says which of the two it is and offers the one way on.
 */
export type SubscribedState =
  /** A session stands: the return is confirmed and the app opens by itself. */
  | { readonly at: "continuing" }
  /** This browser holds no session: one sentence, and the way to the app. */
  | { readonly at: "back" };

export interface SubscribedDoor {
  readonly state: SubscribedState;
  /** To the app. */
  open(): void;
}
