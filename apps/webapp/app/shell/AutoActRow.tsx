"use client";

/**
 * "Act on confident suggestions for me" — the act on suggestions' own consent, directly
 * under "Suggest for new senders automatically". The switch shows the STORED value. It is disabled
 * while automatic suggestions are off (the act acts on what that switch buys), and on an install
 * that reads mail another install organizes: the consent is not carried to the organizer, so the
 * sentence sends the person there. Shared by the web shell and the desktop's standalone door.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { SettingsRow, Switch } from "@ohmail/ui";

export function AutoActRow({
  on,
  suggestOn,
  reader,
  setAutoAct,
}: {
  /** As the server answered it. */
  on: boolean;
  /** Whether automatic suggestions are on — the act needs them. */
  suggestOn: boolean;
  /** This install reads mail another install organizes. */
  reader: boolean;
  /** Resolves to what the database holds; rethrows a refusal. */
  setAutoAct: (enabled: boolean) => Promise<boolean>;
}) {
  const t = useTranslations("screener");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const write = (next: boolean) => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    void (async () => {
      try {
        await setAutoAct(next);
      } catch {
        if (alive.current) setFailed(true);
      } finally {
        if (alive.current) setPending(false);
      }
    })();
  };

  const why = reader ? t("suggest.actReader") : suggestOn ? null : t("suggest.actNeedsSuggest");
  return (
    <>
      <SettingsRow
        label={t("suggest.actTitle")}
        description={t("suggest.actDescription")}
        control={
          <Switch
            checked={on}
            disabled={pending || reader || !suggestOn}
            ariaLabel={t("suggest.actTitle")}
            onChange={write}
          />
        }
      />
      {why ? <span className="scn-sg-note" data-act-why={reader ? "reader" : "needs-suggest"}>{why}</span> : null}
      {failed ? <span className="scn-sg-note">{t("suggest.actFailed")}</span> : null}
    </>
  );
}
