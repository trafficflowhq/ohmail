"use client";

/**
 * Auto-unsubscribe on screen-out — the switch for the one thing this product does that leaves the
 * building on somebody's behalf and cannot be recalled. ON (the default): screening a waiting
 * sender out, or the Screener's spam verb, also sends that sender's own one-click unsubscribe
 * request; OFF files the mail and sends nothing. The description may not promise every screened-out
 * sender is unsubscribed: the request goes only where the sender published `List-Unsubscribe` AND
 * `List-Unsubscribe-Post` (RFC 8058) — a `mailto:`-only route is refused outright, because this
 * product never sends mail on the user's behalf — so the copy says "where the sender offers it"
 * and stops; nor may it imply the switch retracts anything already sent.
 */

/**
 * A plain switch and not a confirm: {@link AutoSuggestRow} gates its ON with a priced confirm
 * because ON starts spending; here ON is the default the account already has, and the consequence
 * is disclosed where it is incurred — the sender sheet asks before the click, the Screener's toast
 * says so after, both reading the SAME flag this switch writes. It writes through
 * `useConsentState().setBlockAutoUnsubscribe`, never `consentApi` directly: `AppShell` passes the
 * same hook's `autoUnsubscribe` into the sheet and the Screener, so the disclosure stops on the
 * same render. The switch renders the value the server last answered — a switch drawn OFF over a
 * failed write would say the lists are being left alone while every screen-out goes on leaving one.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { SettingsRow, Switch } from "@ohmail/ui";

export function AutoUnsubscribeRow({
  on,
  setBlockAutoUnsubscribe,
}: {
  /** Does a screen-out still unsubscribe? The STORED answer, as the server last gave it. */
  on: boolean;
  /** `useConsentState().setBlockAutoUnsubscribe`. Takes the OPT-OUT, resolves to the feature. */
  setBlockAutoUnsubscribe: (blocked: boolean) => Promise<boolean>;
}) {
  const t = useTranslations("settings");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  /** Unmounted-after-await guard — the pane is swapped by a nav press, so this really happens. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const write = (unsubscribe: boolean) => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    void (async () => {
      try {
        // The switch reads "unsubscribe for me", the column stores "block it" — inverted exactly
        // once, here, at the seam between the two vocabularies.
        await setBlockAutoUnsubscribe(!unsubscribe);
      } catch {
        if (alive.current) setFailed(true);
      } finally {
        if (alive.current) setPending(false);
      }
    })();
  };

  return (
    <>
      <SettingsRow
        label={t("autoUnsub.title")}
        description={on ? t("autoUnsub.on") : t("autoUnsub.off")}
        control={
          <Switch
            checked={on}
            disabled={pending}
            ariaLabel={t("autoUnsub.title")}
            onChange={write}
          />
        }
      />
      <p className="set-note-inline">{t("autoUnsub.microcopy")}</p>
      {failed ? <span className="scn-sg-note">{t("autoUnsub.failed")}</span> : null}
    </>
  );
}
