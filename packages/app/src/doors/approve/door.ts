/**
 * THE APPROVAL'S DOOR: a computer asks to be signed in, and this browser confirms it. The ceremony is the shell's (the
 * settle step, the request read, the step-up-gated confirm, the busy wait, the way back after a sign-in); the page
 * names the computer in the words it gave for itself, where it asked from, and the account the confirm binds.
 */
import type { StepUpDoor, StepUpProps } from "../step-up/door.js";

/** The computer that asks, as the server read it: its own label, its platform, and when and from where it asked. */
export interface ApproveAsked {
  /** The words the computer gave for itself; null where it gave none. Drawn as text, never as markup. */
  readonly label: string | null;
  readonly platform: string | null;
  /** Whole minutes since it asked. */
  readonly minutes: number;
  /** The network class it asked from, never an address; null where the server named none. */
  readonly network: string | null;
  /** The server compared the computer's network with this browser's and found them different. */
  readonly otherNetwork: boolean;
  /** The account the confirm signs it in to, while the page is settled on it. */
  readonly account: string | null;
  /** Seconds left, the server's own count. */
  readonly remaining: number;
}

export type ApproveState =
  /** A self-hosted server approves no computer from a browser. */
  | { readonly at: "closed" }
  /** Opened without a request: the page opens from the app. */
  | { readonly at: "bare" }
  /** Whose browser this is, or the request, is being asked; `retryIn` while a busy server is waited out. */
  | { readonly at: "checking"; readonly retryIn: number | null }
  /** The sign-in could not be checked. */
  | { readonly at: "unchecked" }
  /** The browser cannot act for this account: the shell's sentence. */
  | { readonly at: "refused"; readonly said: string }
  /** The request cannot be confirmed any more: expired, used, declined, not this account's; the shell's sentence. */
  | { readonly at: "gone"; readonly said: string | null; readonly phone?: boolean }
  | {
      readonly at: "ask";
      readonly asked: ApproveAsked;
      readonly busy: boolean;
      /** A busy server is a wait with Confirm still live: the seconds to the next ask. */
      readonly retryIn: number | null;
      /** Why the last press did not confirm, or that a factor came back after Cancel: the shell's sentence. */
      readonly refusal: string | null;
      /** The confirm met a closed step-up window: the second factor is asked over the page. */
      readonly factor: boolean;
    }
  | { readonly at: "done"; readonly phone?: boolean }
  | { readonly at: "denied"; readonly phone?: boolean };

export interface ApproveDoor {
  readonly state: ApproveState;
  confirm(): void;
  deny(): void;
  /** The second factor, as the shell answers it, and what its answers do. */
  readonly stepUp: StepUpDoor;
  readonly factor: StepUpProps;
}
