/**
 * THE PHONE'S NETWORK, READ FROM THE PLATFORM ONCE. One reader is installed at
 * launch (`network-native.ts`: the posture module's `getNetwork` and `onNetworkChanged`), and every
 * surface asks this door — the top line, the pull, the search sentence, the drain cadence — never a
 * request's failure. `unknown` is the answer before the reader speaks and on a binary without it;
 * every surface then keeps the words it had. Pure: no React Native, so the suite installs a fake.
 */
import { useSyncExternalStore } from "react";

export type NetworkState = "online" | "offline" | "unknown";

/** What the platform answers, as the door reads it. */
export interface NetworkReader {
  read(): unknown;
  subscribe(listener: (reading: unknown) => void): () => void;
}

/** The door as a consumer holds it — the cadence takes this shape, not the module. */
export interface NetworkWatch {
  now(): NetworkState;
  subscribe(listener: (state: NetworkState) => void): () => void;
}

/** Anything but the two words a reader may say is `unknown`, never a guess. */
export function asNetworkState(reading: unknown): NetworkState {
  return reading === "online" || reading === "offline" ? reading : "unknown";
}

let state: NetworkState = "unknown";
let unhook: (() => void) | null = null;
const listeners = new Set<(s: NetworkState) => void>();

function settle(next: NetworkState): void {
  if (next === state) return;
  state = next;
  for (const l of [...listeners]) l(next);
}

/** Install the platform's reader (or none). A reader that throws reads as `unknown`. */
export function installNetworkReader(reader: NetworkReader | null): void {
  unhook?.();
  unhook = null;
  if (reader === null) { settle("unknown"); return; }
  try { settle(asNetworkState(reader.read())); } catch { settle("unknown"); }
  try { unhook = reader.subscribe((r) => settle(asNetworkState(r))); } catch { unhook = null; }
}

export function networkNow(): NetworkState {
  return state;
}

export function onNetworkChange(listener: (s: NetworkState) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The door as a {@link NetworkWatch}, for the cadence. */
export const networkDoor: NetworkWatch = { now: networkNow, subscribe: onNetworkChange };

/** The door for a screen: re-renders when the platform's answer moves. */
export function useNetworkNow(): NetworkState {
  return useSyncExternalStore(onNetworkChange, networkNow, networkNow);
}
