"use client";

/**
 * The address-first helper's one piece of markup. The helper itself (the hook, the table's guess, the two waits and
 * how a found server fills a host field) stands with the connect form's rules, and is re-exported here for
 * the forms that import it by this path.
 */

import { useTranslations } from "next-intl";
import { hostFieldOf } from "@ohmail/app-logic/mailboxes/moved";
import type { DiscoveredServer, Discovery } from "./providers";

export * from "@ohmail/app-logic/mailboxes/moved";

/**
 * THE HOSTS THE LOOKUP FOUND, offered after a refusal for an unreachable host on the manual tile. The press
 * fills the fields and nothing else; the next connect proves them. Nothing when nothing was found, or when
 * the fields already hold it.
 */
export function DiscoveredHostsOffer({ guess, imapHost, smtpHost, onUse }: {
  guess: Discovery | null;
  imapHost: string;
  smtpHost: string;
  onUse: (servers: { imap: DiscoveredServer | null; smtp: DiscoveredServer | null }) => void;
}) {
  const t = useTranslations("providerPicker");
  const imap = guess?.imap ?? null;
  const smtp = guess?.smtp ?? null;
  if (!imap && !smtp) return null;
  const same = (!imap || hostFieldOf(imap, "imap") === imapHost.trim())
    && (!smtp || hostFieldOf(smtp, "smtp") === smtpHost.trim());
  if (same) return null;
  const servers = [imap ? `IMAP ${hostFieldOf(imap, "imap")}` : null, smtp ? `SMTP ${hostFieldOf(smtp, "smtp")}` : null]
    .filter(Boolean).join(", ");
  return (
    <p className="join-hint" role="status">
      {t("discoveredHosts", { servers })}{" "}
      <button type="button" className="join-alt" onClick={() => onUse({ imap, smtp })}>{t("discoveredUse")}</button>
    </p>
  );
}
