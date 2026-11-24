/** A signal read in render: the frame's parts and today's views read the host's signals and the frame's feeds so. */
import { useSyncExternalStore } from "react";
import type { Signal } from "../host/index.js";

export { createFeed } from "../host/feed.js";
export type { Feed } from "../host/feed.js";

/** A signal's value now, read again whenever it says so. */
export function useSignal<T>(signal: Signal<T>): T {
  return useSyncExternalStore(signal.subscribe, signal.read, signal.read);
}
