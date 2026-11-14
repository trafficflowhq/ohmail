/**
 * Settings › Security, as data: whether recovery codes and an authenticator stand, new codes in place of the old
 * set, an authenticator added, replaced or removed. The pane draws a {@link SecurityModel} and reaches nothing; its
 * hook reaches the server through a {@link SecurityDoor} and guards every verb with the group's one gated machine.
 *
 * Two secrets pass through, each held only until its sheet is closed: the fresh recovery codes, and the
 * authenticator's key. Everything the pane says is a claim about what is enrolled, so a read that failed draws its
 * reason and nothing below it: an unread session never offers the verb that replaces the codes in use. A set just
 * made is no such claim but the act's own answer, and the only set that works: a read that fails after it is said
 * beside it, and Done still drops it. So is a new authenticator's key: its code, the factor that code may ask, and
 * its Cancel still work over such a read.
 */
import type { Answer, GatedAsk } from "../contract.js";
import {
  GATED_IDLE,
  gatedStep,
  type GatedAnswer,
  type GatedDialogEvent,
  type GatedRefusal,
  type GatedRun,
  type GatedState,
} from "../gated.js";

/** What the account has enrolled. */
export interface Enrolled {
  readonly passkey: boolean;
  readonly authenticator: boolean;
  /** Unused recovery codes exist. */
  readonly recoveryCodes: boolean;
}

/** How a host reaches the account's second factors. Every call is one request. */
export interface SecurityDoor {
  read(): Promise<Answer<Enrolled>>;
  /** Makes a new set of recovery codes. The set in use stops working. */
  newCodes(): Promise<Answer<readonly string[]>>;
  /** Starts an authenticator's enrolment: the key to type into the app. */
  startAuthenticator(): Promise<Answer<{ readonly key: string }>>;
  /** Finishes the enrolment with the app's code, as typed and trimmed. */
  activate(code: string): Promise<Answer<null>>;
  removeAuthenticator(): Promise<Answer<null>>;
}

/** The gated verbs, as the machine parks and sends them. The authenticator's code rides the act while it is sent. */
export type SecurityAct =
  | { readonly kind: "newCodes" }
  | { readonly kind: "startAuthenticator" }
  | { readonly kind: "activate"; readonly code: string }
  | { readonly kind: "removeAuthenticator" };

/** What the pane draws. */
export interface SecurityModel {
  /**
   * What is enrolled: asked, read, or a read that failed with its reason. Below a failed read nothing is drawn; a set
   * of codes just made, and a new authenticator's key, stand beside it all the same.
   */
  readonly enrolled:
    | { readonly at: "loading" }
    | { readonly at: "failed"; readonly why: GatedRefusal }
    | ({ readonly at: "read" } & Enrolled);
  /** The recovery codes' sheet: at rest; asked before the set is replaced; the fresh codes, shown once. */
  readonly codes:
    | { readonly at: "rest" }
    | { readonly at: "asked" }
    | { readonly at: "shown"; readonly codes: readonly string[] };
  /** The authenticator's sheet: at rest, or its key with the code being typed. */
  readonly authenticator:
    { readonly at: "rest" } | { readonly at: "key"; readonly key: string; readonly code: string };
  /** The verb on its way, for the control that says it is working. */
  readonly working: SecurityAct["kind"] | null;
  /** Why the last verb did not go through, and which verb it was. */
  readonly problem: { readonly with: SecurityAct["kind"]; readonly why: GatedRefusal } | null;
  /** A factor landed after Cancel: nothing ran. */
  readonly nothingRan: boolean;
  /** The factor is asked: the pane hands this to its factor slot. */
  readonly ask: GatedAsk | null;
  /** Generate or Replace: asks first. */
  askNewCodes(): void;
  /** The question's own Confirm: only this replaces the set. */
  confirmNewCodes(): void;
  cancelNewCodes(): void;
  /** Done: the codes leave memory. */
  codesDone(): void;
  startAuthenticator(): void;
  typeCode(code: string): void;
  activate(): void;
  /** Cancel: the key and the code leave memory. */
  cancelAuthenticator(): void;
  /** Offered only while a passkey is also enrolled. */
  removeAuthenticator(): void;
}

/** The pane's state: what was read, the two sheets, and the one gated act. */
export interface SecurityState {
  readonly enrolled: SecurityModel["enrolled"];
  readonly codes: SecurityModel["codes"];
  readonly authenticator: SecurityModel["authenticator"];
  readonly gate: GatedState<SecurityAct>;
}

/** The person's presses, by the model's verbs. */
export type SecurityPress =
  | { readonly kind: "askNewCodes" }
  | { readonly kind: "confirmNewCodes" }
  | { readonly kind: "cancelNewCodes" }
  | { readonly kind: "codesDone" }
  | { readonly kind: "startAuthenticator" }
  | { readonly kind: "typeCode"; readonly code: string }
  | { readonly kind: "activate" }
  | { readonly kind: "cancelAuthenticator" }
  | { readonly kind: "removeAuthenticator" };

export type SecurityEvent =
  | SecurityPress
  /** The door answered the read of what is enrolled. */
  | { readonly kind: "read"; readonly answer: Answer<Enrolled> }
  /** The door made the new set: it is shown before anything else is asked. */
  | { readonly kind: "made"; readonly codes: readonly string[] }
  /** The door started an enrolment: its key. */
  | { readonly kind: "started"; readonly key: string }
  /** The door took the code: the key and the code leave memory. */
  | { readonly kind: "activated" }
  /** The act on its way is over: taken, or refused with a word. */
  | { readonly kind: "answered"; readonly answer: GatedAnswer }
  | GatedDialogEvent;

export interface SecurityStepped {
  readonly state: SecurityState;
  /** The verb to send now, once; `null` where the event sends nothing. */
  readonly run: GatedRun<SecurityAct> | null;
}

export const SECURITY_START: SecurityState = {
  enrolled: { at: "loading" },
  codes: { at: "rest" },
  authenticator: { at: "rest" },
  gate: GATED_IDLE,
};

const stays = (state: SecurityState): SecurityStepped => ({ state, run: null });

/** A read's answer as what the pane draws. A read is never parked: a door that asks the factor for it is refused. */
function enrolledOf(answer: Answer<Enrolled>): SecurityState["enrolled"] {
  if (answer.ok) return { at: "read", ...answer.value };
  if ("said" in answer) return { at: "failed", why: { word: "said", said: answer.said } };
  return { at: "failed", why: { word: "sign_in" } };
}

/** A verb is tried through the machine: a second one while one is on its way, or its factor asked, is not taken. */
function tried(state: SecurityState, act: SecurityAct, taken: Partial<SecurityState> = {}): SecurityStepped {
  const next = gatedStep(state.gate, { kind: "try", act });
  if (next.run === null) return stays(state);
  return { state: { ...state, ...taken, gate: next.state }, run: next.run };
}

/**
 * A press, applied. Every verb stands on a session that was read: over an unread one nothing is asked or sent but
 * the ways out of a sheet an act's own answer carries.
 */
function pressed(state: SecurityState, press: SecurityPress): SecurityStepped {
  const { enrolled, codes, authenticator } = state;
  // Taken whatever the read after the act said: the set's Done, which sends nothing, and the key's code, the code
  // that finishes its enrolment, and its Cancel.
  switch (press.kind) {
    case "codesDone":
      return codes.at === "shown" ? stays({ ...state, codes: { at: "rest" } }) : stays(state);
    case "typeCode":
      return authenticator.at === "key"
        ? stays({ ...state, authenticator: { ...authenticator, code: press.code } })
        : stays(state);
    case "activate": {
      if (authenticator.at !== "key") return stays(state);
      const code = authenticator.code.trim();
      return code === "" ? stays(state) : tried(state, { kind: "activate", code });
    }
    case "cancelAuthenticator":
      return authenticator.at === "key" ? stays({ ...state, authenticator: { at: "rest" } }) : stays(state);
  }
  if (enrolled.at !== "read") return stays(state);
  switch (press.kind) {
    case "askNewCodes":
      return codes.at === "rest" ? stays({ ...state, codes: { at: "asked" } }) : stays(state);
    case "cancelNewCodes":
      return codes.at === "asked" ? stays({ ...state, codes: { at: "rest" } }) : stays(state);
    case "confirmNewCodes":
      // Only the question's own Confirm sends: the question closes as the verb leaves.
      return codes.at === "asked"
        ? tried(state, { kind: "newCodes" }, { codes: { at: "rest" } })
        : stays(state);
    case "startAuthenticator":
      return authenticator.at === "rest" ? tried(state, { kind: "startAuthenticator" }) : stays(state);
    case "removeAuthenticator":
      // Taking the last factor away from inside a session is how an account becomes unreachable.
      return enrolled.authenticator && enrolled.passkey && authenticator.at === "rest"
        ? tried(state, { kind: "removeAuthenticator" })
        : stays(state);
  }
}

/** One event, applied: the state after it, and the verb to send now, if any. */
export function securityStep(state: SecurityState, event: SecurityEvent): SecurityStepped {
  switch (event.kind) {
    case "read":
      return stays({ ...state, enrolled: enrolledOf(event.answer) });
    case "made":
      return stays({ ...state, codes: { at: "shown", codes: event.codes } });
    case "started":
      return stays({ ...state, authenticator: { at: "key", key: event.key, code: "" } });
    case "activated":
      return stays({ ...state, authenticator: { at: "rest" } });
    case "answered":
    case "verified":
    case "cancelled":
    case "discarded": {
      const { state: gate, run } = gatedStep(state.gate, event);
      // A verb that went through leaves nothing behind: the act, and a code it carried, are dropped.
      const settled = gate.at === "done" ? { at: "idle" as const, nothingRan: gate.nothingRan } : gate;
      return { state: { ...state, gate: settled }, run };
    }
    default:
      return pressed(state, event);
  }
}

/** The model a state draws, with the factor's ask and the verbs the hook hands in. */
export function securityModelOf(
  state: SecurityState,
  ask: GatedAsk | null,
  press: (press: SecurityPress) => void,
): SecurityModel {
  const { gate } = state;
  return {
    enrolled: state.enrolled,
    codes: state.codes,
    authenticator: state.authenticator,
    working: gate.at === "trying" ? gate.act.kind : null,
    problem: gate.at === "refused" ? { with: gate.act.kind, why: gate.refusal } : null,
    nothingRan: gate.nothingRan,
    ask,
    askNewCodes: () => press({ kind: "askNewCodes" }),
    confirmNewCodes: () => press({ kind: "confirmNewCodes" }),
    cancelNewCodes: () => press({ kind: "cancelNewCodes" }),
    codesDone: () => press({ kind: "codesDone" }),
    startAuthenticator: () => press({ kind: "startAuthenticator" }),
    typeCode: (code) => press({ kind: "typeCode", code }),
    activate: () => press({ kind: "activate" }),
    cancelAuthenticator: () => press({ kind: "cancelAuthenticator" }),
    removeAuthenticator: () => press({ kind: "removeAuthenticator" }),
  };
}
