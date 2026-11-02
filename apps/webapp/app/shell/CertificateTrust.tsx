"use client";

import { useTranslations } from "next-intl";
import { SettingsNote } from "@ohmail/ui";

/** Fingerprints per leg (Node's `fingerprint256` form): offered by a refusal or a test, or ticked. */
export type TrustOffer = { imap?: string; smtp?: string };

/**
 * The certificate a refusal offers to trust, and for which leg: `details.tls.certificate` on a
 * mail server on this computer (the desktop's local door alone sends one), or `null`.
 */
export function certificateOfferOf(err: unknown): { transport: "imap" | "smtp"; sha256: string } | null {
  const e = err as { code?: unknown; details?: unknown } | null | undefined;
  if (typeof e !== "object" || e === null || e.code !== "mailbox_probe_failed") return null;
  const d = e.details as { transport?: unknown; tls?: { kind?: unknown; certificate?: { sha256?: unknown } } } | null | undefined;
  const sha256 = d?.tls?.kind === "self_signed" ? d.tls.certificate?.sha256 : undefined;
  return typeof sha256 === "string" && sha256 !== "" ? { transport: d!.transport === "smtp" ? "smtp" : "imap", sha256 } : null;
}

/** One line covers both legs: one host, and no second certificate that differs. */
function oneLine(offer: TrustOffer, sameHost: boolean): string | null {
  const one = offer.imap ?? offer.smtp;
  if (!sameHost || one === undefined) return null;
  return offer.imap !== undefined && offer.smtp !== undefined && offer.imap !== offer.smtp ? null : one;
}

/**
 * The fingerprints a press claims (`trustCertificate`): each line ticked FOR THE FINGERPRINT IT NOW
 * SHOWS — a certificate that changed un-ticks its line — and with one line for one host, both blocks.
 * Each is a claim its own probe re-reads against the certificate it is shown.
 */
export function trustClaims(offer: TrustOffer, ticked: TrustOffer, sameHost: boolean): TrustOffer {
  const one = oneLine(offer, sameHost);
  const offered = one !== null ? { imap: one, smtp: one } : offer;
  return {
    ...(offered.imap !== undefined && ticked.imap === offered.imap ? { imap: offered.imap } : {}),
    ...(offered.smtp !== undefined && ticked.smtp === offered.smtp ? { smtp: offered.smtp } : {}),
  };
}

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
        <label key={k} className="join-label" htmlFor={`${props.id}-${k}`}>
          <input
            id={`${props.id}-${k}`} type="checkbox"
            checked={k === "both" ? props.ticked.imap === sha256 && props.ticked.smtp === sha256 : props.ticked[k] === sha256}
            onChange={(e) => {
              const now = e.target.checked ? sha256 : undefined;
              if (k !== "both") { props.onChange(k, now); return; }
              props.onChange("imap", now);
              props.onChange("smtp", now);
            }}
          />{" "}
          {t(label[k], { fingerprint: sha256 })}
        </label>
      ))}
      <SettingsNote icon="shield">{t("trustCertificateNote")}</SettingsNote>
    </>
  );
}
