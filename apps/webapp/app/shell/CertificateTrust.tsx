"use client";

import { Fragment } from "react";
import { useTranslations } from "next-intl";
import { SettingsNote } from "@ohmail/ui";

import {
  certificateOfferOf, oneLine, trustClaims, type TrustOffer,
} from "@ohmail/app-logic/mailboxes/moved";

export { certificateOfferOf, trustClaims, type TrustOffer };

/**
 * THE TRUST LINE: a mail server on this computer (a gateway such as Proton Mail Bridge) serves its
 * own certificate, and the person may trust exactly that one. Unticked; it names the fingerprint to
 * compare; one line for one host, on the plaintext consent's rule; asked again on every new press
 * that meets it, never carried to a later sign-in.
 */
export function CertificateTrust(props: {
  /** The prefix of the checkboxes' ids: `<id>-imap`, `<id>-smtp`, or `<id>-both`. */
  id: string;
  offer: TrustOffer;
  /** The fingerprint each leg's line was ticked for. */
  ticked: TrustOffer;
  onChange: (protocol: "imap" | "smtp", ticked: string | undefined) => void;
  sameHost?: boolean;
}) {
  const t = useTranslations("mailboxes");
  const one = oneLine(props.offer, props.sameHost === true);
  const lines: Array<["imap" | "smtp" | "both", string]> = one !== null
    ? [["both", one]]
    : (["imap", "smtp"] as const).flatMap((k) => (props.offer[k] !== undefined ? [[k, props.offer[k]!] as [typeof k, string]] : []));
  if (lines.length === 0) return null;
  const label = { imap: "trustCertificateLabel", smtp: "trustCertificateLabelSmtp", both: "trustCertificateLabelBoth" } as const;
  return (
    <>
      {lines.map(([k, sha256]) => (
        <Fragment key={k}>
          <label className="join-label" htmlFor={`${props.id}-${k}`}>
            <input
              id={`${props.id}-${k}`} type="checkbox"
              aria-describedby={`${props.id}-${k}-print`}
              checked={k === "both" ? props.ticked.imap === sha256 && props.ticked.smtp === sha256 : props.ticked[k] === sha256}
              onChange={(e) => {
                const now = e.target.checked ? sha256 : undefined;
                if (k !== "both") { props.onChange(k, now); return; }
                props.onChange("imap", now);
                props.onChange("smtp", now);
              }}
            />{" "}
            {t(label[k])}
          </label>
          {/* The fingerprint, on its own line under the line that asks for it: text a reader can
            read whole, not an image; tied to the tick, so the consent says which certificate. */}
          <p id={`${props.id}-${k}-print`} className="join-fingerprint">{sha256}</p>
        </Fragment>
      ))}
      <SettingsNote icon="info">{t("trustCertificateNote")}</SettingsNote>
    </>
  );
}
