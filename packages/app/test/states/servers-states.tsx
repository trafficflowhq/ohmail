/**
 * THE PHONE'S LIST OF SERVERS, BY THE REFERENCE'S ADDRESS: each state of the screen `servers`, drawn over a door in
 * memory that tells the state's own made-up rows and answers only what the state needs: what Stop and remove would
 * drop, and a removal that kept the store. A dialog state is brought to itself by a person's press (`stepsOf`): the
 * subjects walk it in a real browser (`servers-open.ts`), this page's cases in jsdom.
 */
import { useMemo, type ReactNode } from "react";
import { DoorStage } from "../../src/doors/stage/index.js";
import {
  SERVERS_STATE_DATA,
  ServersPage,
  type ServersDoor,
  type ServersRow,
  type ServersState,
  type ServersStateData,
  type ServersStateId,
} from "../../src/servers/index.js";
import { fillOver, type Messages } from "../../src/text/index.js";
import phoneDe from "../../messages/phone.de.json" with { type: "json" };
import phoneEn from "../../messages/phone.en.json" with { type: "json" };
import { deviceOf } from "./connect-states.js";

export type Lang = "en" | "de";
/** The words the list reads, German filled over English as a shell hands them. */
export const SERVERS_WORDS: Readonly<Record<Lang, Messages>> = {
  en: phoneEn as unknown as Messages,
  de: fillOver(phoneEn as unknown as Messages, phoneDe as unknown as Messages),
};

/* The reference's made-up account and computer, as its draft draws them. */
const MAIL = "mila@lichtgrat.example";
const HOSTED: ServersRow = {
  id: "row-hosted",
  kind: "hosted",
  address: "https://api.ohmail.app",
  account: MAIL,
  open: true,
  needsPair: false,
};
const COMPUTER: ServersRow = {
  id: "row-computer",
  kind: "computer",
  address: "https://192.168.1.24:47800",
  account: MAIL,
  open: false,
  needsPair: false,
};
const OWN: ServersRow = {
  id: "row-own",
  kind: "own",
  address: "",
  account: null,
  open: true,
  needsPair: false,
};
const ROWS = {
  two: [HOSTED, COMPUTER],
  ended: [{ ...HOSTED, open: false, needsPair: true, account: null }, COMPUTER],
  own: [OWN],
  none: [],
} as const satisfies { readonly [R in ServersStateData["rows"]]: readonly ServersRow[] };

export interface Drawn {
  readonly id: ServersStateId;
}

/** What an address draws; `null` for a key this page does not draw (the phone's postures of the duo and the book). */
export function drawnAt(words: URLSearchParams): Drawn | null {
  if (words.get("screen") !== "servers") return null;
  const device = words.get("device");
  if (device === "duo" || device === "book") return null;
  const ask = words.get("ask");
  const id = `${words.get("state") ?? "live"}${ask === null ? "" : `&ask=${ask}`}${words.get("os") === "ios" ? "&os=ios" : ""}`;
  return id in SERVERS_STATE_DATA ? { id: id as ServersStateId } : null;
}

const EMPTY: ServersState = {
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

/** The state native would have told. */
export function stateOf(data: ServersStateData): ServersState {
  const paired = ROWS[data.rows];
  return {
    ...EMPTY,
    session: data.session,
    said: data.said ?? null,
    openId: data.session === "live" ? (paired.find((row) => row.open)?.id ?? null) : null,
    syncing: data.syncing === true,
    syncSaid: data.syncSaid ?? null,
    syncStopped: data.syncStopped ?? null,
    pinned: data.syncStopped === "keyChanged",
    paired,
    after: data.after ?? null,
  };
}

const never = <T,>(): Promise<T> => new Promise<T>(() => {});

/** A door that tells the state and answers what Stop and remove asks of it; every other press waits. */
function stateDoor(data: ServersStateData): ServersDoor {
  const state = stateOf(data);
  return {
    config: { app: "ohmail", os: data.config?.os ?? "android", organizes: "offered" },
    state: { read: () => state, subscribe: () => () => {} },
    switchTo: never,
    forgetAsk: () => (data.ask === undefined ? never() : Promise.resolve(data.ask)),
    forget: () => (data.kept === undefined ? never() : Promise.resolve({ k: "asks", settings: data.kept })),
    sync: () => {},
    disconnect: () => {},
    leave: () => {},
    waysIn: () => {},
    back: { subscribe: () => () => {} },
  };
}

/** A person's step: a press by its name. */
export interface Step {
  readonly press: string;
}

/** The steps that bring a state to itself after the page drew it: Stop and remove's press, for its dialog. */
export function stepsOf(drawn: Drawn, lang: Lang): readonly Step[] {
  const words = SERVERS_WORDS[lang] as unknown as { servers: Record<string, string> };
  const data: ServersStateData = SERVERS_STATE_DATA[drawn.id];
  return data.ask === undefined ? [] : [{ press: words.servers.stopAndRemove! }];
}

/** A drawn state on the doors' stage, as the door's page stands it. */
export function ServersStateDrawn({
  drawn,
  device,
}: {
  drawn: Drawn;
  device: ReturnType<typeof deviceOf>;
}): ReactNode {
  const door = useMemo(() => stateDoor(SERVERS_STATE_DATA[drawn.id]), [drawn.id]);
  return (
    <DoorStage device={device}>
      <ServersPage door={door} />
    </DoorStage>
  );
}

const ON_THE_DOOR =
  "The list stands on the door's page, before any mailbox is open: its way back is the arrow with its name where " +
  "the reference writes the place it returns to (Ohbox), since Back goes to the open mailbox, opens one this phone " +
  "can, or goes to the first screen; a paired computer or server is named by its address, which is what the door is " +
  "told of it; under the open session no letters are counted, since the door's page holds no mail under the shell; " +
  "a refusal says the detail native gave in its place, which the reference's sentence leaves out; and Stop and " +
  "remove asks in the kit's dialog, its verb first and the safe answer where the keys land, where the reference " +
  "draws the safe answer first.";

/**
 * THE CLASSES OF DIFFERENCE THE KEYS ARE DECLARED IN, whole, until their pictures are compared (`declared.json`): the
 * list as the door's page draws it, and on a larger screen without Settings' list beside it.
 */
export const DECLARED_CLASSES = {
  door: ON_THE_DOOR,
  beside:
    "On a larger screen the reference stands Settings' own list beside the list of servers; the door's page draws " +
    "the list alone, since the servers are the device's and stand where no account is open (ruled). " +
    ON_THE_DOOR,
} as const;
export type DeclaredClass = keyof typeof DECLARED_CLASSES;

/** The class a key is declared in: every key of the screen is, the larger screens' in their own. */
export function declaredClassOf(key: string): DeclaredClass {
  const device = new URLSearchParams(key).get("device");
  return device === "phone" ? "door" : "beside";
}
