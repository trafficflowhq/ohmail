/**
 * THE DELETE PAGE'S DOOR: the account erased in full, from a page of its own. The ceremony is the shell's (whose browser
 * this is, the session's own address, the erase with its receipt and its refusals, the wipe of this browser's copy);
 * the page says what is erased and what is kept, takes the address typed back, asks the second factor on every press
 * with the one dialog, and says the outcome. It holds no address and no token: every press is the door's.
 */
import type { StepUpDoor, StepUpProps } from "../step-up/door.js";

/** Who runs the server: what is kept differs, and a self-hosted server has no privacy policy of ours. */
export type DeleteAccountService = "managed" | "self";

export type DeleteAccountState =
  /** Whose browser this is, or the session's address, is being asked. */
  | { readonly at: "checking" }
  /** No live session on this browser: deleting needs one. */
  | { readonly at: "signedout" }
  /** The sign-in could not be checked. */
  | { readonly at: "unchecked" }
  /** The browser cannot act for this account, or the session could not be read: the shell's sentence. */
  | { readonly at: "refused"; readonly said: string }
  | {
      readonly at: "form";
      /** The session's own address, which is typed back. */
      readonly email: string;
      /** There is a subscription to speak of: its line stands in what is kept. */
      readonly subscription: boolean;
      readonly typed: string;
      /** The erase is running. */
      readonly busy: boolean;
      /** Why the last press erased nothing, in the shell's words. */
      readonly refusal: string | null;
      /** A factor came back after Cancel and was thrown away: nothing was erased. */
      readonly cancelled: boolean;
      /** The second factor is asked over the page. */
      readonly factor: boolean;
    }
  | {
      readonly at: "done";
      readonly pending?: boolean;
      /** The server’s description of the records the erase leaves. */
      readonly retained?: string;
      /** What the erase did to the subscription. */
      readonly subscription: "none" | "cancelled" | "cancel_failed";
      /** The copy in this browser could not be removed: another tab holds it open. */
      readonly unclean: boolean;
    };

export interface DeleteAccountDoor {
  readonly state: DeleteAccountState;
  readonly service: DeleteAccountService;
  /** The address as typed. */
  type(value: string): void;
  /** The typed address is the session's: the second factor is asked, and the erase runs once it verifies. */
  begin(): void;
  /** Away from the page, back to the app. */
  back(): void;
  /** After the erase: to the start page. */
  home(): void;
  /** To the sign-in page. */
  signIn(): void;
  /** The hosted service's privacy policy, which says what backups keep and for how long. */
  privacy(): void;
  readonly stepUp: StepUpDoor;
  readonly factor: StepUpProps;
}
