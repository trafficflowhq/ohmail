"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { readOwner } from "@ohmail/app-logic/storage/owner-cookie";
import { account, accessFeedFor, apiConfigured, onAccessFeed } from "../../api-client";
import { SELF_HOST_BUILD } from "../../hello";

/**
 * DOES THIS DEPLOYMENT OPERATE A SUBSCRIPTION PAGE FOR THIS ACCOUNT — the offer, not the address.
 * It FOLLOWS THE ACCESS FEED (`api-client.ts`): every answer this tab receives, whoever asked, so
 * a read that failed at mount is healed by the next one — the account strip asks on every return
 * to the tab — and a failed read, which publishes nothing, can never take the pane away. `false`
 * for a self-hosted or unmetered install, a demo, and before the first answer: DO NOT OFFER THE
 * PANE, since the alternative is a nav entry above an empty pane. `withdraw` is the press's other
 * outcome: a mint with nowhere to go takes the pane with it for this mount.
 */
export function useManageOffer(demo: boolean): { manageOffered: boolean; withdrawManage: () => void } {
  const entry = useSyncExternalStore(onAccessFeed, () => accessFeedFor(readOwner()), () => null);
  const [asking, setAsking] = useState(false);
  const [withdrawn, setWithdrawn] = useState(false);
  useEffect(() => {
    // The landing page's mailbox reaches no server and has no account to ask about.
    // SELF_HOST_BUILD: `metered` stopped meaning "subscription page exists" the day the
    // self-host table declared its explicit mailbox allowance (`routes/self-host.ts`) —
    // `accessFor` answers non-null there, so this read would offer a Manage control on a
    // box with nothing to manage. Billing UI never reaches a self-host surface;
    // compiled away on managed builds like every other SELF_HOST_BUILD branch.
    if (SELF_HOST_BUILD || demo || !apiConfigured()) return;
    setAsking(true);
    // The first paint joins the shell's own read, or asks it; the feed carries the answer here.
    void account.access().catch(() => { /* no answer is no offer; the next one brings it */ });
    return () => { setAsking(false); };
  }, [demo]);
  const withdrawManage = useCallback(() => { setWithdrawn(true); }, []);
  return { manageOffered: asking && entry !== null && entry.answer.metered && !withdrawn, withdrawManage };
}
