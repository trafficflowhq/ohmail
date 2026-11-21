"use client";

import { leaveForManagePage } from "./manage-navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@ohmail/ui/base";
import { SettingLine, SettingsSheet } from "@ohmail/ui/mail";
import { account } from "../../api-client";
import { useManageOffer } from "./use-manage-offer";

export { useManageOffer };

/**
 * The subscription pane — one control, and nothing else. Whoever operates this service holds the plan,
 * the balance and the payment method; this app holds none of them and states none of them. What it can
 * do is take the customer to the page that does. THE ADDRESS IS MINTED BY THE PRESS: it used to be
 * minted by the MOUNT, so every shell mount and every settings visit minted a link for an account that
 * was only reading its mail. {@link useManageOffer} answers whether to offer the pane; the address is
 * asked for here, when somebody asks to go there. What is stored is Settings → Storage's
 * (`StorageSection`). `settings` keys and not a namespace of its own, because whole namespaces travel
 * into the desktop binary and `DesktopSubscription` reads the same two.
 */
export function SubscriptionSection({ onNowhere }: { onNowhere: () => void }) {
  const t = useTranslations("settings");
  /** The account page opens in this screen's language, as the wall's does. */
  const lang = useLocale() === "de" ? "de" : "en";
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  /** The pane can be left mid-press; nothing may set state after that. */
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const press = useCallback(async () => {
    setBusy(true);
    setFailed(false);
    try {
      const link = await account.manageLink({ lang });
      const url = link?.url;
      // A URL is a non-empty STRING or it is nothing. `{ url: "" }`, a 200 with no `url` at all
      // and the `null` of a 404 say the same thing — there is no page — and the answer to that is
      // to take the pane away, never to leave a control standing that goes nowhere.
      if (typeof url === "string" && url.length > 0) { leaveForManagePage(url); return; }
      onNowhere();
    } catch {
      // A refused mint — an unverified address, a server that did not answer. On a MOUNT that was
      // nothing a person could act on and was swallowed; on a PRESS it is the one thing they are
      // owed, because they asked and something has to be said.
      if (alive.current) setFailed(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [onNowhere, lang]);

  return (
    <SettingsSheet>
      {failed ? <p className="oh-text" role="alert">{t("subscriptionManageFailed")}</p> : null}
      <SettingLine label={t("subscription")} narrow="detail">
        {/* The link is minted by this press, so the control stays a button. */}
        <Button kind="quiet" size="s" icon="go" disabled={busy} onPress={() => { void press(); }}>
          {t("subscriptionManage")}
        </Button>
      </SettingLine>
    </SettingsSheet>
  );
}
