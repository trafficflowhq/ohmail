/**
 * THE DOOR'S TWO PAGES, by route. A line is filled by the feature that draws its page; `none` is a page not built
 * into this page yet, and nothing is drawn for it.
 *
 * This is the one file that sees both the door and a page's folder: it hands each page its own contract, adapted
 * from the door's handle once per handle, and holds the page's copies of the door's shapes equal to the door's at
 * compile time, so that a change to either stops the build instead of a state drawn wrong.
 */
import type { ReactNode } from "react";
import type { SaidRefusal } from "@ohmail/app-logic/phone/said";
import { NONE, type None } from "@ohmail/app/host";
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
} from "@ohmail/app/phone-door";
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
    Same<Extract<Wire.DoorEvent, { type: "scan" }>["scan"], PhoneScanned>,
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
    connect: (ask) => <ConnectForm ask={ask} door={wire} factor={NONE} />,
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

export const pages: { readonly [At in Wire.DoorAt]: DoorPage | None } = {
  welcome: ({ door }) => <PhoneDoorPage door={phoneDoor(door)} />,
  servers: NONE,
};
