import type { AccountState, GatedAsk } from "../contract.js";
import type { InvitesModel, MadeInvite, OpenInvite } from "./model.js";

/**
 * What the states show that no source file may hold: the open invite the pictures list, its days as the reader
 * says them; the invite link on show; and the sentence a refusal says. The page that draws the states hands them
 * in.
 */
export interface InvitesShown {
  readonly invite: OpenInvite;
  /** The link on show, made for that invite. */
  readonly link: string;
  readonly failed: string;
}

const nothing = (): void => {};
const VERBS = {
  type: nothing,
  make: nothing,
  copy: nothing,
  done: nothing,
  revoke: nothing,
} satisfies Partial<InvitesModel>;
const ASKED: GatedAsk = { onVerified: nothing, onCancel: nothing, onDiscarded: nothing };

type Data = Omit<InvitesModel, keyof typeof VERBS>;
type State = AccountState<InvitesModel>;

const REST: Data = {
  invites: [],
  name: "",
  made: null,
  working: null,
  problem: null,
  told: null,
  nothingRan: false,
  ask: null,
};
const state = (address: string | null, over: Partial<Data> = {}): State => ({
  address,
  model: { ...REST, ...over, ...VERBS },
});

/**
 * The pane's states. The design draws four: at rest with no invite open, a link on show (and its copy refused),
 * and the factor's dialog over the pane. The others are the shipped pane's own, which no picture draws.
 */
export function invitesStates(shown: InvitesShown) {
  const made: MadeInvite = { link: shown.link, name: shown.invite.name ?? "" };
  // After a link is made the list is read again: its invite stands under it, with its way back.
  const onShow = { made, invites: [shown.invite] };
  const refused = { word: "said", said: shown.failed } as const;
  return {
    rest: state("screen=settings&sec=invites"),
    made: state("screen=settings&sec=invites&state=made", onShow),
    madeNotCopied: state("copy=failed&screen=settings&sec=invites&state=made", {
      ...onShow,
      problem: { with: "copy" },
    }),
    factor: state("ask=factor&screen=settings&sec=invites", { ask: ASKED }),
    open: state(null, { invites: [shown.invite] }),
    unread: state(null, { invites: null, problem: { with: "read", why: refused } }),
    working: state(null, { working: { kind: "make", name: "" } }),
    copied: state(null, { ...onShow, told: { kind: "copied" } }),
    revoked: state(null, { told: { kind: "revoked" } }),
    windowClosed: state(null, { problem: { with: "make", why: { word: "sign_in" } } }),
    refused: state(null, { invites: [shown.invite], problem: { with: "revoke", why: refused } }),
    nothingRan: state(null, { nothingRan: true }),
  } as const satisfies Record<string, State>;
}
