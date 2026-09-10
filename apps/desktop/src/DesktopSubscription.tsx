/**
 * THE SUBSCRIPTION PANE ON THE CLOUD DOOR — the same one row the browser tab shows.
 *
 * This window used to render the plan, the renewal date, a storage meter and a managed-AI
 * switch. None of that is this program's business any more: whoever operates the service holds
 * that state and serves its own page, and the entitlements port answers where that page is.
 *
 * A pane and not an omission, for `DesktopWebSection`'s reason: an absent entry reads as "this
 * product does not have that", and the site says otherwise. Absent when there is no page to
 * link to — see {@link useDesktopManageLink} for why that decision is the GATE's and not this
 * component's.
 *
 * `settings` keys, shared with the web pane, because whole namespaces travel into this binary.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { SettingsRow, SettingsSection } from "@ohmail/ui";

import { bridgeFetch } from "./bridge-fetch.js";

/**
 * The hosted route this pane addresses, root-relative like every path in this window.
 *
 * Exported for the reason the pane it replaces exported its own: the engine must FORWARD it on
 * this door rather than answer it from the mirror, which knows nothing about an account's
 * standing. `desktop-settings-census.test.ts` reads it.
 */
export const MANAGE_LINK_PATH = "/account/manage-link";

/**
 * WHERE THIS ACCOUNT MANAGES ITS SUBSCRIPTION, or `null` for "nowhere".
 *
 * A HOOK THE GATE CALLS, and not a `return null` inside the pane, because the two are not the
 * same thing: `SettingsView` grows the nav entry from the PROP being present, so a node that
 * renders nothing still puts "Subscription" in the nav and opens an empty pane on it. Only
 * withholding the node itself withholds the entry — the rule `invitesSection` and
 * `devicesSection` already follow. The desktop census asserts the entry is gone on a 404.
 *
 * `null` covers every "nowhere": an offline install, a server without the route, an account
 * whose address is not verified, and the moment before the first answer.
 */
export function useDesktopManageLink(): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await bridgeFetch(MANAGE_LINK_PATH, { method: "POST" });
        if (cancelled || !res.ok) return;
        const body = (await res.json()) as { url?: unknown };
        // A URL is a non-empty STRING or it is nothing.
        if (!cancelled && typeof body.url === "string" && body.url.length > 0) setUrl(body.url);
      } catch {
        /* Nowhere to send them, and none of these is something a person can act on here. */
      }
    })();
    return () => { cancelled = true; };
  }, []);
  return url;
}

export function DesktopSubscription({ url }: { url: string }) {
  const t = useTranslations("settings");
  return (
    <SettingsSection>
      <SettingsRow
        label={t("subscription")}
        control={
          /* An ordinary anchor: `enableExternalLinks` is armed in this build, so the click is
             intercepted and the address goes to the platform's own browser — where the person is
             already signed in — rather than navigating this window. */
          <a className="btn" href={url} target="_blank" rel="noopener noreferrer">
            {t("subscriptionManage")}
          </a>
        }
      />
    </SettingsSection>
  );
}
