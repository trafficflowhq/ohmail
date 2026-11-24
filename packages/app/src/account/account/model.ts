/**
 * Settings › Account, as data: which address is signed in, sign this browser out, and the way to the page that
 * deletes the account. The pane draws an {@link AccountModel} and reaches nothing; its hook reaches the session
 * through an {@link AccountDoor}. The password form beside it has its own door (`./password.ts`).
 *
 * Sign-out is not gated, on purpose: it destroys nothing a sign-in does not bring back, and a factor in front of
 * "get me off this machine" is backwards on the shared computer it exists for. The erase is not in the pane: its
 * one verb leaves for the delete page, which asks the factor on every press.
 */
import type { AccountWord, Answer, SignOutOutcome } from "../contract.js";

/** How a host reaches the session this pane is about. */
interface AccountIdentity {
  readonly address: string;
  readonly displayName?: string;
}

export interface AccountDoor {
  /** Which address is signed in on this browser. */
  who(): Promise<Answer<AccountIdentity, AccountWord>>;
  /**
   * Signs this browser out: the session is ended at the server and this browser's copy of the mail is wiped. `left`:
   * the door has left by a full load. `opened`: this host has opened the confirmation. `blocked`: the copy is still here, so it stays. `unverified`: this browser
   * will not say what it holds, so it stays.
   */
  signOut(): Promise<SignOutOutcome>;
  /** Leaves for the page that deletes the account, by a full load. */
  toErase(): void;
  /** Leaves for the sign-in page. */
  toSignIn(): void;
}

/** The pane whole, or its sign-out alone: what a host's answer about the account asks for. */
export type AccountBody = "pane" | "signOutOnly";

/** What the pane draws. */
export interface AccountModel {
  /**
   * Who is signed in: asked, a read that failed (its reason, no remedy), nobody, or the address. `unasked`: the
   * body that draws the sign-out alone asks nobody.
   */
  readonly who:
    | { readonly at: "unasked" }
    | { readonly at: "loading" }
    | { readonly at: "failed"; readonly said: string }
    | { readonly at: "signedOut" }
    | ({ readonly at: "signedIn" } & AccountIdentity);
  /** The sign-out alone is asked for before it runs: the question stands. The whole pane never asks. */
  readonly asked: boolean;
  /** The sign-out is on its way. */
  readonly signingOut: boolean;
  /** Why the last sign-out stayed on the page. */
  readonly stayed: Exclude<SignOutOutcome, "left" | "opened"> | null;
  /** The press. On the whole pane it signs out; where the sign-out stands alone it asks first. */
  signOut(): void;
  /** The question's own Confirm. */
  confirmSignOut(): void;
  cancelSignOut(): void;
  toErase(): void;
  toSignIn(): void;
}

/** The pane's state: its model without the verbs. */
export type AccountPaneState = Pick<AccountModel, "who" | "asked" | "signingOut" | "stayed">;

export type AccountEvent =
  /** The door answered who is signed in. */
  | { readonly kind: "who"; readonly answer: Answer<AccountIdentity, AccountWord> }
  /** The press on Sign out. */
  | { readonly kind: "signOut" }
  | { readonly kind: "confirmSignOut" }
  | { readonly kind: "cancelSignOut" }
  /** The door said how the sign-out ended. */
  | { readonly kind: "signedOut"; readonly outcome: SignOutOutcome };

export interface AccountStepped {
  readonly state: AccountPaneState;
  /** Whether the sign-out is to be sent now, once. */
  readonly signOut: boolean;
}

/** Where a body starts: the whole pane asks who is signed in as it opens, the sign-out alone asks nobody. */
export const accountStart = (body: AccountBody): AccountPaneState => ({
  who: { at: body === "pane" ? "loading" : "unasked" },
  asked: false,
  signingOut: false,
  stayed: null,
});

const stays = (state: AccountPaneState): AccountStepped => ({ state, signOut: false });
const leaves = (state: AccountPaneState): AccountStepped => ({
  state: { ...state, asked: false, signingOut: true, stayed: null },
  signOut: true,
});

/** A read's answer as what the pane draws. Any refusal that names signing in as the remedy is nobody signed in. */
function whoOf(answer: Answer<AccountIdentity, AccountWord>): AccountPaneState["who"] {
  if (answer.ok) {
    const { address, displayName } = answer.value;
    return { at: "signedIn", address, ...(displayName === undefined ? {} : { displayName }) };
  }
  if ("said" in answer) return { at: "failed", said: answer.said };
  return { at: "signedOut" };
}

/**
 * One event, applied. The whole pane's press signs out at once: no question and no factor stand before it. The
 * sign-out that stands alone is asked for first, and only the question's own Confirm sends it. One sign-out at a
 * time; one that left stays "on its way" until the page is gone.
 */
export function accountStep(body: AccountBody, state: AccountPaneState, event: AccountEvent): AccountStepped {
  switch (event.kind) {
    case "who":
      return stays({ ...state, who: whoOf(event.answer) });
    case "signOut":
      if (state.signingOut) return stays(state);
      return body === "signOutOnly" ? stays({ ...state, asked: true }) : leaves(state);
    case "confirmSignOut":
      return state.asked && !state.signingOut ? leaves(state) : stays(state);
    case "cancelSignOut":
      return state.asked ? stays({ ...state, asked: false }) : stays(state);
    case "signedOut":
      return event.outcome === "left"
        ? stays(state)
        : stays({ ...state, signingOut: false, stayed: event.outcome === "opened" ? null : event.outcome });
  }
}
