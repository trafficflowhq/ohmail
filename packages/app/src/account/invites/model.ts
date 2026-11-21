/**
 * Settings › Invites, as data: on a server its operator runs, make a link that lets somebody else create an account
 * there, see the open ones, take one back. The pane draws an {@link InvitesModel} and reaches nothing; its hook
 * reaches the server through an {@link InvitesDoor} and guards every verb with the group's one gated machine.
 *
 * The invite link is the one secret here: it is made by the door, held while its sheet is open, drawn as a picture
 * to scan and copied on request, and it is never printed.
 */
import type { Answer, GatedAsk } from "../contract.js";
import {
  GATED_IDLE,
  gatedStep,
  type GatedAnswer,
  type GatedDialogEvent,
  type GatedEvent,
  type GatedRefusal,
  type GatedRun,
  type GatedState,
} from "../gated.js";

/** An invite nobody has used yet. Days arrive as the reader says them. */
export interface OpenInvite {
  readonly id: string;
  /** Whom it is for; `null` where no name was given. */
  readonly name: string | null;
  readonly made: string;
  readonly expires: string;
}

/** An invite link, made once: the link whole, and the name the server kept for it ("" for none). */
export interface MadeInvite {
  readonly id?: string;
  readonly expires?: string;
  readonly link: string;
  readonly name: string;
}

/** How a host reaches the account's invites. Every call is one request. */
export interface InvitesDoor {
  /** The open invites: this account's own, not used, not expired. */
  read(): Promise<Answer<readonly OpenInvite[]>>;
  /** Makes one invite link, for the name given ("" for none). The link is assembled behind the door, once. */
  make(name: string): Promise<Answer<MadeInvite>>;
  /** Revokes an open invite. One that is already gone is taken. */
  revoke(id: string): Promise<Answer<null>>;
  /** Writes the clipboard. `true` only once the clipboard took it. */
  copy(text: string): Promise<boolean>;
}

/** The gated verbs, as the machine parks and sends them. */
export type InvitesAct =
  { readonly kind: "make"; readonly name: string } | { readonly kind: "revoke"; readonly id: string };

/** What did not go through, and why: the read of the list, a verb, or the copy of the link (the clipboard gives no reason). */
export type InvitesProblem =
  { readonly with: "read" | InvitesAct["kind"]; readonly why: GatedRefusal } | { readonly with: "copy" };

/** What the pane draws. */
export interface InvitesModel {
  /** The open invites; `null` until they are read. A read that failed is never an empty list. */
  readonly invites: readonly OpenInvite[] | null;
  /** The name being typed for the next invite. */
  readonly name: string;
  /** The link on show. Revoking its invite from the list leaves it up, as the shipped pane does. */
  readonly made: MadeInvite | null;
  /** The verb on its way, for the control that says it is working. */
  readonly working: InvitesAct | null;
  /** Why the last read, verb or copy did not go through. */
  readonly problem: InvitesProblem | null;
  /** What the last verb did, said once. */
  readonly told: { readonly kind: "copied" | "revoked" } | null;
  /** A factor landed after Cancel: nothing ran. */
  readonly nothingRan: boolean;
  /** The factor is asked: the pane hands this to its factor slot. */
  readonly ask: GatedAsk | null;
  type(name: string): void;
  make(): void;
  copy(): void;
  /** Takes the link down. */
  done(): void;
  revoke(id: string): void;
}

/** The pane's state: the list as read, what is typed, the link on show, what is said, and the one gated act. */
export interface InvitesState extends Pick<InvitesModel, "invites" | "name" | "made" | "problem" | "told"> {
  /** At rest, on its way, or its factor asked: a verb that ended leaves nothing here. */
  readonly gate: GatedState<InvitesAct>;
}

/** The person's presses, by the model's verbs. */
export type InvitesPress =
  | { readonly kind: "type"; readonly name: string }
  | { readonly kind: "make" }
  | { readonly kind: "copy" }
  | { readonly kind: "done" }
  | { readonly kind: "revoke"; readonly id: string };

export type InvitesEvent =
  | InvitesPress
  /** The door answered a read of the list. */
  | { readonly kind: "read"; readonly answer: Answer<readonly OpenInvite[]> }
  /** The door made the link: it is shown before anything else is asked. */
  | { readonly kind: "made"; readonly invite: MadeInvite }
  | { readonly kind: "revoked" }
  /** The clipboard answered the copy of the link. */
  | { readonly kind: "copied"; readonly took: boolean }
  /** The act on its way is over: taken, or refused with a word. */
  | { readonly kind: "answered"; readonly answer: GatedAnswer }
  | GatedDialogEvent;

export interface InvitesStepped {
  readonly state: InvitesState;
  /** The verb to send now, once; `null` where the event sends nothing. */
  readonly run: GatedRun<InvitesAct> | null;
  /** What else the event asks of the door, with no factor before it: the link on show copied. */
  readonly then: "copy" | null;
}

export const INVITES_START: InvitesState = {
  invites: null,
  name: "",
  made: null,
  problem: null,
  told: null,
  gate: GATED_IDLE,
};

const stays = (state: InvitesState): InvitesStepped => ({ state, run: null, then: null });

/** A read's answer, applied. A read is never parked: a door that asks the factor for it is refused. */
function listRead(state: InvitesState, answer: Answer<readonly OpenInvite[]>): InvitesState {
  if (answer.ok) return { ...state, invites: answer.value };
  const why: GatedRefusal = "said" in answer ? { word: "said", said: answer.said } : { word: "sign_in" };
  // A read that failed is never an empty list: what was read before stays, and with nothing read nothing is listed.
  return { ...state, problem: { with: "read", why } };
}

/**
 * A verb is tried through the machine: a second one while one is on its way, or its factor asked, is not taken.
 * Every send starts clean: what the last verb left to say is no longer what is said.
 */
function tried(state: InvitesState, act: InvitesAct): InvitesStepped {
  const next = gatedStep(state.gate, { kind: "try", act });
  if (next.run === null) return stays(state);
  return { state: { ...state, problem: null, told: null, gate: next.state }, run: next.run, then: null };
}

/** A press, applied. */
function pressed(state: InvitesState, press: InvitesPress): InvitesStepped {
  switch (press.kind) {
    case "type":
      return stays({ ...state, name: press.name });
    case "make":
      // One link at a time: while one is on show, the next waits for Done.
      return state.made === null ? tried(state, { kind: "make", name: state.name.trim() }) : stays(state);
    case "copy": {
      if (state.made === null) return stays(state);
      // A new copy starts clean of the last one: "copied" and "could not be copied" never stand together.
      const problem = state.problem?.with === "copy" ? null : state.problem;
      return { state: { ...state, problem, told: null }, run: null, then: "copy" };
    }
    case "done":
      // The link leaves memory.
      return state.made === null ? stays(state) : stays({ ...state, made: null, told: null });
    case "revoke":
      return state.invites?.some((invite) => invite.id === press.id) === true
        ? tried(state, { kind: "revoke", id: press.id })
        : stays(state);
  }
}

/** The machine's own events, applied: the door's answer to the verb on its way, and the dialog's three. */
function gated(state: InvitesState, event: GatedEvent<InvitesAct>): InvitesStepped {
  const { state: gate, run } = gatedStep(state.gate, event);
  const rest = { at: "idle", nothingRan: gate.nothingRan } as const;
  // A verb that ended leaves nothing behind but, where it was refused, why.
  if (gate.at === "refused") {
    return stays({ ...state, problem: { with: gate.act.kind, why: gate.refusal }, gate: rest });
  }
  if (gate.at === "done") return stays({ ...state, gate: rest });
  if (run === null) return stays({ ...state, gate });
  // The send after a verified factor starts clean, as every send does.
  return { state: { ...state, problem: null, told: null, gate }, run, then: null };
}

/** One event, applied: the state after it, the verb to send now, and what else to ask of the door. */
export function invitesStep(state: InvitesState, event: InvitesEvent): InvitesStepped {
  switch (event.kind) {
    case "read":
      return stays(listRead(state, event.answer));
    case "made":
      return stays({ ...state, made: event.invite, name: "" });
    case "revoked":
      // The link on show stays up when its invite is revoked from the list, as the shipped pane leaves it.
      return stays({ ...state, told: { kind: "revoked" } });
    case "copied":
      // "Copied" only once the clipboard took it.
      return event.took
        ? stays({ ...state, told: { kind: "copied" } })
        : stays({ ...state, problem: { with: "copy" } });
    case "answered":
    case "verified":
    case "cancelled":
    case "discarded":
      return gated(state, event);
    default:
      return pressed(state, event);
  }
}

/** The model a state draws, with the factor's ask and the verbs the hook hands in. */
export function invitesModelOf(
  state: InvitesState,
  ask: GatedAsk | null,
  press: (press: InvitesPress) => void,
): InvitesModel {
  const { gate } = state;
  return {
    invites: state.invites,
    name: state.name,
    made: state.made,
    working: gate.at === "trying" ? gate.act : null,
    problem: state.problem,
    told: state.told,
    nothingRan: gate.nothingRan,
    ask,
    type: (name) => press({ kind: "type", name }),
    make: () => press({ kind: "make" }),
    copy: () => press({ kind: "copy" }),
    done: () => press({ kind: "done" }),
    revoke: (id) => press({ kind: "revoke", id }),
  };
}
