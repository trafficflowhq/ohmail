import type { AccountState, GatedAsk } from "../contract.js";
import type { AccountBody, AccountModel } from "./model.js";
import type { PasswordModel } from "./password.js";

const nothing = (): void => {};
const ASKED: GatedAsk = { onVerified: nothing, onCancel: nothing, onDiscarded: nothing };

type FormData = Omit<PasswordModel, "change">;
const FORM_REST: FormData = {
  sending: false,
  refusal: null,
  changed: null,
  nothingChanged: false,
  ask: null,
};
const form = (address: string | null, over: Partial<FormData> = {}): AccountState<PasswordModel> => ({
  address,
  model: { ...FORM_REST, ...over, change: nothing },
});
const pw = (state: string): string => `screen=settings&sec=account&state=${state}`;

/**
 * The password form's states. The design draws fifteen, each over the Account pane: the form open, a new one that
 * is too short, the factor asked over it, and the twelve rows of what a change can come to. The three without an
 * address are the shipped form's own. Every state is drawn with empty blanks: each attempt empties them.
 */
export const PASSWORD_STATES = {
  rest: form(pw("password")),
  tooShort: form(pw("refused"), { refusal: { word: "tooShort" } }),
  factor: form("ask=factor&for=password&screen=settings&sec=account&state=password", { ask: ASKED }),
  wrong: form(pw("pwwrong"), { refusal: { word: "wrong_current" } }),
  tooLong: form(pw("pwlong"), { refusal: { word: "tooLong" } }),
  same: form(pw("pwsame"), { refusal: { word: "same" } }),
  locked: form(pw("pwlocked"), { refusal: { word: "locked", minutes: 14 } }),
  slowed: form(pw("pwslowed"), { refusal: { word: "slowed" } }),
  conflict: form(pw("pwconflict"), { refusal: { word: "conflict" } }),
  refused: form(pw("pwrefused"), { refusal: { word: "refused" } }),
  cancelled: form(pw("pwcancelled"), { nothingChanged: true }),
  working: form(pw("pwworking"), { sending: true }),
  done: form(pw("pwdone"), { changed: { ended: 2 } }),
  doneOne: form(pw("pwdone1"), { changed: { ended: 1 } }),
  doneNone: form(pw("pwdone0"), { changed: { ended: 0 } }),
  needCurrent: form(null, { refusal: { word: "needCurrent" } }),
  mismatch: form(null, { refusal: { word: "mismatch" } }),
  windowClosed: form(null, { refusal: { word: "sign_in" } }),
} as const satisfies Record<string, AccountState<PasswordModel>>;

/** What the Account pane is drawn from: its own model, the password form's, and whether the form stands open. */
export interface AccountDrawn {
  readonly account: AccountModel;
  readonly password: PasswordModel;
  readonly formOpen: boolean;
}

/** What the states show that no source file holds: the address that is signed in, and a failed read's sentence. */
export interface AccountShown {
  readonly address: string;
  readonly failed: string;
}

type PaneState = AccountState<AccountDrawn, AccountBody>;
type SessionData = Pick<AccountModel, "who" | "asked" | "signingOut" | "stayed">;
const VERBS = {
  signOut: nothing,
  confirmSignOut: nothing,
  cancelSignOut: nothing,
  toErase: nothing,
  toSignIn: nothing,
} satisfies Partial<AccountModel>;

/**
 * The Account pane's states. Beside the password form's fifteen the design draws the pane at rest, the three ways
 * a sign-out can end (the mail still here; a browser that will not say; a server that refused, which the shipped
 * pane leaves on, so it stands as "on its way"), and the sign-out alone, asked for first. The others are the
 * shipped pane's own. A state of the password form is drawn open, unless its change landed: that closes it.
 */
export function accountPaneStates(shown: AccountShown) {
  const signedIn: SessionData = {
    who: { at: "signedIn", address: shown.address },
    asked: false,
    signingOut: false,
    stayed: null,
  };
  const pane = (
    address: string | null,
    session: Partial<SessionData> = {},
    password: PasswordModel = PASSWORD_STATES.rest.model,
    formOpen = false,
  ): PaneState => ({
    address,
    model: { account: { ...signedIn, ...session, ...VERBS }, password, formOpen },
  });
  const alone = (address: string | null, session: Partial<SessionData> = {}): PaneState => ({
    ...pane(address, { who: { at: "unasked" }, ...session }),
    body: "signOutOnly",
  });
  const withForm = Object.fromEntries(
    Object.entries(PASSWORD_STATES).map(([name, state]) => [
      `password${name.charAt(0).toUpperCase()}${name.slice(1)}`,
      pane(state.address, {}, state.model, state.model.changed === null),
    ]),
  ) as { readonly [K in keyof typeof PASSWORD_STATES as `password${Capitalize<K>}`]: PaneState };
  return {
    rest: pane("screen=settings&sec=account"),
    ...withForm,
    blocked: pane("gate=blocked&screen=settings&sec=account", { stayed: "blocked" }),
    unverified: pane("gate=unverified&screen=settings&sec=account", { stayed: "unverified" }),
    serverRefused: pane("gate=refused&screen=settings&sec=account", { signingOut: true }),
    aloneAsked: alone("device=phone&nat=hostsignout&screen=settings&sec=account", { asked: true }),
    alone: alone(null),
    loading: pane(null, { who: { at: "loading" } }),
    unread: pane(null, { who: { at: "failed", said: shown.failed } }),
    signedOut: pane(null, { who: { at: "signedOut" } }),
    signingOut: pane(null, { signingOut: true }),
  } as const satisfies Record<string, PaneState>;
}
