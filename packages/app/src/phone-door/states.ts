/**
 * THE WAYS IN'S STATES. Two total tables, each held by the compiler: what the page says of each session native tells
 * (`SESSION_SAYS`, keyed by every member of the door's closed list), and what the page draws at each state of the
 * reference (`screen=phonedoor&state=…`, and the phone's own steps of `screen=onboarding`): the step, its phase, the
 * refusal it says and what of native's word it reads (`PHONE_DOOR_STATE_DATA`). A state missing from either, or one
 * too many, does not compile. The tables hold codes and steps, never a person's data: the states page brings its own.
 */
import type { PhoneDoor, PhoneDoorConfig, PhoneDoorState, PhonePairFacts, SaidRefusal } from "./contract.js";

/** The steps of the ways in, in the order a person meets them. In memory only: never the route, never storage. */
export const WAY_IN_STEPS = [
  "welcome",
  "server",
  "computer",
  "terms",
  "mailbox",
  "scan",
  "hand",
  "confirm",
  "mirror",
] as const;
export type WayInStep = (typeof WAY_IN_STEPS)[number];

/** What a session adds to the ways in: only a connect in flight says something of its own (the store's upgrade). */
export const SESSION_SAYS = {
  none: null,
  opening: "opening",
  live: null,
  refused: null,
  ended: null,
} as const satisfies { readonly [S in PhoneDoorState["session"]]: "opening" | null };

/** How long a store's upgrade runs before its second line joins. */
export const UPGRADE_SLOW_MS = 5000;

/** The upgrade's line, as keys of `phoneDoor.upgrade`: its sentence with its count, and the second line once slow. */
export interface UpgradeLine {
  readonly key: "migrating" | "migratingOf";
  readonly values: { readonly applied: number; readonly pending: number };
  readonly slow: boolean;
}

/** What the ways in say of the door's state now: the upgrade's line while a connect waits on it, else nothing. */
export function upgradeOf(state: PhoneDoorState, now: number): UpgradeLine | null {
  if (SESSION_SAYS[state.session] !== "opening" || state.migrating === null) return null;
  const { applied, pending, since } = state.migrating;
  return {
    key: pending > 0 ? "migratingOf" : "migrating",
    values: { applied, pending },
    slow: now - since >= UPGRADE_SLOW_MS,
  };
}

/** What a step stands in, inside the step: the server asked, answered; the camera off; the press sent. */
export type Phase = "checking" | "reached" | "reachedApi" | "cameraOff" | "byHand" | "opening" | "pairing";

/**
 * WHERE THE WAYS IN STAND, AND WHERE THEY OPEN: a step, its phase, the refusal it says, the address as typed, and on
 * Confirm what answered under its ticket. It is the page's own memory, never the route and never storage, and it
 * never holds a typed pairing code or a password.
 */
export interface WayInSeed {
  readonly step: WayInStep;
  readonly phase?: Phase;
  readonly said?: SaidRefusal;
  /** The server's address as typed, or as it answered. */
  readonly address?: string;
  /** The answer's own address of where the mail API answers, where it is not the address itself. */
  readonly apiUnder?: string | null;
  readonly offer?: { readonly ticket: string; readonly facts: PhonePairFacts };
}

/** What every step is handed: the door, where it stands, and the two ways on. */
export interface StepProps {
  readonly door: PhoneDoor;
  readonly seed: WayInSeed;
  /** On to another step; `replace` leaves no way back to this one (a ticket spent, a mailbox opened). */
  to(next: WayInSeed, how?: { readonly replace: true }): void;
  /** Back to the step this one was opened from; at the first step, to the door's list of servers. */
  back(): void;
}

/** A refusal said by the step itself; `form` is the one connect form's, said by the form. */
export interface StateData {
  readonly step: WayInStep;
  readonly phase?: Phase;
  readonly said?: SaidRefusal;
  /** A refused open as the form is told it: its code and the server field it is about. */
  readonly form?: {
    readonly code: string;
    readonly field: "imapHost" | "imapPort" | "smtpHost" | "smtpPort" | null;
  };
  /** Confirm: what answered. */
  readonly offers?: "computer" | "server" | "hosted";
  readonly config?: Partial<Pick<PhoneDoorConfig, "os" | "organizes">>;
}

const said = (code: string, ...args: SaidRefusal["args"]): SaidRefusal => ({ code, args });
const why = (code: string): SaidRefusal => said("unreachableWhy", said(code));
const form = (code: string, field: NonNullable<StateData["form"]>["field"] = null): StateData => ({
  step: "mailbox",
  form: { code, field },
});

/** The reference's states of the screen `phonedoor`, by its own ids, in its order (its `also` rows last). */
export const PHONE_DOOR_STATES = [
  "server",
  "checking",
  "reached",
  "reachedapi",
  "notaddress",
  "cleartext",
  "numeric",
  "dns",
  "nothing",
  "timeout",
  "notencrypted",
  "notohmail",
  "nopairing",
  "apinotfound",
  "apistopped",
  "apitimeout",
  "cloudoff",
  "computer",
  "terms",
  "nobuild",
  "form",
  "formhost",
  "opening",
  "refused",
  "apponly",
  "weblogin",
  "imapoff",
  "certname",
  "starttls",
  "noenc",
  "offline",
  "port",
  "already",
  "several",
  "unfinished",
  "notstored",
  "nohost",
  "nosmtphost",
  "smtpport",
  "namerefused",
  "authinvalid",
  "certmatch",
  "certrefused",
  "certuntrusted",
  "certexpired",
  "certearly",
  "imapaway",
  "smtprefused",
  "smtpnoenc",
  "smtpaway",
  "smtpcert",
  "smtpcertname",
  "starttlstimeout",
  "starttlsfailed",
  "nothingstored",
  "othermailbox",
  "removedhere",
  "confirm",
  "confirmserver",
  "confirmcloud",
  "pairing",
  "hand",
  "handrejected",
  "handempty",
  "handaddress",
  "mirror",
  "server&os=ios",
  "computer&os=ios",
  "terms&os=ios",
] as const;
export type PhoneDoorStateId = (typeof PHONE_DOOR_STATES)[number];

/** What each of them draws: a state missing here, or one the reference does not have, does not compile. */
export const PHONE_DOOR_STATE_DATA = {
  server: { step: "server" },
  checking: { step: "server", phase: "checking" },
  reached: { step: "server", phase: "reached" },
  reachedapi: { step: "server", phase: "reachedApi" },
  notaddress: { step: "server", said: said("baseNotAnAddress") },
  cleartext: { step: "server", said: said("baseCleartext") },
  numeric: { step: "server", said: said("baseNeedsTheCode") },
  dns: { step: "server", said: why("unreachableDns") },
  nothing: { step: "server", said: why("unreachableRefused") },
  timeout: { step: "server", said: why("unreachableTimeout") },
  notencrypted: { step: "server", said: said("notEncrypted") },
  notohmail: { step: "server", said: said("notOhmail") },
  nopairing: { step: "server", said: said("noPairing") },
  apinotfound: { step: "server", said: said("baseApiNotFound") },
  apistopped: { step: "server", said: said("baseApiStopped") },
  apitimeout: { step: "server", said: said("baseApiTimeout") },
  cloudoff: { step: "server", said: said("managedDeferred") },
  computer: { step: "computer" },
  terms: { step: "terms" },
  nobuild: { step: "terms", config: { organizes: "withheld" } },
  form: { step: "mailbox" },
  formhost: { step: "mailbox" },
  opening: { step: "mailbox", phase: "opening" },
  refused: form("standaloneSignInRefused"),
  apponly: form("standaloneAuthAppOnly"),
  weblogin: form("standaloneAuthWebLogin"),
  imapoff: form("standaloneAuthImapDisabled"),
  certname: form("standaloneCertificateName", "imapHost"),
  starttls: form("standaloneStarttlsInjected", "imapHost"),
  noenc: form("standaloneNoEncryption", "imapPort"),
  offline: form("standaloneOffline"),
  port: form("standaloneNoPort", "imapPort"),
  already: form("standaloneAlreadyOpen"),
  several: form("standaloneSeveralMailboxes"),
  unfinished: form("standaloneRemovalUnfinished"),
  notstored: form("standaloneNotStored"),
  nohost: form("standaloneNoHost", "imapHost"),
  nosmtphost: form("standaloneNoSmtpHost", "smtpHost"),
  smtpport: form("standaloneNoSmtpPort", "smtpPort"),
  namerefused: form("standaloneNameRefused"),
  authinvalid: form("standaloneAuthInvalid"),
  certmatch: form("standaloneCertificateName", "imapHost"),
  certrefused: form("standaloneCertificateRefused", "imapHost"),
  certuntrusted: form("standaloneCertificateUntrusted", "imapHost"),
  certexpired: form("standaloneCertificateExpired", "imapHost"),
  certearly: form("standaloneCertificateNotYetValid", "imapHost"),
  imapaway: form("standaloneImapUnreachable", "imapHost"),
  smtprefused: form("standaloneSmtpSignInRefused", "smtpHost"),
  smtpnoenc: form("standaloneSmtpNoEncryption", "smtpPort"),
  smtpaway: form("standaloneSmtpUnreachable", "smtpHost"),
  smtpcert: form("standaloneSmtpCertificateRefused", "smtpHost"),
  smtpcertname: form("standaloneSmtpCertificateName", "smtpHost"),
  starttlstimeout: form("standaloneStarttlsTimeout", "imapHost"),
  starttlsfailed: form("standaloneStarttlsFailed", "imapHost"),
  nothingstored: form("standaloneNoSealedCredential"),
  othermailbox: form("standaloneOtherMailbox"),
  removedhere: form("standaloneMailboxRemoved"),
  confirm: { step: "confirm", offers: "computer" },
  confirmserver: { step: "confirm", offers: "server" },
  confirmcloud: { step: "confirm", offers: "hosted" },
  pairing: { step: "confirm", offers: "computer", phase: "pairing" },
  hand: { step: "hand" },
  handrejected: { step: "hand", said: said("pairCodeRejected") },
  handempty: { step: "hand", said: said("pairEmptyToken") },
  handaddress: { step: "hand", said: said("pairBadAddress") },
  mirror: { step: "mirror" },
  "server&os=ios": { step: "server", config: { os: "ios" } },
  "computer&os=ios": { step: "computer", config: { os: "ios" } },
  "terms&os=ios": { step: "terms", config: { os: "ios" } },
} as const satisfies { readonly [Id in PhoneDoorStateId]: StateData };

/** The phone's own steps of the reference's `screen=onboarding`: the first screen, and the scan with its states. */
export const ONBOARDING_PHONE_STATES = ["welcome", "scan", "camera", "hand", "refused"] as const;
export type OnboardingPhoneStateId = (typeof ONBOARDING_PHONE_STATES)[number];
export const ONBOARDING_PHONE_STATE_DATA = {
  welcome: { step: "welcome" },
  scan: { step: "scan" },
  camera: { step: "scan", phase: "cameraOff" },
  hand: { step: "scan", phase: "byHand" },
  refused: { step: "scan", phase: "byHand", said: said("pairCodeRejected") },
} as const satisfies { readonly [Id in OnboardingPhoneStateId]: StateData };
