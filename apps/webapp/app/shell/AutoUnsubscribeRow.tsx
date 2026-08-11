"use client";

/**
 * AUTO-UNSUBSCRIBE ON SCREEN-OUT — the switch for the one thing this product does that leaves the
 * building on somebody's behalf and cannot be recalled.
 *
 * ON (the product default) means: screening a waiting sender out, or pressing the Screener's spam
 * verb, also sends that sender's own one-click unsubscribe request. OFF means the mail is filed and
 * nothing is sent.
 *
 * ── WHAT THE DESCRIPTION MAY NOT SAY ──────────────────────────────────────────────────────────
 *
 * It must not promise that every screened-out sender is unsubscribed from. The request goes only
 * where the sender published `List-Unsubscribe` AND `List-Unsubscribe-Post` (RFC 8058 one-click);
 * a `mailto:`-only route is refused outright, because this product never sends mail on the user's
 * behalf, and most spam publishes no route at all. So the copy says "where the sender offers it"
 * and stops. It must not imply the switch retracts anything either: a request already sent is
 * gone, and turning this off changes only what happens next.
 *
 * ── WHY IT IS A PLAIN SWITCH AND NOT A CONFIRM ────────────────────────────────────────────────
 *
 * {@link AutoSuggestRow} gates its ON with a priced confirm because turning it on starts spending.
 * The dangerous direction here is the other one — ON is the default and is what the account already
 * has — so a confirm on the way up would be a ceremony in front of the state somebody is already
 * in. The consequence itself is disclosed where it is incurred: the sender sheet asks before the
 * click, and the Screener's toast says so after each decision. Both of those read the SAME flag
 * this switch writes, so turning it off stops the sentence and the sending together.
 *
 * ── IT WRITES THROUGH THE HOOK ────────────────────────────────────────────────────────────────
 *
 * `setBlockAutoUnsubscribe` is `useConsentState().setBlockAutoUnsubscribe`, never `consentApi`
 * directly, for `RemoteImagesRow`'s reason with a sharper edge: `AppShell` passes the same hook's
 * `autoUnsubscribe` into the sender sheet and the Screener, so writing through it stops the
 * disclosure on the same render. A component with its own fetch would leave an open sheet warning
 * about a request that will no longer be made.
 *
 * The switch renders the value the SERVER last answered with, never the optimistic pick, so a
 * refused write leaves it where it was — and in this direction that matters most: a switch drawn
 * OFF over a write that failed would tell somebody their lists are being left alone while every
 * screen-out goes on leaving one.
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
