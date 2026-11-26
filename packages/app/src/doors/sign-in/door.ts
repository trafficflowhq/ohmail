/**
 * THE SIGN-IN PAGE'S DOOR. The ceremony is the shell's: the session check before the form, the refresh it waits for,
 * the pending sign-out it finishes, the login token it keeps for the second factor, and where the person goes once a
 * session exists. It holds the blanks too, as typed: the page draws them, hands each change back and presses the
 * door's acts, and keeps no typed word of its own. No token reaches the page, and the only addresses it draws are the
 * ways out the host hands (`DoorWay`).
 */
import type { None } from "../../host/contract.js";
import type { Blanks } from "../stage/fields.js";
import type { SignedOutReason } from "../stage/reasons.js";
import type { DoorWay } from "../stage/way.js";
import type { SignupPosture } from "./invite-posture.js";

/** The sign-in's blanks: the address and the password, then the second factor's code. */
export type SignInField = "email" | "password" | "code";

/** The second factor on screen: a passkey this browser can use, a one-time code, a recovery code. */
export type SignInFactor = "passkey" | "code" | "recovery";

/**
 * Why a step was refused, as a word: the wrong email or password, the wrong code or passkey, the throttle's two
 * refusals (each its own sentence: the one thing to do next is to wait), or the server's own sentence for anything
 * this page has no word for.
 */
export type SignInRefusal =
  | { readonly word: "bad_credentials" | "bad_code" | "bad_passkey" | "slowed" | "locked" }
  | { readonly word: "said"; readonly said: string };

/** The `login` sentence each refusal word is said with. */
export const SIGN_IN_REFUSAL_SAID: Readonly<Record<Exclude<SignInRefusal["word"], "said">, string>> = {
  bad_credentials: "badCredentials",
  bad_code: "badCode",
  bad_passkey: "badPasskey",
  slowed: "signInSlowed",
  locked: "tooManyAttempts",
};

export type SignInState =
  /** This build has no server behind it: there is nobody to sign in to. */
  | { readonly at: "unavailable" }
  /** The email and the password. */
  | { readonly at: "password"; readonly busy: boolean; readonly refusal: SignInRefusal | null }
  /** The second factor: the one on screen, and the others this account enrolled and this browser can use. */
  | {
      readonly at: "factor";
      readonly factor: SignInFactor;
      readonly offered: readonly SignInFactor[];
      readonly busy: boolean;
      readonly refusal: SignInRefusal | null;
    };

/** A sign-out this browser asked for that ended unconfirmed: what did not happen, and Sign out to ask again. */
export interface PendingSignOutDoor {
  /** The sentence, while it stands; null otherwise. */
  readonly said: string | null;
  /** The button's words, or null if the sentence names a browser setting to use. */
  readonly act: string | null;
  readonly signingOut: boolean;
  again(): void;
}

export interface SignInDoor {
  readonly state: SignInState;
  /** This deployment's signup posture. */
  readonly note: SignupPosture;
  /** Where the sign-in carries on, named: the account page, or the setup. */
  readonly continues: "manage" | "join" | null;
  /** Why this browser is at the sign-in page, when a sign-out's reason was handed on. */
  readonly why: SignedOutReason | null;
  readonly pending: PendingSignOutDoor;
  /** The blanks as the ceremony holds them: what the person typed, and nothing the page keeps of its own. */
  readonly fields: Blanks<SignInField>;
  /** A change to a blank, as typed. */
  type(field: SignInField, value: string): void;
  /** The password step, with the address and the password the ceremony holds. */
  begin(): void;
  /** The passkey ceremony, when the passkey is the factor on screen. */
  passkey(): void;
  /** A one-time or recovery code, by the factor on screen, as the ceremony holds it. */
  finish(): void;
  /** Another factor this account enrolled. */
  use(factor: SignInFactor): void;
  /** A fresh password step: a login token is used once. */
  restart(): void;
  /** To the sign-up, for an invite code or a new account. */
  readonly join: DoorWay;
  readonly forgotPassword?: DoorWay;
  /** Back to the welcome surface, where the host has one. */
  readonly back?: string;
  /** The demo, where this build has one and no server. */
  readonly demo: DoorWay | None;
}
