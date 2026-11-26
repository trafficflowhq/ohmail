"use client";

import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog } from "@ohmail/ui/base";
import { markCleanupNoticeShown } from "../../pending-sign-out-storage";
import { finishPendingSignOut } from "../login/finish-sign-out";
import { listenSessionChange } from "../../signed-out-signal";

export interface AccountCleanup {
  reason: "blocked" | "unverified";
  press: string;
  holds(): boolean;
}

/** The Account pane can report an incomplete local wipe after its own frame has retired. */
export const AccountCleanupContext = createContext<((cleanup: AccountCleanup) => void) | null>(null);

export function AccountCleanupGate({ cleanup }: { cleanup: AccountCleanup }) {
  const t = useTranslations("account");
  const own = useTranslations("accountOwn");
  const keys = useTranslations("shortcuts");
  const [reason, setReason] = useState(cleanup.reason);
  const [busy, setBusy] = useState(false);
  const leaving = useRef(false);
  const running = useRef(false);
  const leave = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    window.location.assign("/");
  }, []);
  useEffect(() => {
    if (cleanup.holds()) markCleanupNoticeShown(cleanup.press);
    const check = () => {
      if (!busy && !cleanup.holds()) leave();
    };
    check();
    return listenSessionChange(check);
  }, [busy, cleanup, leave]);

  async function retry() {
    if (running.current || leaving.current) return;
    if (!cleanup.holds()) { leave(); return; }
    setBusy(true);
    running.current = true;
    try {
      const end = await finishPendingSignOut({ isCancelled: () => leaving.current, mayEnd: cleanup.holds });
      if (leaving.current) return;
      if (end.outcome === "confirmed" || end.outcome === "moved" || end.cleanup) {
        await end.cleanup;
        leave();
      } else {
        setReason(end.said?.key === "signOutBlocked" ? "blocked" : "unverified");
      }
    } catch {
      setReason("unverified");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      title={own(reason === "blocked" ? "stillHere" : "notConfirmed")}
      line={t(reason === "blocked" ? "localCleanupBlocked" : "localCleanupUnverified")}
      onClose={leave}
      confirm={reason === "blocked" ? {
        label: t(busy ? "signOutBusy" : "retryLocalCleanup"),
        disabled: busy,
        onPress: () => void retry(),
      } : undefined}
      cancel={{ label: keys("close") }}
    />
  );
}
