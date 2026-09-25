"use client";

/**
 * THE BROWSER'S BIND OF THE ENGINE'S ONE RE-ASK RULE (`createSessionReask`). History's and
 * Search's pages go out on the engine's transport, which does not renew, so a 401 there is the
 * credential's answer: the rule asks the renewal (`probeSessionNow`, single-flight), the read shows
 * as loading while it is out, and it is asked again on the revival the refresh publishes. This
 * file only renders the rule; the phone binds the same one to its bearer.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createSessionReask, type SessionRenewalDoor, type StoreReadSource } from "@ohmail/client-engine";
import { probeSessionNow, sessionIsDead, subscribeSessionRevival, useSessionDead } from "./session-truth";

export { sessionRefused } from "@ohmail/client-engine";

const WEB_SESSION: SessionRenewalDoor = {
  renew: probeSessionNow,
  onRenewed: subscribeSessionRevival,
  ended: sessionIsDead,
};

/** `true` while a refused read waits on its renewal. `read` must be stable for the walker it names. */
export function useSessionReask(read: StoreReadSource): boolean {
  useSessionDead();
  const rule = useMemo(() => createSessionReask(WEB_SESSION, read), [read]);
  useEffect(() => rule.attach(), [rule]);
  useSyncExternalStore(rule.subscribe, rule.revision, rule.revision);
  return rule.renewing();
}
