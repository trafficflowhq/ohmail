"use client";

import { useTranslations } from "next-intl";
import { SettingsNote } from "@ohmail/ui";

/**
 * THE PLAINTEXT CONSENT, one line per protocol the server offered it for (`plaintextOfferOf`),
 * and the warning under them. One markup for Settings → Mailboxes and the add-a-mailbox run, so
 * the words a person consents over cannot differ between the two.
 */
export function PlaintextConsent(props: {
  ids: { imap: string; smtp: string };
  offer: { imap: boolean; smtp: boolean };
  checked: { imap: boolean; smtp: boolean };
  onChange: (protocol: "imap" | "smtp", checked: boolean) => void;
}) {
  const t = useTranslations("mailboxes");
  if (!props.offer.imap && !props.offer.smtp) return null;
  return (
    <>
      {(["imap", "smtp"] as const).filter((k) => props.offer[k]).map((k) => (
        <label key={k} className="join-label" htmlFor={props.ids[k]}>
          <input
            id={props.ids[k]} type="checkbox" checked={props.checked[k]}
            onChange={(e) => props.onChange(k, e.target.checked)}
          />{" "}
          {t(k === "imap" ? "insecureConsentLabel" : "insecureConsentLabelSmtp")}
        </label>
      ))}
      <SettingsNote icon="shield">{t("insecureConsentWarning")}</SettingsNote>
    </>
  );
}
