"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RefusalLine } from "@ohmail/ui/base";
import { SettingNote } from "@ohmail/ui/mail";
import { useLocale, useTranslations } from "next-intl";
import { ApiError, account, accessFeedFor, accessStorage, apiConfigured, onAccessFeed } from "../../api-client";
import { SELF_HOST_BUILD } from "../../hello";
import { readOwner } from "@ohmail/app-logic/storage/owner-cookie";
import type { StorageChange } from "../../shell/StorageNotice";
import type { StorageFacts } from "../../shell/storage-state";
import { StepUp } from "./StepUp";
import { activeFormatZone } from "../../shell/locale";
import { leaveForManagePage } from "./manage-navigation";

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
  const [stepUp, setStepUp] = useState<false | { addon: "storage" | undefined }>(false);
  const [discarded, setDiscarded] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const run = useCallback(async (verified: boolean, addon?: "storage") => {
    setBusy(true);
    setRefusal(null);
    setDiscarded(false);
    try {
      const url = (await account.manageLinkChange({ lang, ...(addon ? { addon } : {}) }))?.url;
      if (typeof url === "string" && url.length > 0) {
        leaveForManagePage(url, activeFormatZone());
        return;
      }
      if (alive.current) setRefusal("failed");
    } catch (err) {
      if (!alive.current) return;
      const code = err instanceof ApiError && err.status === 403 ? err.code : null;
      if (code === "step_up_required" && !verified) {
        setStepUp({ addon });
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
        <RefusalLine alert>
          {refusal === "unverified" ? tLock("mintUnverified") : t("storageChangeFailed")}
        </RefusalLine>
      ) : null}
      {discarded ? <SettingNote said>{td("stepUpCancelledNothingRan")}</SettingNote> : null}
      {stepUp ? (
        <StepUp
          inline
          returnFocus={() => opener.current}
          onVerified={() => {
            setStepUp(false);
            void run(true, stepUp.addon);
          }}
          onCancel={() => setStepUp(false)}
          onDiscarded={() => setDiscarded(true)}
        />
      ) : null}
    </>
  );
  return {
    press: (event, addon) => {
      opener.current = event.currentTarget;
      void run(false, addon);
    },
    busy: busy || stepUp !== false,
    note,
  };
}
