/**
 * THE EMAIL CONFIRMATION'S DOOR. The ceremony is the shell's: the link's code taken from the address and scrubbed from
 * it, the session asked on arrival, a pending sign-out finished first, the one submit that confirms the address with
 * the account's password, a waiting tab handed the setup. The link's own code never reaches the page: a blank for it
 * stands only where the link brought none, and the page holds what the person typed.
 */
import type { PendingSignOutDoor } from "../sign-in/door.js";
import type { Blanks } from "../stage/fields.js";

export type VerifyState =
  /** This build has no server behind it. */
  | { readonly at: "unavailable" }
  /** The address is confirmed and a second factor exists: the person signs in. */
  | { readonly at: "done" }
  /** The address is confirmed, and the tab that waited for it carries the setup on. */
  | { readonly at: "handed" }
  /**
   * The password, and the code where the link brought none (`asksCode`); while it is sent, and a refusal said as the
   * shell's sentence. `codeHeld`: a code stands to confirm with, the link's or the one typed; a refused one is dropped.
   * `passwordRefused`: the refusal is the password's, so its blank says it was refused.
   */
  | {
      readonly at: "form";
      readonly asksCode: boolean;
      readonly codeHeld: boolean;
      readonly busy: boolean;
      readonly refusal: string | null;
      readonly passwordRefused: boolean;
    };

export type VerifyField = "code" | "password";

export interface VerifyDoor {
  readonly state: VerifyState;
  /** What the person typed: the code only where the link brought none, and the password. */
  readonly fields: Blanks<VerifyField>;
  /** One blank changed. */
  type(field: VerifyField, value: string): void;
  /** The one submit: the address is confirmed with the password. */
  submit(): void;
  /** To the sign-in, once the address is confirmed. */
  signIn(): void;
  /** To the sign-in that carries on into the setup, where a fresh link is sent. */
  newLink(): void;
  /** A sign-out this browser asked for that ended unconfirmed, and Sign out to ask again. */
  readonly pending: PendingSignOutDoor;
}
