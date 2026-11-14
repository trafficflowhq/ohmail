"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ApiError, account, accessFeedFor, accessStorage, apiConfigured, onAccessFeed } from "../../api-client";
import { SELF_HOST_BUILD } from "../../hello";
import { readOwner } from "@ohmail/app-logic/storage/owner-cookie";
import type { StorageChange } from "../../shell/StorageNotice";
import type { StorageFacts } from "../../shell/storage-state";
import { StepUpPrompt } from "./StepUpPrompt";
import { leaveForManagePage } from "./SubscriptionSection";

/** The account's storage block from the access feed the shell already asks; nothing on a self-host build. */
export function useCloudStorage(): StorageFacts | null {
  const entry = useSyncExternalStore(onAccessFeed, () => accessFeedFor(readOwner()), () => null);
  return SELF_HOST_BUILD || !apiConfigured() ? null : accessStorage(entry?.answer);
}

/**
 * CHANGE PLAN AND ADD STORAGE on the browser: one press mints the subscription page that may change
 * the plan (`POST /account/manage-link/change`) and leaves for it. That page charges the card on
 * file, so the route asks for a recent second factor: a `step_up_required` opens the factor prompt
 * in place and the press runs once more after it; a second refusal is said, never asked again.
 */
export function useStorageChange(): StorageChange {
  const t = useTranslations("settings");
  const tLock = useTranslations("accessLock");
  const td = useTranslations("devices");
  const lang = useLocale() === "de" ? "de" : "en";
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<"failed" | "unverified" | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const run = useCallback(async (verified: boolean) => {
    setBusy(true);
    setRefusal(null);
    setDiscarded(false);
    try {
      const url = (await account.manageLinkChange({ lang }))?.url;
      if (typeof url === "string" && url.length > 0) {
        leaveForManagePage(url);
        return;
      }
      if (alive.current) setRefusal("failed");
    } catch (err) {
      if (!alive.current) return;
      const code = err instanceof ApiError && err.status === 403 ? err.code : null;
      if (code === "step_up_required" && !verified) {
        setStepUp(true);
        return;
      }
      setRefusal(code === "email_unverified" ? "unverified" : "failed");
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [lang]);

  const note = (
    <>
      {refusal !== null ? (
        <p className="acct-warn" role="alert">
          {refusal === "unverified" ? tLock("mintUnverified") : t("storageChangeFailed")}
        </p>
      ) : null}
      {discarded ? <p className="acct-warn" role="status">{td("stepUpCancelledNothingRan")}</p> : null}
      {stepUp ? (
        <StepUpPrompt
          onVerified={() => {
            setStepUp(false);
            void run(true);
          }}
          onCancel={() => setStepUp(false)}
          onDiscarded={() => setDiscarded(true)}
        />
      ) : null}
    </>
  );
  return { press: () => { void run(false); }, busy: busy || stepUp, note };
}
