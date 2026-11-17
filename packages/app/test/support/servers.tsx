/**
 * THE FAKE DOOR OF THE PHONE'S LIST OF SERVERS: the page's contract in memory. Every request is recorded by the door's
 * kind and answered from `answers` (a request with no answer waits, as one native has not answered yet); a test tells
 * a state or a hardware back. What it hides, and the milestone proves on the emulator: native's own forget (what it
 * deletes, in which order), a real switch, and the system's back.
 */
import type {
  ServersConfig,
  ServersDone,
  ServersDoor,
  ServersForgetAsk,
  ServersForgot,
  ServersRow,
  ServersState,
} from "../../src/servers/index.js";

export const SERVERS_STATE: ServersState = {
  session: "none",
  migrating: null,
  said: null,
  openId: null,
  syncing: false,
  syncSaid: null,
  syncStopped: null,
  pinned: false,
  total: null,
  paired: [],
  after: null,
};

export const SERVERS_CONFIG: ServersConfig = { app: "ohmail", os: "android", organizes: "offered" };

/** Rows as native names them: made up, no server knows them. */
export const HOSTED: ServersRow = {
  id: "row-hosted",
  kind: "hosted",
  address: "https://api.ohmail.app",
  account: "mila@lichtgrat.example",
  open: true,
  needsPair: false,
};
export const COMPUTER: ServersRow = {
  id: "row-computer",
  kind: "computer",
  address: "https://192.168.1.24:47800",
  account: "mila@lichtgrat.example",
  open: false,
  needsPair: false,
};
export const OWN: ServersRow = {
  id: "row-own",
  kind: "own",
  address: "",
  account: null,
  open: true,
  needsPair: false,
};

type Answer<A, T> = (ask: A) => T | Promise<T>;
export interface ServersAnswers {
  readonly switch?: Answer<string, ServersDone>;
  readonly "forget.ask"?: Answer<string, ServersForgetAsk>;
  readonly forget?: Answer<{ id: string; anyway: boolean }, ServersForgot>;
}

export interface ServersAsked {
  readonly kind: string;
  readonly ask: unknown;
}

const never = <T,>(): Promise<T> => new Promise<T>(() => {});

export function fakeServersDoor(
  o: { config?: Partial<ServersConfig>; state?: Partial<ServersState>; answers?: ServersAnswers } = {},
) {
  const asked: ServersAsked[] = [];
  let state: ServersState = { ...SERVERS_STATE, ...o.state };
  const listeners = new Set<() => void>();
  const backs: (() => boolean)[] = [];
  const answers = o.answers ?? {};
  const answer = <A, T>(
    kind: string,
    ask: A,
    recorded: unknown,
    by: Answer<A, T> | undefined,
  ): Promise<T> => {
    asked.push({ kind, ask: recorded });
    return by ? Promise.resolve().then(() => by(ask)) : never<T>();
  };
  const door: ServersDoor = {
    config: { ...SERVERS_CONFIG, ...o.config },
    state: {
      read: () => state,
      subscribe(changed) {
        listeners.add(changed);
        return () => listeners.delete(changed);
      },
    },
    switchTo: (id) => answer("switch", id, { id }, answers.switch),
    forgetAsk: (id) => answer("forget.ask", id, { id }, answers["forget.ask"]),
    forget: (id, anyway) => answer("forget", { id, anyway }, { id, anyway }, answers.forget),
    sync: () => void asked.push({ kind: "sync", ask: {} }),
    disconnect: () => void asked.push({ kind: "disconnect", ask: {} }),
    leave: () => void asked.push({ kind: "leave", ask: {} }),
    waysIn: (at) => void asked.push({ kind: "waysIn", ask: at }),
    back: {
      subscribe(handle) {
        backs.push(handle);
        return () => void backs.splice(backs.lastIndexOf(handle), 1);
      },
    },
  };
  return {
    door,
    asked,
    kinds: () => asked.map((a) => a.kind),
    /** Native's `state` event. */
    tell(next: Partial<ServersState>) {
      state = { ...state, ...next };
      for (const l of [...listeners]) l();
    },
    /** The hardware back: whether the page took it. */
    back: () => [...backs].reverse().some((h) => h()),
  };
}
