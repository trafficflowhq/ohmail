"use client";

import { useSyncExternalStore } from "react";
import { apiConfigured, auth, onReuseFeed, reuseFeedFor } from "../../api-client";
import { readOwner } from "../../shell/owner-cookie";
import { ReuseSweepNotice } from "../../shell/ReuseSweepNotice";

const acknowledge = (ids: string[]): Promise<void> => auth.acknowledgeReuseSweeps(ids);
/** The session read publishes the feed again; an answer listing none takes the strip away. */
const recheck = (): Promise<unknown> => auth.session();

/**
 * THE REUSE SWEEPS THIS SIGN-IN IS TOLD OF, on the browser: drawn from the feed the session read
 * publishes (`api-client.ts`), for the jar's own account only, and acknowledged through the API.
 * Cloud and self-host alike: both servers list them.
 */
export function ReuseSweepStrip() {
  const sweeps = useSyncExternalStore(onReuseFeed, () => reuseFeedFor(readOwner()), () => null);
  if (!apiConfigured() || sweeps === null || sweeps.length === 0) return null;
  return <ReuseSweepNotice sweeps={sweeps} onAcknowledge={acknowledge} onRecheck={recheck} />;
}
