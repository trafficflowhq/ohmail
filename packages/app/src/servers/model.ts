/**
 * THE LIST OF SERVERS, READ FROM THE DOOR'S STATE: what stands first (the open session, or why there is none), what
 * this phone is paired with, and the ways to add one. A pure reading of the last state native told and of native's
 * word about this build, so every state the page can be in is a value a test can name; nothing here is held.
 */
import type { SaidRefusal, ServersConfig, ServersRow, ServersState, ServersWayIn } from "./contract.js";

/** A row's name: this phone's own mailbox by the phone's own name, the hosted service by its name, else its address. */
export type ServersName =
  { readonly k: "own" } | { readonly k: "hosted" } | { readonly k: "address"; readonly address: string };

/** A sync that did not go through: stopped by a handshake (which of the two), or failed on what native said. */
export type SyncNote =
  | { readonly k: "stopped"; readonly why: "keyChanged" | "certificate" }
  | { readonly k: "failed"; readonly said: SaidRefusal };

/** The sheet that stands first. */
export type OpenSheet =
  | { readonly k: "none" }
  | { readonly k: "refused"; readonly said: SaidRefusal | null; readonly pairAgain: boolean }
  | {
      readonly k: "session";
      readonly phase: "opening" | "live";
      readonly name: ServersName | null;
      readonly own: boolean;
      readonly syncing: boolean;
      readonly sync: SyncNote | null;
    };

/** One line of the Paired sheet. */
export interface PairedLine {
  readonly id: string;
  readonly name: ServersName;
  readonly own: boolean;
  /** What stands under the name: the account, this phone's own line, or the pairing that ended. */
  readonly value:
    { readonly k: "account"; readonly account: string } | { readonly k: "own" | "ended" | "none" };
  /** The tag after the name: the open row says so; an ended one says nothing; the others say what they are. */
  readonly tag: "open" | ServersRow["kind"] | null;
  readonly pairAgain: boolean;
  /** The row's one verb: a pairing is forgotten, this phone's own mailbox is stopped and removed. */
  readonly verb: "forget" | "stopAndRemove";
}

/** A way to add one, as the first screen asks it. */
export interface ServersWay {
  readonly id: "cloud" | "server" | "computer" | "standalone";
  readonly opens: ServersWayIn;
}

export interface ServersView {
  /** What the last forget could not take back: it stands first, whatever rows there are. */
  readonly after: SaidRefusal | null;
  readonly open: OpenSheet;
  /** The rows, and whether the note under them is the removal's (only this phone's own mailbox is listed). */
  readonly paired: { readonly lines: readonly PairedLine[]; readonly note: "forget" | "remove" } | null;
  /** Nothing paired and nothing to say: the list says so. */
  readonly empty: boolean;
  readonly ways: readonly ServersWay[];
  /** Sync now and Disconnect: only while a session is live. */
  readonly verbs: boolean;
  /** Something on the list wants the person: a refusal, a sync that did not go through, what a forget left. */
  readonly hot: boolean;
}

/** The refusal after which one scan pairs this phone again (native's `isPairEnded`). */
const PAIR_ENDED = "pairEnded";

/** The calendar app never offers a mailbox of its own. */
const OFFERS_A_MAILBOX = { ohmail: true, ohcal: false } as const satisfies {
  readonly [A in ServersConfig["app"]]: boolean;
};

const nameOf = (row: ServersRow): ServersName =>
  row.kind === "own"
    ? { k: "own" }
    : row.kind === "hosted"
      ? { k: "hosted" }
      : { k: "address", address: row.address };

/**
 * The row the session stands on: the open one while live; while a connect is in flight no row is open yet, and the
 * one it opens is the row this phone opens at its start. None while there is no session.
 */
function openRowOf(state: ServersState): ServersRow | undefined {
  if (state.session === "live") return state.paired.find((r) => r.id === state.openId);
  if (state.session === "opening") return state.paired.find((r) => r.open);
  return undefined;
}

function openSheetOf(state: ServersState): OpenSheet {
  if (state.session === "refused" || state.session === "ended")
    return { k: "refused", said: state.said, pairAgain: state.said?.code === PAIR_ENDED };
  if (state.session === "none") return { k: "none" };
  const row = openRowOf(state);
  const sync: SyncNote | null =
    state.syncStopped !== null
      ? { k: "stopped", why: state.syncStopped }
      : state.syncSaid !== null
        ? { k: "failed", said: state.syncSaid }
        : null;
  return {
    k: "session",
    phase: state.session,
    name: row === undefined ? null : nameOf(row),
    own: row?.kind === "own",
    syncing: state.syncing,
    sync: state.session === "live" ? sync : null,
  };
}

function lineOf(row: ServersRow, openId: string | null): PairedLine {
  const own = row.kind === "own";
  return {
    id: row.id,
    name: nameOf(row),
    own,
    value: own
      ? { k: "own" }
      : row.needsPair
        ? { k: "ended" }
        : row.account === null
          ? { k: "none" }
          : { k: "account", account: row.account },
    tag: row.id === openId ? "open" : row.needsPair ? null : row.kind,
    pairAgain: row.needsPair,
    verb: own ? "stopAndRemove" : "forget",
  };
}

/** The ways to add one, as the first screen offers them: the mailbox on this phone only where this build can. */
function waysOf(config: ServersConfig): ServersWay[] {
  const ways: ServersWay[] = [
    { id: "cloud", opens: "scan" },
    { id: "server", opens: "server" },
    { id: "computer", opens: "computer" },
  ];
  /* Anything but a word that offers it withholds the way. */
  if (OFFERS_A_MAILBOX[config.app] && config.organizes === "offered")
    ways.push({ id: "standalone", opens: "terms" });
  return ways;
}

export function serversView(state: ServersState, config: ServersConfig): ServersView {
  const open = openSheetOf(state);
  const lines = state.paired.map((row) => lineOf(row, openRowOf(state)?.id ?? null));
  return {
    after: state.after,
    open,
    paired:
      lines.length === 0 ? null : { lines, note: lines.every((line) => line.own) ? "remove" : "forget" },
    empty: lines.length === 0 && open.k === "none" && state.after === null,
    ways: waysOf(config),
    verbs: state.session === "live",
    hot: open.k === "refused" || (open.k === "session" && open.sync !== null) || state.after !== null,
  };
}
