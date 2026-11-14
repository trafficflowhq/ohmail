/**
 * THE NATIVE AUTHORIZATION'S DOOR: an app on a computer asks to be signed in to this account. The ceremony is the
 * shell's (the settle step, the request read and its countdown, the step-up-gated confirm, and the app's own address
 * it then opens); the page names the app and the masked address, says what the app may do, and offers the one press.
 */
import type { StepUpDoor, StepUpProps } from "../step-up/door.js";

export type AuthorizeDesktopState =
  /** Whose browser this is, or the request, is being asked. */
  | { readonly at: "checking" }
  /** This browser holds no full session: the request is dead, and signing in is the way on. */
  | { readonly at: "signin" }
  /** The sign-in could not be checked. */
  | { readonly at: "unchecked" }
  /** The browser cannot act for this account: the shell's sentence. */
  | { readonly at: "refused"; readonly said: string }
  /** The request is over: expired, used, or another window's; the shell's sentence where it has one. */
  | { readonly at: "over"; readonly said: string | null }
  | {
      readonly at: "ask";
      /** The app's name as it gave it; the page has words for the names this deployment knows. */
      readonly client: string;
      /** The account, masked by the server. */
      readonly address: string;
      /** Seconds left, the server's own count. */
      readonly remaining: number;
      readonly busy: boolean;
      readonly refusal: string | null;
      /** The confirm met a closed step-up window: the second factor is asked over the page. */
      readonly factor: boolean;
    }
  | { readonly at: "done" };

export interface AuthorizeDesktopDoor {
  readonly state: AuthorizeDesktopState;
  confirm(): void;
  /** To the sign-in page. */
  signIn(): void;
  readonly stepUp: StepUpDoor;
  readonly factor: StepUpProps;
}
