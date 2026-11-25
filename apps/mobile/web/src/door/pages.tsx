/**
 * THE DOOR'S TWO PAGES, by route. A line is filled by the feature that draws its page; `none` is a page not built
 * into this page yet, and nothing is drawn for it.
 *
 * This is the one file that sees both the door and a page's folder: it hands each page its own contract, adapted
 * from the door's handle once per handle, and holds the page's copies of the door's shapes equal to the door's at
 * compile time, so that a change to either stops the build instead of a state drawn wrong.
 */
import { useState, type ReactNode } from "react";
import type { SaidRefusal } from "@ohmail/app-logic/phone/said";
import { NONE, type None } from "@ohmail/app/host/contract";
import { ConnectForm } from "@ohmail/app/mailboxes/connect";
import {
  PhoneDoorPage,
  type PhoneCamera,
  type PhoneDoor,
  type PhoneDoorConfig,
  type PhoneDoorMigrating,
  type PhoneDoorState,
  type PhoneOffer,
  type PhonePairAnswer,
  type PhonePairedRow,
  type PhonePairFacts,
  type PhoneRect,
  type PhoneScanned,
  type PhoneServerAnswer,
  type WayInSeed,
  type WayInStep,
} from "@ohmail/app/phone-door";
import {
  ServersPage,
  type ServersConfig,
  type ServersDone,
  type ServersDoor,
  type ServersForgetAsk,
  type ServersForgot,
  type ServersMigrating,
  type ServersRow,
  type ServersState,
  type ServersWayIn,
} from "@ohmail/app/servers";
import type * as Wire from "../../../src/shell/door-kinds";
import { phoneConnectWire } from "./connect-wire";
import type { DoorHandle } from "./handle";

export type DoorPage = (props: { readonly door: DoorHandle }) => ReactNode;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends readonly true[]> = T;
/** THE WAYS IN'S SHAPES ARE THE DOOR'S. */
export type WaysInShapesAreTheDoors = Holds<
  [
    Same<Wire.SaidRefusal, SaidRefusal>,
    Same<Wire.PairFacts, PhonePairFacts>,
    Same<Wire.Offer, PhoneOffer>,
    Same<Wire.PairedRow, PhonePairedRow>,
    Same<Wire.DoorMigrating, PhoneDoorMigrating>,
    Same<Wire.DoorState, PhoneDoorState>,
    Same<Pick<Wire.DoorConfig, keyof PhoneDoorConfig>, PhoneDoorConfig>,
    Same<Wire.Rect, PhoneRect>,
    Same<Wire.DoorRequests["scan.start"]["answer"], PhoneCamera>,
    Same<Wire.DoorRequests["server.ask"]["answer"], PhoneServerAnswer>,
    Same<Wire.DoorRequests["pair"]["answer"], PhonePairAnswer>,
    Same<Wire.DoorRequests["sign-in"]["answer"], PhonePairAnswer>,
    Same<Extract<Wire.DoorEvent, { type: "scan" }>["scan"], PhoneScanned>,
  ]
>;

type Within<A, B> = [A] extends [B] ? true : false;
/** THE LIST'S SHAPES ARE THE DOOR'S, and the steps it opens the ways in at are steps of theirs. */
export type ServersShapesAreTheDoors = Holds<
  [
    Same<Wire.PairedRow, ServersRow>,
    Same<Wire.DoorMigrating, ServersMigrating>,
    Same<Wire.DoorState, ServersState>,
    Same<Pick<Wire.DoorConfig, keyof ServersConfig>, ServersConfig>,
    Same<Wire.DoorRequests["switch"]["answer"], ServersDone>,
    Same<Wire.DoorRequests["forget.ask"]["answer"], ServersForgetAsk>,
    Same<Wire.DoorRequests["forget"]["answer"], ServersForgot>,
    Within<Exclude<ServersWayIn, "welcome">, WayInStep>,
  ]
>;

/**
 * How long the press of a pairing may take: native redeems the code, then opens the copy under the system's question
 * about notices, which a person reads. Past the channel's default, as the connect wire's `open` is.
 */
export const PAIR_DEADLINE_MS = 10 * 60_000;

/** The ways in's door over the door's handle: each member one request, the connect form over the phone's wire. */
function phoneDoorOf(door: DoorHandle): PhoneDoor {
  const wire = phoneConnectWire(door);
  const quiet = (sent: Promise<unknown>): void => void sent.catch(() => {});
  return {
    config: door.config,
    state: door.state,
    ask: (address) => door.ask("server.ask", { address }),
    signIn: (address, signal) => door.ask("sign-in", { address }, { deadlineMs: PAIR_DEADLINE_MS, signal }),
    scan: {
      start: (rect) => door.ask("scan.start", { rect }),
      move: (rect) => door.ask("scan.move", { rect }),
      stop: () => quiet(door.ask("scan.stop", {})),
      allow: () => door.ask("camera.allow", {}),
      listen: (heard) => door.onScan(heard),
    },
    hand: ({ address, token }) => door.ask("hand", { address, token }),
    pair: (ticket) => door.ask("pair", { ticket }, { deadlineMs: PAIR_DEADLINE_MS }),
    dismiss: (ticket) => quiet(door.ask("dismiss", { ticket })),
    connect: (ask, page) => <ConnectForm ask={ask} door={wire} factor={NONE} page={page} />,
    // Only to a page this door draws: an empty stage has no way back (the list of servers comes with its page).
    go: (to) => {
      if (pages[to] !== NONE) door.go(to);
    },
    back: door.back,
  };
}

const adapted = new WeakMap<DoorHandle, PhoneDoor>();
/** Made once per handle, never per draw: the connect form's wire is one for the page's life. */
function phoneDoor(door: DoorHandle): PhoneDoor {
  let made = adapted.get(door);
  if (made === undefined) adapted.set(door, (made = phoneDoorOf(door)));
  return made;
}

/**
 * WHERE THE WAYS IN OPEN, when the list opened them at a step: one cell of memory per handle, set by the list before
 * the route moves and taken once by the ways in as they mount. The route itself names only the page, never a step.
 */
const opensAt = new WeakMap<DoorHandle, WayInSeed>();

function WaysIn({ door }: { readonly door: DoorHandle }): ReactNode {
  const [from] = useState(() => {
    const seed = opensAt.get(door);
    opensAt.delete(door);
    return seed;
  });
  return <PhoneDoorPage door={phoneDoor(door)} from={from} />;
}

/** The list's door over the door's handle: each member one request; the ways in through the route and the cell. */
function serversDoorOf(door: DoorHandle): ServersDoor {
  const quiet = (sent: Promise<unknown>): void => void sent.catch(() => {});
  return {
    config: door.config,
    state: door.state,
    switchTo: (id) => door.ask("switch", { id }),
    forgetAsk: (id) => door.ask("forget.ask", { id }),
    forget: (id, anyway) => door.ask("forget", { id, anyway }),
    sync: () => quiet(door.ask("sync", {})),
    disconnect: () => quiet(door.ask("disconnect", {})),
    leave: () => quiet(door.ask("leave", {})),
    waysIn: (at) => {
      if (at === "welcome") opensAt.delete(door);
      else opensAt.set(door, { step: at });
      door.go("welcome");
    },
    back: door.back,
  };
}

const listed = new WeakMap<DoorHandle, ServersDoor>();
function serversDoor(door: DoorHandle): ServersDoor {
  let made = listed.get(door);
  if (made === undefined) listed.set(door, (made = serversDoorOf(door)));
  return made;
}

export const pages: { readonly [At in Wire.DoorAt]: DoorPage | None } = {
  welcome: ({ door }) => <WaysIn door={door} />,
  servers: ({ door }) => <ServersPage door={serversDoor(door)} />,
};
