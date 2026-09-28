/**
 * A SEND WAITS FOR THE NETWORK ON A PHONE THAT HAS NONE. On the standalone door the engine is in
 * this process, so a send pressed offline reached it, failed at the mail server's door, and each
 * press left another draft. While the network door reads `offline` the send STEP is held at the
 * transport, as a network failure: the draft is written once (the words are kept if the person
 * cancels), the send waits in the outbox under its one key, and the flush after the return sends
 * that draft once. Send later is a different step and is not held. `online`/`unknown` hold nothing.
 */
import type { NetworkState } from "../net/network-door";

/** The send step of the two a send makes (`POST /drafts`, then this one). */
const SEND_STEP = /^\/drafts\/[^/]+\/send$/;

/** Does this request wait for the network rather than reach the engine now? */
export function sendWaitsForNetwork(method: string, path: string, network: NetworkState): boolean {
  return network === "offline" && method.toUpperCase() === "POST" && SEND_STEP.test(path);
}

/**
 * Which queued sentence a waiting send earns. Accepted by the server, it is still sending (the
 * web's `statusSendingLong`); otherwise read off the network door: offline, it goes when it is back.
 */
export function queuedCaptionKey(
  network: NetworkState,
  accepted = false,
): "replySendingLong" | "replyQueuedOffline" | "replyQueued" {
  if (accepted) return "replySendingLong";
  return network === "offline" ? "replyQueuedOffline" : "replyQueued";
}
