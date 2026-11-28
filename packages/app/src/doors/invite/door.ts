/**
 * THE HOUSEHOLD INVITE'S DOOR. The ceremony is the shell's: the link's token read once from the address and scrubbed
 * from it, the session asked before the token is spent, a pending sign-out finished first, the one submit that spends
 * the link and makes the account, the code it was spent for kept for a retry. The token never reaches the page: it
 * holds the three blanks and says what the state says.
 */
import type { PendingSignOutDoor } from "../sign-in/door.js";
import type { Blanks } from "../stage/fields.js";

export type InviteState =
  /** The link is being read. */
  | { readonly at: "opening" }
  /** The link carried no secret: it was cut short, or the secret came in the query, which is refused. */
  | { readonly at: "missing" }
  /** The page was reopened after it removed the fragment from this history entry. */
  | { readonly at: "reopen" }
  /** This build has no server behind it. */
  | { readonly at: "unavailable" }
  /** The account's blanks; while they are sent, and a refusal said as the shell's sentence. */
  | { readonly at: "form"; readonly busy: boolean; readonly refusal: string | null };

export type InviteField = "email" | "name" | "password";

export interface InviteDoor {
  readonly state: InviteState;
  readonly fields: Blanks<InviteField>;
  /** One blank changed. */
  type(field: InviteField, value: string): void;
  /** The one submit: the link is spent and the account made. */
  submit(): void;
  /** A sign-out this browser asked for that ended unconfirmed, and Sign out to ask again. */
  readonly pending: PendingSignOutDoor;
}
