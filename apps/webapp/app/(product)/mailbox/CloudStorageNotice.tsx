"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ApiError, account, accessFeedFor, accessStorage, apiConfigured, onAccessFeed } from "../../api-client";
import { SELF_HOST_BUILD } from "../../hello";
import { localStorageDoor } from "../../shell/durable";
import { readOwner } from "../../shell/owner-cookie";
import { storageOwner } from "../../shell/storage-owner";
import { StorageNotice } from "../../shell/StorageNotice";
import { storageNoticeDue, storageNoticeKey, storagePlanOf } from "../../shell/storage-state";
import { leaveForManagePage } from "./SubscriptionSection";

/** Where this browser keeps the dismissal: once per device and account, read in try/catch by the door. */
const DOOR = localStorageDoor("storage.notice");

/**
 * The emptied-text notice on the browser: drawn from the access feed the account strip already asks
 * for, so it adds no read. Shown while letters are emptied for space and this browser has not put it
 * away; a refused store keeps it put away for this mount.
 */
export function CloudStorageNotice() {
  const t = useTranslations("settings");
  const tLock = useTranslations("accessLock");
  const lang = useLocale() === "de" ? "de" : "en";
  const entry = useSyncExternalStore(onAccessFeed, () => accessFeedFor(readOwner()), () => null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mintRefusal, setMintRefusal] = useState<"failed" | "unverified" | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const key = storageNoticeKey(storageOwner());
  const facts = SELF_HOST_BUILD || !apiConfigured() ? null : accessStorage(entry?.answer);
  const dismiss = useCallback(() => {
    DOOR.set(key, "1");
    setHidden(true);
  }, [key]);

  const toManage = useCallback(async () => {
    setBusy(true);
    setMintRefusal(null);
    try {
      const url = (await account.manageLink({ lang }))?.url;
      if (typeof url === "string" && url.length > 0) { leaveForManagePage(url); return; }
      if (alive.current) setMintRefusal("failed");
    } catch (err) {
      const unverified = err instanceof ApiError && err.status === 403 && err.code === "email_unverified";
      if (alive.current) setMintRefusal(unverified ? "unverified" : "failed");
    }
    if (alive.current) setBusy(false);
  }, [lang]);

  if (!storageNoticeDue(facts, hidden || DOOR.get(key) === "1")) return null;
  const answer = entry?.answer;
  const plan = storagePlanOf(answer?.metered ? answer.lifecycle?.state : undefined);
  return (
    <StorageNotice
      facts={facts}
      plan={plan}
      onDismiss={dismiss}
      manage={(
        <>
          <button type="button" className="acct-do" disabled={busy} onClick={() => { void toManage(); }}>
            {t("storageNoticeManage")}
          </button>
          {mintRefusal !== null ? (
            <span role="alert">{tLock(mintRefusal === "unverified" ? "mintUnverified" : "mintFailed")}</span>
          ) : null}
        </>
      )}
    />
  );
}
