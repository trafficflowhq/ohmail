"use client";

import { useTranslations } from "next-intl";
import type { PendingSignOutDoor } from "@ohmail/app/doors";
import type { PendingSignOut } from "./pending-sign-out";

/**
 * A pending sign-out as a door's page draws it: what did not happen, said in the account's words as
 * `PendingSignOutSaid` says it, and Sign out to ask again.
 */
export function usePendingDoor(pending: PendingSignOut): PendingSignOutDoor {
  const ta = useTranslations("account");
  const said = pending.said === null
    ? null
    : pending.said.key === "signOutServerRefused"
      ? pending.said.cleanupIncomplete
        ? ta("signOutServerRefusedUnverified", { reason: pending.said.reason })
        : ta(pending.said.key, { reason: pending.said.reason })
      : ta(pending.said.key);
  return {
    said,
    act: pending.signingOut ? ta("signOutBusy") : ta("signOut"),
    signingOut: pending.signingOut,
    again: pending.again,
  };
}
