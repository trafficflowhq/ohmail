/**
 * SETTINGS → ACCOUNT ON THE PAIRED BROWSER: its own Sign out. The shared shell has none of its own,
 * and this page's `api-client` is the refusing stub, so the press goes through the gate, which runs
 * the bearer's sign-out (the computer told with this browser's bearer, or owed when it is out of
 * reach) and lands on the pairing screen. One press and a confirm: what this browser kept for the
 * pairing (queued changes, unfinished drafts) goes with it.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, SettingsSection } from "@ohmail/ui";

export function HostAccountPane({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const t = useTranslations("pairLanding");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const signOut = (): void => {
    setBusy(true);
    // The gate replaces this pane with the pairing screen; nothing here is touched after the press.
    void onSignOut();
  };

  return (
    <SettingsSection className="acct acct-session">
      <h2 className="acct-h">{t("signOut")}</h2>
      <div className="acct-signout">
        <div>
          <p className="acct-fine" role={confirming ? "alert" : undefined}>
            {confirming ? t("signOutConfirm") : t("signOutBody")}
          </p>
        </div>
        {confirming ? (
          <span className="acct-actions">
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              {t("signOutCancel")}
            </Button>
            <Button className="acct-signout-btn danger" variant="primary" icon="door" disabled={busy} onClick={signOut}>
              {t("signOut")}
            </Button>
          </span>
        ) : (
          <Button className="acct-signout-btn" icon="door" onClick={() => setConfirming(true)}>
            {t("signOut")}
          </Button>
        )}
      </div>
    </SettingsSection>
  );
}
