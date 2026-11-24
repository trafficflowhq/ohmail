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

/** The longest a pull's spinner turns: a round still running then goes on unseen and lands its mail when it lands. */
export const PULL_SPIN_CAP_MS = 15_000;

/** The round, or the cap, whichever comes first: the spinner never turns forever on a round that hangs. */
export function spinUntil(round: Promise<void>, capMs: number = PULL_SPIN_CAP_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, capMs);
  });
  return Promise.race([round.catch(() => undefined), cap]).finally(() => clearTimeout(timer));
}
