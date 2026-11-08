/**
 * THE STORAGE CARD ON THE CLOUD DOOR — the browser's card atop the Ohbox, from the `/account/access`
 * answer the Subscription offer already reads over the bridge (`useDesktopManageOffer`). Which card is
 * due is the account's word; Dismiss records it there (`PATCH /account/storage`) and reads again. A
 * build that may not link out to billing (the Mac App Store) gets the numbers and the fitted plan named,
 * with no amount, no purchase button and no link. Standalone has no storage block: nothing drawn.
 */

import { useEffect, useState, type ReactElement } from "react";

import { StorageNotice } from "../../webapp/app/shell/StorageNotice";
import type { StorageCard, StorageFacts } from "../../webapp/app/shell/storage-state";
import { useDesktopStorageChange, writeStorageChoice } from "./DesktopSubscription.js";

export function DesktopStorageNotice({ facts, linksOut, reread }: {
  facts: StorageFacts | null;
  /** May this build point at a purchase? */
  linksOut: boolean;
  /** Ask the account again once a dismissal is written. */
  reread: () => void;
}): ReactElement | null {
  const change = useDesktopStorageChange();
  const [hidden, setHidden] = useState<StorageCard | null>(null);
  const card = facts?.card ?? null;
  useEffect(() => { if (card !== hidden) setHidden(null); }, [card, hidden]);
  if (facts === null || card === null || card === hidden) return null;
  return (
    <StorageNotice
      facts={facts}
      linksOut={linksOut}
      change={linksOut ? change : null}
      onDismiss={() => {
        setHidden(card);
        void writeStorageChoice({ dismiss: card }).then((ok) => { if (ok) reread(); });
      }}
    />
  );
}
