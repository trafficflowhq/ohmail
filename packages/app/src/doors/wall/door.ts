/**
 * THE WALL'S DOOR: what an account the service has refused sees in place of its mail, and the page an account erased
 * elsewhere ends on. The ceremony is the shell's (the facts the gate's 402 carried, the way back minted at the press,
 * the settings export, the sign-out, the lift when the service opens the account again); the page says what happened
 * and when, that the mailbox is untouched, and when what ohmail keeps is erased, and offers every way out. It holds no
 * address and no mail: every press is the door's.
 */

/** The headline: why, and since when where the service said so. The date is the shell's, as a reader says it. */
export type WallHeadline =
  | { readonly key: "title" | "suspendedTitle" | "neverStartedTitle" }
  | { readonly key: "trialEnded" | "canceled" | "unpaid"; readonly date: string };

/** What the wall says under the headline. */
export type WallStanding =
  /** A server that predates the wall says nothing about when or why: what is kept, and no more. */
  | { readonly kind: "kept" }
  /** An account that never started: the trial is the page, nothing else is said. */
  | { readonly kind: "fresh" }
  /** Organizing stopped, the mailbox is untouched, and when what ohmail keeps is erased. */
  | {
      readonly kind: "stopped";
      readonly erasure:
        | { readonly kind: "dated"; readonly date: string }
        /** An operator holds the account: nothing is erased while that stands. */
        | { readonly kind: "held" }
        | { readonly kind: "unknown" }
        /** Nothing true to say. */
        | { readonly kind: "none" };
    };

/** The way back, where the service runs an account page: its label, the line under it, and the press in flight. */
export interface WallWayBack {
  readonly label: "subscribe" | "startTrial" | "openAccount" | "manage";
  readonly hint: "subscribeHint" | "startTrialHint" | null;
  readonly minting: boolean;
  /** Why the last press did not leave. */
  readonly refusal: "mintFailed" | "mintUnverified" | null;
}

export type WallState =
  /** The account was erased from another browser; `blocked` while another tab still holds this browser's copy. */
  | { readonly at: "erased"; readonly blocked: boolean }
  | {
      readonly at: "refused";
      readonly headline: WallHeadline;
      readonly standing: WallStanding;
      /** The service is asked again (only Sign out is offered meanwhile); a payment not confirmed yet. */
      readonly check: "idle" | "checking" | "pending";
      readonly wayBack: WallWayBack | null;
      /** The settings file, where this server serves one. */
      readonly moveOut: { readonly exporting: boolean; readonly failed: boolean } | null;
      /** What deleting now does, in the sentence that fits what the wall said above. */
      readonly deleteHint: "deleteHint" | "deleteHintUndated" | "deleteHintNeverStarted";
      readonly signingOut: boolean;
      /** Why the last sign-out did not finish: the shell's sentence. */
      readonly signOutSaid: string | null;
    };

export interface WallDoor {
  readonly state: WallState;
  /** The way back: the account page, minted now. */
  wayBack(): void;
  checkAgain(): void;
  /** The settings file, downloaded. */
  moveOut(): void;
  /** The self-host guide, beside this page. */
  guide(): void;
  /** To the page that deletes the account. */
  deleteNow(): void;
  signOut(): void;
  changePassword(): void;
  /** After an erasure elsewhere: to the start page. */
  home(): void;
}
