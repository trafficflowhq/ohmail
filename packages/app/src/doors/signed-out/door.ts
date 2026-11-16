/**
 * THE SIGNED-OUT PAGE'S DOOR: what a shell hands the page that stands where a session could not be used. The page
 * holds no address and asks nothing itself; every way on is an act the shell performs.
 */
import type { None } from "../../host/contract.js";
import type { SignedOutReason } from "../stage/reasons.js";

/**
 * Why this browser holds no usable sign-in, as the refresh door named it: `revoked`, `expired`, `absent` (no sign-in
 * in this browser), `reused` (a reuse sweep's own refusal), or `pending` (a sign-out this browser asked for).
 */
export type { SignedOutReason };

export type SignedOutState =
  /** The sign-in is being renewed. `slow`: the wait has outlasted the loading grace, so it says what it waits for. */
  | { readonly at: "checking"; readonly slow: boolean }
  /** The server could not be reached; this browser has not been signed out. */
  | { readonly at: "busy" }
  /** The sign-in cannot be renewed, and why. */
  | { readonly at: "signedOut"; readonly reason: SignedOutReason }
  /** The session could not be confirmed, so nothing was loaded. */
  | { readonly at: "out" }
  /** The session check did not finish. `warm`: this device's own copy is on screen. */
  | { readonly at: "unchecked"; readonly warm: boolean };

export interface SignedOutDoor {
  readonly state: SignedOutState;
  /** Ask again; a person asked, so every count starts over. */
  tryAgain(): void;
  /** Go to the sign-in page. */
  signIn(): void;
  /** Open the demo, where this build has one. */
  readonly demo: (() => void) | None;
}
