"use client";

import { useTranslations } from "next-intl";
import { SettingsNote } from "@ohmail/ui";

type Protocols = { imap: boolean; smtp: boolean };

/** One server on both legs: the incoming and the outgoing host are the same name, case and spaces aside. */
export function sameServerHost(incoming: string, outgoing: string): boolean {
  const a = incoming.trim().toLowerCase();
  return a !== "" && a === outgoing.trim().toLowerCase();
}

/**
 * The blocks a press carries `allowInsecure` on: a ticked line the server offered, and with one host
 * for both legs, both — one consent covers that server. Each is a claim its own probe re-proves.
 */
export function plaintextClaims(offer: Protocols, checked: Protocols, sameHost: boolean): Protocols {
  const offered = sameHost && (offer.imap || offer.smtp) ? { imap: true, smtp: true } : offer;
  return { imap: offered.imap && checked.imap, smtp: offered.smtp && checked.smtp };
}

/**
 * THE PLAINTEXT CONSENT, one line per protocol the server offered it for (`plaintextOfferOf`),
 * and the warning under them. One markup for Settings → Mailboxes and the add-a-mailbox run, so
 * the words a person consents over cannot differ between the two. Where both legs are one host
 * the line is one, for both, and ticking it ticks both.
 */
export function PlaintextConsent(props: {
  /** The prefix of the checkboxes' ids: `<id>-imap`, `<id>-smtp`, or `<id>-both`. */
  id: string;
  offer: Protocols;
  checked: Protocols;
  onChange: (protocol: "imap" | "smtp", checked: boolean) => void;
  /** The outgoing server is the incoming one ({@link sameServerHost}). */
  sameHost?: boolean;
}) {
  const t = useTranslations("mailboxes");
  if (!props.offer.imap && !props.offer.smtp) return null;
  const lines = props.sameHost === true ? (["both"] as const) : (["imap", "smtp"] as const).filter((k) => props.offer[k]);
  const label = { imap: "insecureConsentLabel", smtp: "insecureConsentLabelSmtp", both: "insecureConsentLabelBoth" } as const;
  return (
    <>
      {lines.map((k) => (
        <label key={k} className="join-label" htmlFor={`${props.id}-${k}`}>
          <input
            id={`${props.id}-${k}`} type="checkbox"
            checked={k === "both" ? props.checked.imap && props.checked.smtp : props.checked[k]}
            onChange={(e) => {
              if (k !== "both") { props.onChange(k, e.target.checked); return; }
              props.onChange("imap", e.target.checked);
              props.onChange("smtp", e.target.checked);
            }}
          />{" "}
          {t(label[k])}
        </label>
      ))}
      <SettingsNote icon="shield">{t("insecureConsentWarning")}</SettingsNote>
    </>
  );
}
