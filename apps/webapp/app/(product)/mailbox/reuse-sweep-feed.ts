"use client";

import { useSyncExternalStore } from "react";
import { apiConfigured, auth, onReuseFeed, reuseFeedFor } from "../../api-client";
import { readOwner } from "@ohmail/app-logic/storage/owner-cookie";
import type { ReuseSweepLine } from "../../shell/reuse-sweeps";

const acknowledge = (ids: string[]): Promise<void> => auth.acknowledgeReuseSweeps(ids);
/** The session read publishes the feed again; an answer listing none takes the strip away. */
const recheck = (): Promise<unknown> => auth.session();

/** The sweeps this sign-in is told of now, and the two calls that answer them. */
export interface ReuseSweepFeed {
  /** Null where there is nothing to say: no server, or no sweep listed. */
  readonly sweeps: readonly ReuseSweepLine[] | null;
  readonly acknowledge: (ids: string[]) => Promise<void>;
  readonly recheck: () => Promise<unknown>;
}

/**
 * THE REUSE SWEEPS THIS SIGN-IN IS TOLD OF, on the browser: drawn from the feed the session read
 * publishes (`api-client.ts`), for the jar's own account only, and acknowledged through the API.
 * Cloud and self-host alike: both servers list them.
 */
export function useReuseSweepFeed(): ReuseSweepFeed {
  const sweeps = useSyncExternalStore(onReuseFeed, () => reuseFeedFor(readOwner()), () => null);
  const shown = !apiConfigured() || sweeps === null || sweeps.length === 0 ? null : sweeps;
  return { sweeps: shown, acknowledge, recheck };
}
