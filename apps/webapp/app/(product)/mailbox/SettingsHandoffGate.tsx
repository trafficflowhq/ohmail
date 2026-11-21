"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { checkSettingsHandoff } from "../../settings-handoff-client";
import { settingsDestination, settingsLogin } from "../../settings-handoff";
import { CloudShell } from "./CloudShell";

export function SettingsHandoffGate({ reference }: { reference: string }) {
  const router = useRouter();
  const t = useTranslations("gate");
  const [account, setAccount] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    void checkSettingsHandoff(reference, abort.signal).then((answer) => {
      if (abort.signal.aborted) return;
      if (answer.kind === "ready") {
        window.history.replaceState(window.history.state, "", settingsDestination(reference, answer.pane));
        setAccount(answer.account);
      } else if (answer.kind === "login") {
        router.replace(settingsLogin(reference));
      } else {
        setInvalid(true);
      }
    });
    return () => abort.abort();
  }, [reference, router]);

  if (account) return <CloudShell demo={false} drawMail="wait" edgeOwner={null} settingsAccount={account} />;
  return invalid ? <p role="alert">{t("settingsHandoffInvalid")}</p> : null;
}
