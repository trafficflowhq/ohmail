import type { AccountState, GatedAsk } from "../contract.js";
import {
  devicesListed,
  type DeviceSession,
  type DevicesModel,
  type MadeLink,
  type PairingCode,
} from "./model.js";

/**
 * What the states show that no source file may hold: the devices and the code the pictures list, their days as the
 * reader says them; the pairing link on show; and the sentence a refusal says. The page that draws the states hands
 * them in.
 */
export interface DevicesShown {
  /** The sessions signed in, as one read answers them. The other plain browser ones are drawn as one line. */
  readonly sessions: readonly DeviceSession[];
  /** The code not used yet. */
  readonly code: PairingCode;
  /** The link on show, made for that code. */
  readonly link: string;
  readonly failed: string;
}

const nothing = (): void => {};
const VERBS = {
  type: nothing,
  add: nothing,
  copy: nothing,
  done: nothing,
  revokeCode: nothing,
  askRemove: nothing,
  askSignOutWeb: nothing,
  confirm: nothing,
  dismiss: nothing,
  retry: nothing,
} satisfies Partial<DevicesModel>;
const ASKED: GatedAsk = { onVerified: nothing, onCancel: nothing, onDiscarded: nothing };

/**
 * The factor's dialog over the pane, by the dialog's own part of each address: its three ways and what each can be
 * refused with. Those states are the dialog's; the pane under every one of them is the same, a verb parked.
 */
const FACTOR_OVER = {
  factor: "",
  factorCode: "how=code&",
  factorRecovery: "how=recovery&",
  factorBadCode: "err=code&how=code&",
  factorBadPasskey: "err=passkey&",
  factorBadRecovery: "err=recovery&how=recovery&",
  factorLocked: "err=locked&how=code&",
  factorSlowed: "err=slowed&how=code&",
  factorRefused: "err=refused&",
  factorLost: "err=lost&",
  factorPendingOut: "err=pendingout&",
  factorMismatch: "err=mismatch&",
  factorUnchecked: "err=unchecked&",
} as const;

type Data = Omit<DevicesModel, keyof typeof VERBS>;
type State = AccountState<DevicesModel>;

/**
 * The pane's states. The design draws twenty: at rest, a link on show (and its copy refused), a code not used, the
 * list being read and a read that failed, nothing ran, and the factor's dialog over the pane thirteen times. The
 * others are the shipped pane's own, which no picture draws.
 */
export function devicesStates(shown: DevicesShown) {
  const rest: Data = {
    list: { at: "read", ...devicesListed(shown.sessions, true) },
    codes: [],
    name: "",
    made: null,
    working: null,
    question: null,
    problem: null,
    told: null,
    nothingRan: false,
    ask: null,
  };
  const state = (address: string | null, over: Partial<Data> = {}): State => ({
    address,
    model: { ...rest, ...over, ...VERBS },
  });
  const made: MadeLink = { id: shown.code.id, link: shown.link, name: shown.code.name ?? "" };
  // After a link is made the lists are read again: its code stands under it, with its way back.
  const onShow = { made, codes: [shown.code] };
  const other = shown.sessions.find((session) => !session.current && !session.plainWeb);
  const factors = Object.fromEntries(
    Object.entries(FACTOR_OVER).map(([name, dialog]) => [
      name,
      state(`ask=factor&${dialog}screen=settings&sec=devices`, { ask: ASKED }),
    ]),
  ) as Record<keyof typeof FACTOR_OVER, State>;
  return {
    rest: state("screen=settings&sec=devices"),
    pair: state("screen=settings&sec=devices&state=pair", onShow),
    pairNotCopied: state("copy=failed&screen=settings&sec=devices&state=pair", {
      ...onShow,
      problem: { with: "copy" },
    }),
    codes: state("screen=settings&sec=devices&state=codes", { codes: [shown.code] }),
    loading: state("screen=settings&sec=devices&state=dvloading", { list: { at: "loading" } }),
    failed: state("screen=settings&sec=devices&state=dvfailed", {
      list: { at: "failed" },
      problem: { with: "read", why: { word: "said", said: shown.failed } },
    }),
    nothingRan: state("note=nothing&screen=settings&sec=devices", { nothingRan: true }),
    ...factors,
    working: state(null, { working: { kind: "add", name: "" } }),
    copied: state(null, { ...onShow, told: { kind: "copied" } }),
    revoked: state(null, { told: { kind: "revoked" } }),
    removed: state(null, { told: { kind: "removed" } }),
    signedOutWeb: state(null, { told: { kind: "signedOutWeb", ended: 2 } }),
    asked: state(null, { question: other === undefined ? null : { kind: "remove", id: other.id } }),
    askedWeb: state(null, { question: { kind: "signOutWeb" } }),
    windowClosed: state(null, { problem: { with: "add", why: { word: "sign_in" } } }),
    refused: state(null, { problem: { with: "revokeCode", why: { word: "said", said: shown.failed } } }),
    notReadAgain: state(null, { problem: { with: "read", why: { word: "said", said: shown.failed } } }),
  } as const satisfies Record<string, State>;
}
