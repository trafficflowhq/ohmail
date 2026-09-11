"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { SettingsRow, SettingsSection } from "@ohmail/ui";
import { account, apiConfigured } from "../../api-client";

/**
 * The subscription pane — a link, and nothing else. Whoever operates this service holds the plan,
 * the balance and the payment method; this app holds none of them and therefore states none of
 * them. What it can do is take the customer to the page that does, which is what the entitlements
 * port answers with. The `settings` namespace and not one of its own: whole namespaces travel into
 * the desktop binary (`SHELL_MESSAGE_NAMESPACES`), so a pane's copy lives where the rest of the
 * desktop's settings copy lives — `DesktopSubscription` reads the same two keys.
 */
export function SubscriptionSection({ url }: { url: string }) {
  const t = useTranslations("settings");
  return (
    <SettingsSection>
      <SettingsRow
        label={t("subscription")}
        control={
          /* `noreferrer` beside `noopener`: the address is minted for this account, and the
             referrer would otherwise carry this app's own URL to whoever serves that page.
             In the desktop window `shell/open-external.ts` intercepts the click and hands the
             address to the platform's opener, so this is one anchor for both surfaces. */
          <a className="btn" href={url} target="_blank" rel="noopener noreferrer">
            {t("subscriptionManage")}
          </a>
        }
      />
    </SettingsSection>
  );
}

/**
 * Where this account manages its subscription, or `null` for "nowhere". `null` is the answer for
 * a self-hosted or unmetered install, an unverified address, a server too old to know the route,
 * and the moment before the first answer arrives — all four mean DO NOT OFFER THE PANE, and
 * collapsing them is deliberate: the alternative is a nav entry above an empty pane, the shape
 * `invitesSection` and `devicesSection` are written to avoid. It never sets an error: a manage link
 * nobody could fetch is not a failure a person can act on from a settings screen, and the refusal
 * they would actually meet — the lock screen — comes from the port through a different door.
 */
export function useManageLink(demo: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    // The landing page's mailbox reaches no server and has no account to ask about.
    if (demo || !apiConfigured()) return;
    let alive = true;
    void account.manageLink()
      // A URL is a non-empty STRING or it is nothing. `{ url: "" }` and a 200 with no `url` at
      // all are both "we were not told", and neither may become a control on a settings pane.
      .then((link) => {
        const u = link?.url;
        if (alive) setUrl(typeof u === "string" && u.length > 0 ? u : null);
      })
      // A refused ask (unverified address, dead server) is not evidence a page exists. The 404
      // arm answers `null` above; this arm is every other failure, and it says the same thing.
      .catch(() => { /* nowhere to send them */ });
    return () => { alive = false; };
  }, [demo]);
  return url;
}
