/**
 * THE PHONE'S LIST OF SERVERS, AS ITS PAGE SEES THE DOOR. The door's page (the shell's second start page on a phone)
 * hands this page what native last said and the door's requests for the list, and nothing else: no engine, no store,
 * no scope. The shapes below are this folder's own copies of the door's (`apps/mobile/src/shell/door-kinds.ts`),
 * since this package never imports the phone app; the door page's `pages.tsx` holds the two equal at compile time.
 *
 * THE PAGE KEEPS NO ROW OF ITS OWN. It draws the last state native told; what a forget could not take back is
 * native's to hold (`after`), because the forget rebuilds the page.
 */
import type { SaidRefusal } from "@ohmail/app-logic/phone/said";
import type { SettingsAtRisk } from "@ohmail/app-logic/phone/stop-and-remove";
import type { BackSignal, Signal } from "../host/index.js";

export type { SaidRefusal } from "@ohmail/app-logic/phone/said";

/** One row of this phone's list. */
export interface ServersRow {
  readonly id: string;
  readonly kind: "hosted" | "server" | "computer" | "own";
  /** The server's address; empty for this phone's own mailbox, whose address nothing dials. */
  readonly address: string;
  /** The account the server named, as a label; null for this phone's own mailbox and for an ended pairing. */
  readonly account: string | null;
  /** The row this phone opens at its next start. */
  readonly open: boolean;
  /** Its credential is gone: one scan pairs it again. */
  readonly needsPair: boolean;
}

/** A store's upgrade under a connect, where there is a count to say. */
export interface ServersMigrating {
  readonly applied: number;
  readonly pending: number;
  readonly since: number;
}

/** The connection as native last told it. */
export interface ServersState {
  readonly session: "none" | "opening" | "live" | "refused" | "ended";
  readonly migrating: ServersMigrating | null;
  /** Why the session was refused or ended. */
  readonly said: SaidRefusal | null;
  /** The row the session stands on, or null with none. */
  readonly openId: string | null;
  readonly syncing: boolean;
  /** What the last sync round failed on; null where a handshake stopped it. */
  readonly syncSaid: SaidRefusal | null;
  /** A sync round a handshake stopped, by which of the two it is. */
  readonly syncStopped: "keyChanged" | "certificate" | null;
  readonly pinned: boolean;
  /** Letters on this phone where native can count them; null under the shell, whose page holds the mail. */
  readonly total: number | null;
  readonly paired: readonly ServersRow[];
  /** What the last forget could not take back: it outlives the row it is about. */
  readonly after: SaidRefusal | null;
}

/** What of native's word about this page the list reads: told once. */
export interface ServersConfig {
  readonly app: "ohmail" | "ohcal";
  readonly os: "android" | "ios";
  /** Whether this build can organize a mailbox on the phone itself. Anything but `offered` withholds the way. */
  readonly organizes: "offered" | "withheld";
}

/** A press native answers: only `ok === true` is a yes. */
export type ServersDone = { readonly ok: true } | { readonly ok: false; readonly said: SaidRefusal };

/** What removing a row would drop that is only on this phone. */
export interface ServersForgetAsk {
  readonly drafts: number | null;
  readonly settings: SettingsAtRisk | "none";
}

/** What a forget came to. */
export type ServersForgot =
  /** Everything of it on this phone went; `after` says what did not (a server not told, a claim that stands). */
  | { readonly k: "gone"; readonly after: SaidRefusal | null }
  /** Something of it is still on this phone. */
  | { readonly k: "kept"; readonly said: SaidRefusal }
  /** Nothing was removed: the store holds settings the mailbox does not. Removing is the person's answer. */
  | { readonly k: "asks"; readonly settings: SettingsAtRisk };

/** Where the ways in open from the list: their first screen, or one of their steps. */
export type ServersWayIn = "welcome" | "scan" | "server" | "computer" | "terms";

/**
 * THE DOOR AS THE LIST SEES IT. Every request may reject (the bridge refused it, a deadline passed): the page then
 * draws what native tells next and says no word of the bridge's.
 */
export interface ServersDoor {
  readonly config: ServersConfig;
  readonly state: Signal<ServersState>;
  /** Opens a row's mailbox (`switch`). */
  switchTo(id: string): Promise<ServersDone>;
  /** What removing this row would drop (`forget.ask`). */
  forgetAsk(id: string): Promise<ServersForgetAsk>;
  /** Removes this row and what this phone holds of it (`forget`); `anyway` answers a named settings risk. */
  forget(id: string, anyway: boolean): Promise<ServersForgot>;
  /** A sync round now (`sync`). */
  sync(): void;
  /** The open session ends here; the rows stay (`disconnect`). */
  disconnect(): void;
  /** The way out (`leave`): to the open mailbox, or to one this phone can open again. */
  leave(): void;
  /** The ways in, at their first screen or at one of their steps. */
  waysIn(at: ServersWayIn): void;
  /** The hardware back: newest handler first; true is "taken". */
  readonly back: BackSignal;
}
