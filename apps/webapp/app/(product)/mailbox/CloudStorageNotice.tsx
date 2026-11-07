"use client";

import { useEffect, useState } from "react";
import { account } from "../../api-client";
import { StorageNotice } from "../../shell/StorageNotice";
import type { StorageCard } from "../../shell/storage-state";
import { useCloudStorage, useStorageChange } from "./storage-change";

/**
 * The storage card on the browser, atop the Ohbox: drawn from the access feed the shell already asks
 * for, so it adds no read. Which card is due is the server's word; Dismiss records it there
 * (`PATCH /account/storage`) and hides it here at once, and the next access read carries the
 * server's answer. A refused write keeps it hidden for this mount.
 */
export function CloudStorageNotice() {
  const facts = useCloudStorage();
  const change = useStorageChange();
  const [hidden, setHidden] = useState<StorageCard | null>(null);
  // The server's answer took the card away: a card that comes back later is drawn again.
  const card = facts?.card ?? null;
  useEffect(() => { if (card !== hidden) setHidden(null); }, [card, hidden]);
  if (facts === null || facts.card === null || facts.card === hidden) return null;
  const level = facts.card;
  return (
    <StorageNotice
      facts={facts}
      linksOut
      change={change}
      onDismiss={() => {
        setHidden(level);
        void account.storage({ dismiss: level })
          .then(() => account.access({ fresh: true }))
          .catch(() => { /* hidden for this mount; the server keeps its card */ });
      }}
    />
  );
}
