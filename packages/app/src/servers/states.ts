/**
 * THE LIST'S STATES: what the page draws at each state of the reference (`screen=servers&state=…`), as what native
 * would have told: the session and why it stands so, the rows by their kind, how the last sync went, what a forget
 * left, and what Stop and remove is asked. A total table, held by the compiler: a state missing, or one too many,
 * does not compile. It holds codes and kinds, never a person's data: the states page brings its own.
 */
import type { SettingsAtRisk } from "@ohmail/app-logic/phone/stop-and-remove";
import type { SaidRefusal, ServersConfig, ServersState } from "./contract.js";

/** The reference's states of the screen `servers`, by its own ids, in its order; `live` is the screen at its address. */
export const SERVERS_STATES = [
  "live",
  "syncing",
  "syncfailed",
  "pinchanged",
  "certrefused",
  "connecting",
  "empty",
  "ended",
  "erased",
  "cleartext",
  "nopin",
  "cannotpin&os=ios",
  "pinnotstored",
  "pinunenforceable",
  "keymismatch",
  "rejected",
  "unreachable",
  "notstored",
  "noname",
  "owed",
  "unknowninstall",
  "purge",
  "own",
  "own&ask=drafts",
  "own&ask=draftsunknown",
  "own&ask=settings",
  "own&ask=newer",
  "own&ask=unsaved",
  "own&ask=unknown",
  "gone1",
  "gone2",
  "gone3",
  "gone4",
  "kept1",
  "kept2",
  "kept3",
  "kept4",
] as const;
export type ServersStateId = (typeof SERVERS_STATES)[number];

/** Which rows the phone holds: the hosted service open and a computer; that pairing ended; this phone's own; none. */
export type ServersRows = "two" | "ended" | "own" | "none";

/** What a state stands for. */
export interface ServersStateData {
  readonly session: ServersState["session"];
  readonly rows: ServersRows;
  readonly said?: SaidRefusal;
  readonly syncing?: true;
  readonly syncSaid?: SaidRefusal;
  readonly syncStopped?: NonNullable<ServersState["syncStopped"]>;
  readonly after?: SaidRefusal;
  /** What removing this phone's own mailbox would drop (`forget.ask`): its dialog is what the state shows. */
  readonly ask?: { readonly drafts: number | null; readonly settings: SettingsAtRisk | "none" };
  /** The removal kept the store for these settings (`forget` answered `asks`): its dialog asks again. */
  readonly kept?: SettingsAtRisk;
  readonly config?: Partial<Pick<ServersConfig, "os">>;
}

const said = (code: string, ...args: SaidRefusal["args"]): SaidRefusal => ({ code, args });
/** What a platform says of a fault, where a sentence keeps a place for it: made up, as native would hand it on. */
const DETAIL = "the keystore did not answer";
const refused = (code: string, ...args: SaidRefusal["args"]): ServersStateData => ({
  session: "refused",
  rows: "none",
  said: said(code, ...args),
});
const left = (code: string, rows: ServersRows = "two", ...args: SaidRefusal["args"]): ServersStateData => ({
  session: rows === "none" ? "none" : "live",
  rows,
  after: said(code, ...args),
});
const asks = (drafts: number | null, settings: SettingsAtRisk | "none"): ServersStateData => ({
  session: "live",
  rows: "own",
  ask: { drafts, settings },
});

/** What each draws: a state missing here, or one the reference does not have, does not compile. */
export const SERVERS_STATE_DATA = {
  live: { session: "live", rows: "two" },
  syncing: { session: "live", rows: "two", syncing: true },
  syncfailed: {
    session: "live",
    rows: "two",
    syncSaid: said("verbatimDetail", "The server did not answer in time."),
  },
  pinchanged: { session: "live", rows: "two", syncStopped: "keyChanged" },
  certrefused: { session: "live", rows: "two", syncStopped: "certificate" },
  connecting: { session: "opening", rows: "two" },
  empty: { session: "none", rows: "none" },
  ended: { session: "ended", rows: "ended", said: said("pairEnded") },
  erased: { session: "ended", rows: "none", said: said("accountErased") },
  cleartext: refused("admitCleartext"),
  nopin: refused("admitNoPin"),
  "cannotpin&os=ios": { ...refused("admitCannotPin"), config: { os: "ios" } },
  pinnotstored: refused("admitPinNotStored"),
  pinunenforceable: refused("admitPinUnenforceable"),
  keymismatch: refused("pairKeyMismatch"),
  rejected: refused("pairCodeRejected"),
  unreachable: refused("pairRedeemUnreachable"),
  notstored: refused("pairNotStoredClosed", DETAIL),
  noname: refused("pairNoAccountName"),
  owed: refused("pairOwedDeletion", DETAIL),
  unknowninstall: refused("serversInstallUnknown", DETAIL),
  purge: refused("serversPurgeRefused", DETAIL),
  own: { session: "live", rows: "own" },
  "own&ask=drafts": asks(2, "none"),
  "own&ask=draftsunknown": asks(null, "none"),
  "own&ask=settings": asks(0, "answer"),
  "own&ask=newer": asks(0, "newer"),
  "own&ask=unsaved": { ...asks(0, "none"), kept: "unsaved" },
  "own&ask=unknown": asks(0, "unknown"),
  gone1: left("forgetServerUnreachable"),
  gone2: left("forgetServerEnded"),
  gone3: left("forgetServerOwed"),
  gone4: left("forgetClaimStands", "none", "4"),
  kept1: left("forgetStillPending"),
  kept2: left("forgetMailRemains", "two", DETAIL),
  kept3: left("forgetKeystoreRefused", "two", DETAIL),
  kept4: left("forgetEngineRemains", "own", DETAIL),
} as const satisfies { readonly [Id in ServersStateId]: ServersStateData };
