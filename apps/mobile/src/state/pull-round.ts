/**
 * WHAT A PULL DOES — the gesture's decision, apart from the hook so the suite can drive it. With
 * no network on the phone (the door's reading, never a failed request) the pull says so and asks
 * nothing: the door's return drains at once (`drain-cadence.ts`). Otherwise it rings the round,
 * and when the ring's answer says the server is not fetching new mail it says that at once: no
 * scan will come, and a spinner that settles on nothing was the only answer for 26 hours.
 */
import type { RingHeard } from "../net/connection";
import type { NetworkState } from "../net/network-door";
import { refuse, type Refusal } from "../refusal";

/**
 * The ring's answer, said when it lands. `who` names whoever checks the mailboxes (ohmail Cloud, or
 * a server somebody runs); `null` is a phone that organizes on its own, which says nothing.
 */
function saysNotChecked(say: (r: Refusal) => void, who: "cloud" | "server" | null): RingHeard {
  return (ring) => {
    if (who !== null && ring?.fetching?.behind === true) say(refuse(who === "cloud" ? "pullBehind" : "pullBehindServer"));
  };
}

export function pullRound(
  network: NetworkState, ring: (heard: RingHeard) => Promise<void>, say: (r: Refusal) => void,
  who: "cloud" | "server" | null,
): Promise<void> {
  if (network === "offline") {
    say(refuse("networkOffline"));
    return Promise.resolve();
  }
  return ring(saysNotChecked(say, who));
}
