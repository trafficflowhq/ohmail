/**
 * WHAT THE ONE CONNECT FORM'S MACHINE HOLDS AND HEARS: its facts, its state, its events and what a step answers.
 * The state holds no password. A press carries its body sealed, and the body rides the state only while the press is
 * on its way or parked behind the second factor: a frozen value, re-sent as it was.
 */
import type { AuthHint } from "@ohmail/client-engine";
import { sentOf } from "./body.js";
import { NO_CONSENTS, type Consents, type Dialled, type HostsNow } from "./consents.js";
import { GATED_IDLE, type GatedState } from "./gate.js";
import { providerById, type ProviderPreset } from "./providers.js";
import type { Said } from "./refusal.js";
import type {
  Answered,
  ConnectInput,
  ConnectPatch,
  ConnectProbed,
  ConnectPurposeKind,
  ConnectTyped,
  Leg,
  MailboxId,
  SignInWays,
} from "./types.js";

/** What the mount and the shell say of this form. Facts; nothing typed. */
export interface ConnectFacts {
  readonly purpose: ConnectPurposeKind;
  /** The mailbox an edit or a reconnect is about. Its id is the account's own. */
  readonly subject: {
    readonly id: MailboxId;
    readonly address: string;
    readonly provider: string;
    readonly signsIn: "password" | "provider";
  } | null;
  /** The second factor's dialog can be asked. */
  readonly factor: boolean;
  /** The sign-in ceremonies the shell runs; shut until read. */
  readonly ways: SignInWays;
  /** The shell runs a sign-in by code from this form. */
  readonly code: boolean;
}

/**
 * A PRESS, AS A VALUE: the verb, the mailbox it is about (captured at the press), the mode a connect states, the
 * frozen body, and the servers it dials. Parked behind the second factor it is this value and nothing else; a
 * verified factor sends it once more as it stands.
 */
export interface Parked {
  readonly verb: "test" | "connect" | "edit";
  readonly subject: MailboxId | null;
  readonly mode: "seed" | "add" | null;
  readonly body: ConnectInput | ConnectPatch;
  readonly sent: Dialled;
}

/** A sentence on screen. `calm`: a settled outcome that is no fault, said as a status. */
export interface Shown {
  readonly said: Said;
  readonly calm: boolean;
}

/** What the form ended with. */
export type ConnectOutcome =
  | {
      readonly kind: "connected";
      readonly mailboxId: MailboxId;
      readonly address: string | null;
      readonly created: boolean;
    }
  | { readonly kind: "saved"; readonly mailboxId: MailboxId };

export interface ConnectState {
  readonly typed: ConnectTyped;
  readonly consents: Consents;
  /** The press on its way or parked, on the one machine of a guarded act. */
  readonly gate: GatedState<Parked>;
  /** The newest press: an answer that names an older one changes nothing. */
  readonly seq: number;
  /** What a press would send changed while one was on its way: no factor is asked for that press (`gate-moved.ts`). */
  readonly moved: boolean;
  /** The newest sign-in press and choice of way: a start answered after a newer one leaves nowhere. */
  readonly signIns: number;
  readonly shown: Shown | null;
  /** What the last test proved, while the form is as it was tested. */
  readonly tested: ConnectProbed | null;
  /** An unreachable server on the manual entry: the looked-up servers may be offered. */
  readonly offerHosts: boolean;
  /** A name the refused certificate proves and the server answers to, offered as one press. */
  readonly suggestion: { readonly leg: Leg; readonly host: string } | null;
  /** Why the provider refused the sign-in, where it said: its help links ride that sentence. */
  readonly authHint: AuthHint | null;
  /** The last refusal's closed word, for support. */
  readonly lastReason: string | null;
  /** The browser is on its way to a provider: the press is spent. */
  readonly leaving: boolean;
}

export type TypedField = "address" | "user" | "imapHost" | "smtpHost" | "imapPort" | "smtpPort";

export type ConnectEvent =
  | { readonly kind: "typed"; readonly field: TypedField; readonly value: string }
  /** A tile chosen, by the person or by the address; `null` withdraws the address's own choice. */
  | { readonly kind: "provider"; readonly id: string | null; readonly byHand: boolean }
  /** The password field changed. Never its value. */
  | { readonly kind: "password" }
  /** "Use an app password instead", on a tile that signs in. */
  | { readonly kind: "byPassword" }
  | {
      readonly kind: "tick";
      readonly consent: "plain" | "certificate";
      readonly leg: Leg | "both";
      readonly on: boolean;
    }
  | { readonly kind: "suggestionTaken" }
  /** The looked-up servers taken: each fills its field, as one host field holds it. */
  | { readonly kind: "hostsTaken"; readonly imap: string | null; readonly smtp: string | null }
  | { readonly kind: "press"; readonly act: Parked }
  | { readonly kind: "answered"; readonly seq: number; readonly answer: Answered<unknown> }
  /** The caller's guard said no: the press was not sent. */
  | { readonly kind: "guarded"; readonly seq: number }
  | { readonly kind: "factor"; readonly answer: "verified" | "cancelled" | "discarded" }
  /** The form's own sentence: a port that is none, a sign-in's return. `null` takes it away. */
  | { readonly kind: "said"; readonly shown: Shown | null; readonly reason?: string | null }
  /** A sign-in press, and its answer. */
  | { readonly kind: "signIn"; readonly at: "pressed" | "leaving" | "stayed" };

export interface Stepped {
  readonly state: ConnectState;
  /** The press to send now, once. */
  readonly send: { readonly act: Parked; readonly afterFactor: boolean; readonly seq: number } | null;
  readonly done: ConnectOutcome | null;
  /** The password leaves its field. */
  readonly forget: boolean;
}

export const EMPTY_TYPED: ConnectTyped = Object.freeze({
  address: "",
  provider: null,
  byHand: false,
  user: "",
  imapHost: "",
  smtpHost: "",
  imapPort: "",
  smtpPort: "",
  byPassword: false,
});

/** The form as it opens: the kept words where a caller kept them, nothing ticked, nothing parked. */
export function initialState(kept: ConnectTyped | null, _facts: ConnectFacts): ConnectState {
  return {
    typed: kept ?? EMPTY_TYPED,
    consents: NO_CONSENTS,
    gate: GATED_IDLE,
    seq: 0,
    moved: false,
    signIns: 0,
    shown: null,
    tested: null,
    offerHosts: false,
    suggestion: null,
    authHint: null,
    lastReason: null,
    leaving: false,
  };
}

/** The tile's preset; `null` on an edit, which has no tile, and until one is chosen. */
export function presetOf(typed: ConnectTyped, facts: ConnectFacts): ProviderPreset | null {
  if (facts.purpose === "edit" || facts.purpose === "reconnect" || typed.provider === null) return null;
  return providerById(typed.provider);
}

/** The servers the form holds now, each as a press would name it. */
export function hostsNow(typed: ConnectTyped, facts: ConnectFacts): HostsNow {
  return sentOf(typed, presetOf(typed, facts));
}
