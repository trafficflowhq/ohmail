import type { AccountState, GatedAsk } from "../contract.js";
import type { Enrolled, SecurityModel } from "./model.js";

/**
 * What the states show that no source file may hold: the codes and the key the pictures draw, and the sentence a
 * failed read says. The page that draws the states hands them in.
 */
export interface SecurityShown {
  readonly codes: readonly string[];
  readonly key: string;
  readonly failed: string;
}

const nothing = (): void => {};
const VERBS = {
  askNewCodes: nothing,
  confirmNewCodes: nothing,
  cancelNewCodes: nothing,
  codesDone: nothing,
  startAuthenticator: nothing,
  typeCode: nothing,
  activate: nothing,
  cancelAuthenticator: nothing,
  removeAuthenticator: nothing,
} satisfies Partial<SecurityModel>;
const ASKED: GatedAsk = { onVerified: nothing, onCancel: nothing, onDiscarded: nothing };

/** A passkey and unused codes, no authenticator: the account the pictures draw at rest. */
const AT_REST: Enrolled = { passkey: true, authenticator: false, recoveryCodes: true };
const WITH_BOTH: Enrolled = { passkey: true, authenticator: true, recoveryCodes: true };

type Data = Omit<SecurityModel, keyof typeof VERBS>;
const REST: Data = {
  enrolled: { at: "read", ...AT_REST },
  codes: { at: "rest" },
  authenticator: { at: "rest" },
  working: null,
  problem: null,
  nothingRan: false,
  ask: null,
};
const state = (address: string | null, over: Partial<Data> = {}): AccountState<SecurityModel> => ({
  address,
  model: { ...REST, ...over, ...VERBS },
});

/**
 * The pane's states. The design draws eight: at rest, the fresh codes, a new authenticator (twice: with its picture
 * to scan and with its key), no unused codes, an authenticator that is on, the factor asked over the pane, and the
 * window that closed. The others no picture draws: the shipped pane's own, and the fresh codes and a new
 * authenticator's key, each over a read that failed after it was made.
 */
export function securityStates(shown: SecurityShown) {
  const key = { at: "key", key: shown.key, code: "" } as const;
  return {
    rest: state("screen=settings&sec=security"),
    codes: state("screen=settings&sec=security&state=codes", { codes: { at: "shown", codes: shown.codes } }),
    authenticator: state("screen=settings&sec=security&state=totp", { authenticator: key }),
    authenticatorKey: state("screen=settings&sec=security&state=totpkey", { authenticator: key }),
    noCodes: state("screen=settings&sec=security&state=nocodes", {
      enrolled: { at: "read", ...WITH_BOTH, recoveryCodes: false },
    }),
    authenticatorOn: state("screen=settings&sec=security&state=totpon", {
      enrolled: { at: "read", ...WITH_BOTH },
    }),
    factor: state("ask=factor&screen=settings&sec=security", { ask: ASKED }),
    windowClosed: state("note=window&screen=settings&sec=security", {
      problem: { with: "newCodes", why: { word: "sign_in" } },
    }),
    loading: state(null, { enrolled: { at: "loading" } }),
    unread: state(null, { enrolled: { at: "failed", why: { word: "said", said: shown.failed } } }),
    codesUnread: state(null, {
      enrolled: { at: "failed", why: { word: "said", said: shown.failed } },
      codes: { at: "shown", codes: shown.codes },
    }),
    keyUnread: state(null, {
      enrolled: { at: "failed", why: { word: "said", said: shown.failed } },
      authenticator: key,
    }),
    asked: state(null, { codes: { at: "asked" } }),
    working: state(null, { working: "newCodes" }),
    codeRefused: state(null, {
      authenticator: { ...key, code: "000000" },
      problem: { with: "activate", why: { word: "said", said: shown.failed } },
    }),
    nothingRan: state(null, { nothingRan: true }),
  } as const satisfies Record<string, AccountState<SecurityModel>>;
}
