/**
 * Settings › Devices, as data: pair another device with this account, see what is signed in, take one back. The pane
 * draws a {@link DevicesModel} and reaches nothing; its hook reaches the server through a {@link DevicesDoor} and
 * guards every verb with the group's one gated machine.
 *
 * The pairing link is the one secret here: it is made by the door, held while its sheet is open, shown once, and is
 * part of no address, no stored key and no summary.
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

/** What a signed-in device is, as the pane names it. A kind this build does not know is `other`, never a browser. */
export type DeviceKind = "web" | "mac" | "linux" | "windows" | "android" | "ios" | "other";

/**
 * How a device is named: by the person; by ohmail, for an app that paired without a name (said in the reader's
 * language, never as the server stored it); or not at all (its kind then names it).
 */
export type DeviceName =
  { readonly by: "person"; readonly said: string } | { readonly by: "ohmail" } | { readonly by: "nobody" };

/** One session signed in to the account. Days arrive as the reader says them. */
export interface DeviceSession {
  readonly id: string;
  readonly kind: DeviceKind;
  readonly name: DeviceName;
  /** This browser's own session: listed first, with no verb. */
  readonly current: boolean;
  /** A plain browser sign-in, not a paired device. */
  readonly plainWeb: boolean;
  readonly added: string;
  readonly seen: string;
}

/** A pairing code not used yet. `until` is the time it works until, as the reader says it. */
export interface PairingCode {
  readonly id: string;
  /** The name it was made for; `null` where none was given. */
  readonly name: string | null;
  readonly until: string;
}

/** A pairing link, made once: the row it belongs to, the link whole, and the name the server kept for it ("" for none). */
export interface MadeLink {
  readonly id: string;
  readonly link: string;
  readonly name: string;
}

/** Both lists, as one read answers them: the sessions signed in and the pairing codes not used yet. */
export interface DevicesLists {
  readonly sessions: readonly DeviceSession[];
  readonly codes: readonly PairingCode[];
  readonly onShown?: () => () => void;
}

/** How a host reaches the account's devices. Every call is one request, but `read`, which asks both lists together. */
export interface DevicesDoor {
  /** The sessions signed in and the pairing codes not used yet. */
  read(): Promise<Answer<DevicesLists>>;
  /**
   * Whether the other plain browser sessions are one line with one sign-out: only where the server is the managed
   * service or a self-hosted one. `false` where that is not known.
   */
  groupsWebSessions(): Promise<boolean>;
  /** Makes one pairing link, for the name given ("" for none). The link is assembled behind the door, once. */
  add(name: string): Promise<Answer<MadeLink>>;
  /** Revokes a code not used yet. One that is already gone is taken. */
  revokeCode(id: string): Promise<Answer<null>>;
  /** Signs a device out. */
  remove(id: string): Promise<Answer<null>>;
  /** Ends every other plain browser session, and answers how many. */
  signOutWeb(): Promise<Answer<{ readonly ended: number }>>;
  /** Writes the clipboard. `true` only once the clipboard took it. */
  copy(text: string): Promise<boolean>;
}

/** The gated verbs, as the machine parks and sends them. */
export type DevicesAct =
  | { readonly kind: "add"; readonly name: string }
  | { readonly kind: "revokeCode"; readonly id: string }
  | { readonly kind: "remove"; readonly id: string }
  | { readonly kind: "signOutWeb" };

/** The other plain browser sessions, as one line. */
export interface WebGroup {
  readonly count: number;
  readonly seen: string;
}

/** What is asked before a removal runs: the removal itself, as the machine will send it. */
export type DevicesQuestion = Extract<DevicesAct, { kind: "remove" | "signOutWeb" }>;

/** What did not go through, and why: a read of the lists, a verb, or the copy of the link (the clipboard gives no reason). */
export type DevicesProblem =
  { readonly with: "read" | DevicesAct["kind"]; readonly why: GatedRefusal } | { readonly with: "copy" };

/** What the last verb did. */
export type DevicesTold =
  | { readonly kind: "copied" | "revoked" | "removed" }
  | { readonly kind: "signedOutWeb"; readonly ended: number };

/** The sessions as the pane lists them: this one first, then every other that is listed by itself; the rest as one line. */
export interface DevicesListed {
  readonly devices: readonly DeviceSession[];
  readonly webGroup: WebGroup | null;
}

/** What the pane draws. */
export interface DevicesModel {
  /** The devices: asked, read, or a read that failed. A failed read is never an empty list. */
  readonly list:
    { readonly at: "loading" } | { readonly at: "failed" } | ({ readonly at: "read" } & DevicesListed);
  readonly codes: readonly PairingCode[];
  /** The name being typed for the next device. */
  readonly name: string;
  /** The link on show; it comes down with its row. */
  readonly made: MadeLink | null;
  /** The verb on its way, for the control that says it is working. */
  readonly working: DevicesAct | null;
  /** What is asked before a removal runs. */
  readonly question: DevicesQuestion | null;
  /** Why the last read, verb or copy did not go through. */
  readonly problem: DevicesProblem | null;
  /** What the last verb did, said once. */
  readonly told: DevicesTold | null;
  /** A factor landed after Cancel: nothing ran. */
  readonly nothingRan: boolean;
  /** The factor is asked: the pane hands this to its factor slot. */
  readonly ask: GatedAsk | null;
  type(name: string): void;
  add(): void;
  copy(): void;
  /** Takes the link down and reads the lists again. */
  done(): void;
  revokeCode(id: string): void;
  askRemove(id: string): void;
  askSignOutWeb(): void;
  /** The question's own Confirm: only this sends the removal. */
  confirm(): void;
  dismiss(): void;
  /** Reads the lists again after a read that failed. */
  retry(): void;
}

/** The pane's state: what was read, what is typed, the link on show, what is asked and said, and the one gated act. */
export interface DevicesState extends Pick<
  DevicesModel,
  "codes" | "name" | "made" | "question" | "problem" | "told"
> {
  /** The sessions: asked; a read that failed with nothing read before it; or as last read. */
  readonly list:
    | { readonly at: "loading" }
    | { readonly at: "failed" }
    | { readonly at: "read"; readonly sessions: readonly DeviceSession[] };
  /** The other plain browser sessions are one line: the server's flavour says so. `false` until it is known. */
  readonly groups: boolean;
  /** At rest, on its way, or its factor asked: a verb that ended leaves nothing here. */
  readonly gate: GatedState<DevicesAct>;
}

/** The person's presses, by the model's verbs. */
export type DevicesPress =
  | { readonly kind: "type"; readonly name: string }
  | { readonly kind: "add" }
  | { readonly kind: "copy" }
  | { readonly kind: "done" }
  | { readonly kind: "revokeCode"; readonly id: string }
  | { readonly kind: "askRemove"; readonly id: string }
  | { readonly kind: "askSignOutWeb" }
  | { readonly kind: "confirm" }
  | { readonly kind: "dismiss" }
  | { readonly kind: "retry" };

export type DevicesEvent =
  | DevicesPress
  /** The door answered a read of both lists. */
  | { readonly kind: "read"; readonly answer: Answer<DevicesLists> }
  /** The door answered whether the plain browser sessions are one line. */
  | { readonly kind: "groups"; readonly groups: boolean }
  /** The door made the link: it is shown before anything else is asked. */
  | { readonly kind: "made"; readonly link: MadeLink }
  /** The door revoked the code of this row. */
  | { readonly kind: "revoked"; readonly id: string }
  | { readonly kind: "removed" }
  | { readonly kind: "signedOutWeb"; readonly ended: number }
  /** The clipboard answered the copy of the link. */
  | { readonly kind: "copied"; readonly took: boolean }
  /** The act on its way is over: taken, or refused with a word. */
  | { readonly kind: "answered"; readonly answer: GatedAnswer }
  | GatedDialogEvent;

export interface DevicesStepped {
  readonly state: DevicesState;
  /** The verb to send now, once; `null` where the event sends nothing. */
  readonly run: GatedRun<DevicesAct> | null;
  /** What else the event asks of the door, with no factor before it: both lists again, or the link on show copied. */
  readonly then: "read" | "copy" | null;
}

export const DEVICES_START: DevicesState = {
  list: { at: "loading" },
  codes: [],
  groups: false,
  name: "",
  made: null,
  question: null,
  problem: null,
  told: null,
  gate: GATED_IDLE,
};

const stays = (state: DevicesState): DevicesStepped => ({ state, run: null, then: null });

/** This device first, then every other by itself; where the server groups them, the other plain browser sessions as one line. */
export function devicesListed(sessions: readonly DeviceSession[], groups: boolean): DevicesListed {
  const current = sessions.find((session) => session.current);
  const others = sessions.filter((session) => !session.current);
  const grouped = groups ? others.filter((session) => session.plainWeb) : [];
  const alone = groups ? others.filter((session) => !session.plainWeb) : others;
  const latest = grouped[0];
  return {
    devices: current === undefined ? alone : [current, ...alone],
    webGroup: latest === undefined ? null : { count: grouped.length, seen: latest.seen },
  };
}

/** A removal may be asked about only what is listed, and never about this device. */
function askable(state: DevicesState, question: DevicesQuestion): boolean {
  if (state.list.at !== "read") return false;
  const { devices, webGroup } = devicesListed(state.list.sessions, state.groups);
  return question.kind === "signOutWeb"
    ? webGroup !== null
    : devices.some((device) => device.id === question.id && !device.current);
}

/** A question stands only while what it asks about is still listed. */
const questionKept = (state: DevicesState): DevicesState =>
  state.question !== null && !askable(state, state.question) ? { ...state, question: null } : state;

/** A read's answer, applied. A read is never parked: a door that asks the factor for it is refused. */
function listsRead(state: DevicesState, answer: Answer<DevicesLists>): DevicesState {
  if (answer.ok) {
    const { sessions, codes } = answer.value;
    return questionKept({ ...state, list: { at: "read", sessions }, codes });
  }
  const why: GatedRefusal = "said" in answer ? { word: "said", said: answer.said } : { word: "sign_in" };
  // A read that failed is never an empty list: what was read before stays, and with nothing read it failed.
  const list = state.list.at === "read" ? state.list : ({ at: "failed" } as const);
  return { ...state, list, problem: { with: "read", why } };
}

/**
 * A verb is tried through the machine: a second one while one is on its way, or its factor asked, is not taken.
 * Every send starts clean: what the last verb left to say is no longer what is said.
 */
function tried(state: DevicesState, act: DevicesAct, taken: Partial<DevicesState> = {}): DevicesStepped {
  const next = gatedStep(state.gate, { kind: "try", act });
  if (next.run === null) return stays(state);
  return {
    state: { ...state, ...taken, problem: null, told: null, gate: next.state },
    run: next.run,
    then: null,
  };
}

/** A press, applied. */
function pressed(state: DevicesState, press: DevicesPress): DevicesStepped {
  switch (press.kind) {
    case "type":
      return stays({ ...state, name: press.name });
    case "add":
      // One link at a time: while one is on show, the next waits for Done.
      return state.made === null ? tried(state, { kind: "add", name: state.name.trim() }) : stays(state);
    case "copy": {
      if (state.made === null) return stays(state);
      // A new copy starts clean of the last one: "copied" and "could not be copied" never stand together.
      const problem = state.problem?.with === "copy" ? null : state.problem;
      return { state: { ...state, problem, told: null }, run: null, then: "copy" };
    }
    case "done":
      // The link leaves memory, and the lists are read again: the code was most likely just used.
      return state.made === null
        ? stays(state)
        : { state: { ...state, made: null, told: null }, run: null, then: "read" };
    case "revokeCode":
      return state.codes.some((code) => code.id === press.id)
        ? tried(state, { kind: "revokeCode", id: press.id })
        : stays(state);
    case "askRemove": {
      const question = { kind: "remove", id: press.id } as const;
      return askable(state, question) ? stays({ ...state, question }) : stays(state);
    }
    case "askSignOutWeb": {
      const question = { kind: "signOutWeb" } as const;
      return askable(state, question) ? stays({ ...state, question }) : stays(state);
    }
    case "confirm":
      // Only the question's own Confirm sends: the question closes as the removal leaves.
      return state.question === null ? stays(state) : tried(state, state.question, { question: null });
    case "dismiss":
      return stays({ ...state, question: null });
    case "retry":
      return state.list.at === "failed"
        ? { state: { ...state, list: { at: "loading" }, problem: null }, run: null, then: "read" }
        : stays(state);
  }
}

/** The machine's own events, applied: the door's answer to the verb on its way, and the dialog's three. */
function gated(state: DevicesState, event: GatedEvent<DevicesAct>): DevicesStepped {
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
export function devicesStep(state: DevicesState, event: DevicesEvent): DevicesStepped {
  switch (event.kind) {
    case "read":
      return stays(listsRead(state, event.answer));
    case "groups":
      return stays(questionKept({ ...state, groups: event.groups }));
    case "made":
      return stays({ ...state, made: event.link, name: "" });
    case "revoked": {
      // The link on show retires with its row, by the row's own id: revoking an older code takes nothing down.
      const made = state.made !== null && state.made.id === event.id ? null : state.made;
      return stays({ ...state, made, told: { kind: "revoked" } });
    }
    case "removed":
      return stays({ ...state, told: { kind: "removed" } });
    case "signedOutWeb":
      return stays({ ...state, told: { kind: "signedOutWeb", ended: event.ended } });
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
export function devicesModelOf(
  state: DevicesState,
  ask: GatedAsk | null,
  press: (press: DevicesPress) => void,
): DevicesModel {
  const { gate, list } = state;
  return {
    list: list.at === "read" ? { at: "read", ...devicesListed(list.sessions, state.groups) } : list,
    codes: state.codes,
    name: state.name,
    made: state.made,
    working: gate.at === "trying" ? gate.act : null,
    question: state.question,
    problem: state.problem,
    told: state.told,
    nothingRan: gate.nothingRan,
    ask,
    type: (name) => press({ kind: "type", name }),
    add: () => press({ kind: "add" }),
    copy: () => press({ kind: "copy" }),
    done: () => press({ kind: "done" }),
    revokeCode: (id) => press({ kind: "revokeCode", id }),
    askRemove: (id) => press({ kind: "askRemove", id }),
    askSignOutWeb: () => press({ kind: "askSignOutWeb" }),
    confirm: () => press({ kind: "confirm" }),
    dismiss: () => press({ kind: "dismiss" }),
    retry: () => press({ kind: "retry" }),
  };
}
