"use client";

/**
 * A STREAM'S RAIL COUNT, OFF THE MAIL GROUND ALONE: what is new since the last visit (the fresh side of the stream's
 * own line that is still unread, `FeedPartition.newCount`), the one number the stream's head says too. A rail's count
 * is drawn for the frame's life (the rail, the dock, behind More) while the stream's own model stands only with its
 * columns, so it reads the ground's partition (derived once a mirror's stamp for the entry and the seat) and the mail
 * state, never that model. Withheld until the mirror has settled and nothing is owed: the very rule the stream's head
 * states its number under, so the rail and the head say one number at one moment.
 */
import { countWhen } from "@ohmail/client-engine";
import { useMailState } from "../mail-state/mail-state-binding.js";
import { FEED_OF, useGroundPartition } from "./live.js";
import type { StreamPlace } from "./use-stream.js";

/** How many of the stream's letters are new since the last visit; null while it may not be stated. */
export function useStreamNew(place: StreamPlace): number | null {
  const n = useGroundPartition(FEED_OF[place]).newCount;
  const { state } = useMailState();
  return countWhen({ settled: state.settled, count: n, pending: state.owed }, n) ?? null;
}
