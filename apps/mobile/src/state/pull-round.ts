/**
 * WHAT A PULL DOES — the gesture's decision, apart from the hook so the suite can drive it. With
 * no network on the phone (the door's reading, never a failed request) the pull says so and asks
 * nothing: the door's return drains at once (`drain-cadence.ts`). Otherwise it rings the round.
 */
import type { NetworkState } from "../net/network-door";
import { refuse, type Refusal } from "../refusal";

export function pullRound(
  network: NetworkState, ring: () => Promise<void>, say: (r: Refusal) => void,
): Promise<void> {
  if (network === "offline") {
    say(refuse("networkOffline"));
    return Promise.resolve();
  }
  return ring();
}
