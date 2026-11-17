/**
 * THE SERVER SETUP'S DOOR. The ceremony is the shell's: the gate on a fresh answer from the server, the session read
 * that sends a half-finished setup on to the join, the one submit that spends the setup token and makes the first
 * account, the code it was spent for kept for a retry. The page holds the four blanks and says what the state says.
 */
import type { Blanks } from "../stage/fields.js";

export type SetupState =
  /** The server is being asked whether it is new. */
  | { readonly at: "checking" }
  /** The server did not answer. */
  | { readonly at: "unreachable" }
  /** The server has its first account already. */
  | { readonly at: "settled" }
  /**
   * A new server: the token and the first account; while it is sent, and a refusal said as the shell's sentence.
   * `tokenRefused`: the refusal is the token's, so its blank says it was refused.
   */
  | {
      readonly at: "form";
      readonly busy: boolean;
      readonly refusal: string | null;
      readonly tokenRefused: boolean;
    };

/** The four blanks, as the person typed them; the ceremony keeps them across a refusal. */
export type SetupField = "token" | "email" | "name" | "password";

export interface SetupDoor {
  readonly state: SetupState;
  readonly fields: Blanks<SetupField>;
  /** One blank changed. */
  type(field: SetupField, value: string): void;
  /** The one submit: the token is spent and the account made. */
  submit(): void;
  /** Ask the server again. */
  retry(): void;
  /** To the sign-in, on a server that is set up. */
  signIn(): void;
  /** The command that reads the server's log, to the clipboard: whether it got there. */
  copy(text: string): Promise<boolean>;
}
