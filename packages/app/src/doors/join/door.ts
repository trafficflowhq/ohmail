/**
 * THE JOIN'S DOOR. The ceremony is the shell's: the step read from the server on every load, the wizard's one account
 * written once and compared before every act, the order a registration keeps, the factor and the codes made once, the
 * plan before the mailbox, the wait after paying, the address bar scrubbed of every code. The page draws the step it
 * is at, hands back what is typed and presses the door's acts; it holds no token, and the only addresses it draws are
 * the ways out the host hands (`DoorWay`): on the web, literals of the route, and the account page the ceremony holds.
 */
import type { ReactNode } from "react";
import type { ConnectFormProps } from "../../mailboxes/connect/contract.js";
import type { None } from "../../host/contract.js";
import type { PendingSignOutDoor } from "../sign-in/door.js";
import type { SignupPosture } from "../sign-in/invite-posture.js";
import type { Blanks } from "../stage/fields.js";
import type { DoorWay } from "../stage/way.js";

/** The stations the setup lists, in their order; which of them this path has is the door's to say. */
export type JoinStation = "invite" | "account" | "verify" | "factor" | "codes" | "plan" | "mailbox";

/** A copy to the clipboard: done, refused (the words stay on screen to read), or not asked. */
export type JoinCopied = "copied" | "failed" | null;

/** The plan the site's button named, already a name, and how it is billed; never a price. */
export interface JoinPlanChosen {
  readonly name: string | null;
  readonly interval: "month" | "year" | null;
}

export type JoinState =
  /** This build has no server behind it. */
  | { readonly at: "unavailable" }
  /** A signed-in account's step is being read from the server. */
  | { readonly at: "resolving" }
  /** The server did not answer that read. */
  | { readonly at: "unreachable" }
  /** The five minutes of the setup session are over, or a factor window closed: sign in to carry on. */
  | { readonly at: "expired"; readonly said: string }
  /** The service takes no new accounts for now: the list. */
  | { readonly at: "full"; readonly said: string }
  | { readonly at: "invite" }
  | { readonly at: "account" }
  /** The public path: a mail went to the address, and this tab waits for its link to be opened. */
  | { readonly at: "sent"; readonly continuing: boolean }
  | { readonly at: "verify"; readonly resent: boolean }
  /** The second factor; with an authenticator, its key (to read off) and whether it was copied. */
  | {
      readonly at: "factor";
      readonly authenticator: { readonly key: string; readonly copied: JoinCopied } | null;
    }
  /** The recovery codes: shown once; made in another tab; not made yet, or a make that failed. */
  | {
      readonly at: "codes";
      readonly codes: readonly string[] | "elsewhere" | "making" | "failed";
      readonly copied: JoinCopied;
      readonly saved: boolean;
    }
  /** The mailbox step, drawn by the shell's connect form. */
  | { readonly at: "mailbox" }
  /** The plan: whether a trial is offered (unknown until read), what the site chose, the wait after paying, the link. */
  | {
      readonly at: "plan";
      readonly trial: boolean | null;
      readonly chosen: JoinPlanChosen;
      readonly waiting: boolean;
      readonly link: "asking" | "ready" | "none";
    }
  /** Set up: the mailbox connected here, and whether the organize decision is still ahead. */
  | { readonly at: "done"; readonly mailbox: string | null; readonly decisionAhead: boolean };

export type JoinField = "code" | "email" | "name" | "password" | "otp";

export interface JoinDoor {
  readonly state: JoinState;
  /** The stations this path lists, in order. */
  readonly stations: readonly JoinStation[];
  /** Which sentence about invite codes is true of this deployment. */
  readonly note: SignupPosture;
  /** This deployment asks for an invite code first. */
  readonly invited: boolean;
  readonly busy: boolean;
  /** The step's refusal, said as the shell's sentence. */
  readonly refusal: string | null;
  readonly fields: Blanks<JoinField>;
  /** A likely mistyped address, mended: the account step offers it. */
  readonly suggestion: string | null;
  readonly pending: PendingSignOutDoor;
  type(field: JoinField, value: string): void;
  /** The invite step: the code is held, and the account step follows. */
  redeem(): void;
  /** The account is made. */
  register(): void;
  toInvite(): void;
  takeSuggestion(): void;
  /** The public path's sent step: back to the form, the address kept to mend. */
  changeAddress(): void;
  /** To the sign-in, for a person who already has an account. */
  readonly signIn: DoorWay;
  resend(): void;
  /** Ask the server again where the setup stands. */
  recheck(): void;
  addPasskey(): void;
  useAuthenticator(): void;
  copyKey(): void;
  /** Hand the authenticator's enrolment to an app on this device. */
  openAuthenticator(): void;
  activate(): void;
  leaveAuthenticator(): void;
  copyCodes(): void;
  downloadCodes(): void;
  save(saved: boolean): void;
  /** On from the codes. */
  codesDone(): void;
  retryCodes(): void;
  /** The account page, where the plan is taken: the address the ceremony was handed for it, once it holds one. */
  readonly accountPage: DoorWay | null;
  /** Out to the app, the setup left for later. */
  readonly later: DoorWay;
  /** Into ohmail, at the first run. */
  readonly open: DoorWay;
  retry(): void;
  /** Back to ohmail, from a setup whose step could not be read. */
  readonly leave: DoorWay;
  /** The expired setup: sign in, and the setup carries on. */
  readonly signInAgain: DoorWay;
  /** The service takes no new accounts for now: its list. */
  readonly waitlist: DoorWay;
  /** The demo, where this build has one and no server. */
  readonly demo: DoorWay | None;
  /** What the shell draws inside the page, called in render: the mailbox step's connect form, and the QR picture of
   *  the authenticator's enrolment (no part of the kit draws one yet). */
  readonly slots: {
    mailbox(page: NonNullable<ConnectFormProps["page"]>): ReactNode;
    authenticatorQr(): ReactNode;
  };
}
