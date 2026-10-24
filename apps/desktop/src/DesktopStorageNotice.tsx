/**
 * THE EMPTIED-TEXT NOTICE ON THE CLOUD DOOR — the browser's notice in the shared shell's account
 * slot, from the `/account/access` answer the Subscription offer already reads over the bridge
 * (`useDesktopManageOffer`). Put away once per device and mailbox. Its press opens the Subscription
 * pane, where the operator's page is minted; a build that may not link out to billing (the Mac App
 * Store) gets neither the press nor the plan sentence. Standalone has no storage block: nothing drawn.
 */

import { useCallback, useState, type ReactElement } from "react";
import { useTranslations } from "next-intl";

import { localStorageDoor } from "../../webapp/app/shell/durable";
import { storageOwner } from "../../webapp/app/shell/storage-owner";
import { StorageNotice } from "../../webapp/app/shell/StorageNotice";
import {
  storageNoticeDue, storageNoticeKey, storagePlanOf, type StorageFacts,
} from "../../webapp/app/shell/storage-state";

const DOOR = localStorageDoor("storage.notice");

/** Where the Subscription pane lives in the shell's settings routes. */
export const SUBSCRIPTION_PANE_HREF = "#/settings/billing";

export function DesktopStorageNotice({ facts, lifecycleState, linksOut }: {
  facts: StorageFacts | null;
  lifecycleState: string | null;
  /** May this build point at a purchase (the Subscription pane is offered)? */
  linksOut: boolean;
}): ReactElement | null {
  const t = useTranslations("settings");
  const [hidden, setHidden] = useState(false);
  const key = storageNoticeKey(storageOwner());
  const dismiss = useCallback(() => {
    DOOR.set(key, "1");
    setHidden(true);
  }, [key]);
  if (!storageNoticeDue(facts, hidden || DOOR.get(key) === "1")) return null;
  return (
    <StorageNotice
      facts={facts}
      plan={linksOut ? storagePlanOf(lifecycleState) : null}
      onDismiss={dismiss}
      manage={linksOut ? <a className="acct-do" href={SUBSCRIPTION_PANE_HREF}>{t("storageNoticeManage")}</a> : null}
    />
  );
}
