/**
 * WHAT A DOOR PAGE IS HANDED: native's word of what the page is, the connection as native last told it, the device's
 * facts, back, what the camera read, the door's requests, and the page's own route. The route is held in memory and
 * never in the address: nothing a link can name steers the door. Nothing here is stored, and nothing is kept of a
 * state once the next one arrives.
 */
import type { BackSignal, Signal } from "@ohmail/app/host";
import type { FoldReading, KeyboardReading, SafeInsets } from "../../../src/shell/bridge-kinds";
import type { DoorAt, DoorConfig, DoorEvent, DoorState } from "../../../src/shell/door-kinds";
import { backHandlers, cell } from "../cells";
import type { DoorBridge } from "./bridge";

/** What the camera read: a frame that was no pairing code, or what a probe measured under a ticket. */
export type Scanned = Extract<DoorEvent, { type: "scan" }>["scan"];

export interface DoorHandle {
  readonly config: DoorConfig;
  readonly state: Signal<DoorState>;
  readonly facts: {
    readonly posture: Signal<FoldReading>;
    readonly insets: Signal<SafeInsets>;
    readonly keyboard: Signal<KeyboardReading>;
    readonly online: Signal<boolean>;
  };
  /** Back: handlers newest first, the first to answer true took it. Not taken, native takes the door's way out. */
  readonly back: BackSignal;
  /** Told to every listener as it is read; held nowhere. An offer no listener hears is given back. */
  onScan(heard: (scan: Scanned) => void): () => void;
  /** A request of the door's table. */
  readonly ask: DoorBridge["request"];
  readonly route: Signal<DoorAt>;
  go(to: DoorAt): void;
}

export function doorHandle(bridge: DoorBridge, config: DoorConfig): DoorHandle {
  const state = cell(config.state);
  const posture = cell(config.facts.posture);
  const insets = cell(config.facts.insets);
  const keyboard = cell(config.facts.keyboard);
  const online = cell(config.facts.online);
  const route = cell(config.at);
  const back = backHandlers();
  const scans = new Set<(scan: Scanned) => void>();
  bridge.on((e) => {
    switch (e.type) {
      case "state": return state.set(e.state);
      case "posture": return posture.set(e.reading);
      case "insets": return insets.set(e.insets);
      case "keyboard": return keyboard.set(e.reading);
      case "network": return online.set(e.online);
      case "scan": {
        // An offer told after its step stopped listening, while the camera's stop was on its way: given back, not dropped.
        if (scans.size === 0 && e.scan.k === "offers") {
          void bridge.request("dismiss", { ticket: e.scan.ticket }).catch(() => {});
          return;
        }
        for (const heard of [...scans]) heard(e.scan);
        return;
      }
      case "ask": {
        void bridge.request("answer", { askId: e.askId, what: "back", took: back.took() }).catch(() => {});
        return;
      }
      default:
        return;
    }
  });
  return {
    config,
    state,
    facts: { posture, insets, keyboard, online },
    back: { subscribe: back.subscribe },
    onScan(heard) {
      scans.add(heard);
      return () => scans.delete(heard);
    },
    ask: bridge.request,
    route,
    go: (to) => route.set(to),
  };
}
