/**
 * THE TWO CONSENTS. First the rules moved out of the web shell's `PlaintextConsent.tsx` and `CertificateTrust.tsx`
 * as they stood: which blocks a press may claim `allowInsecure` and `trustCertificate` on, and what a thrown refusal
 * offers to trust. Under them, the one form's consents as records, read through those rules.
 */
import { sendingPlaintextOffered } from "../../doors/onboarding.js";
import { FINGERPRINT, certificateOfferOf as certificateOffered, plaintextOfferOf } from "./refusal.js";
import type { ConnectProbed, Leg, Refusal } from "./types.js";

export type Protocols = { imap: boolean; smtp: boolean };

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

/** Fingerprints per leg (Node's `fingerprint256` form): offered by a refusal or a test, or ticked. */
export type TrustOffer = { imap?: string; smtp?: string };

/**
 * The certificate a refusal offers to trust, and for which leg: `details.tls.certificate` on a
 * mail server on this computer (the desktop's local door alone sends one), or `null`.
 */
export function certificateOfferOf(err: unknown): { transport: "imap" | "smtp"; sha256: string } | null {
  const e = err as { code?: unknown; details?: unknown } | null | undefined;
  if (typeof e !== "object" || e === null || e.code !== "mailbox_probe_failed") return null;
  const d = e.details as
    { transport?: unknown; tls?: { kind?: unknown; certificate?: { sha256?: unknown } } } | null | undefined;
  const sha256 = d?.tls?.kind === "self_signed" ? d.tls.certificate?.sha256 : undefined;
  return typeof sha256 === "string" && sha256 !== ""
    ? { transport: d!.transport === "smtp" ? "smtp" : "imap", sha256 }
    : null;
}

/** One line covers both legs: one host, and no second certificate that differs. */
export function oneLine(offer: TrustOffer, sameHost: boolean): string | null {
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

/*
 * THE ONE FORM'S CONSENTS, as records. An offer and a tick each name their kind, their leg, the server the press
 * dialled for that leg and, for a certificate, its fingerprint. What a press claims is derived at the press against
 * the servers the form holds then, so a consent given for one server is none for another.
 */

export type ConsentOffer =
  | { readonly kind: "plain"; readonly leg: Leg; readonly host: string }
  | { readonly kind: "certificate"; readonly leg: Leg; readonly host: string; readonly sha256: string };

export interface Consents {
  /** What the server offered, each for the server a press dialled. Nothing typed, stored or routed makes one. */
  readonly offers: readonly ConsentOffer[];
  /** What the person ticked: the same record, so a tick is for one server and, for a certificate, one fingerprint. */
  readonly ticks: readonly ConsentOffer[];
}
export const NO_CONSENTS: Consents = Object.freeze({ offers: Object.freeze([]), ticks: Object.freeze([]) });

/** The servers a press dialled, each as the form named it; `null`: that leg was not dialled. */
export type Dialled = { readonly imap: string; readonly smtp: string | null };
/** The servers the form holds now, each as a press would name it. */
export type HostsNow = Readonly<Record<Leg, string>>;

/** What a refusal of this press offers, and only for a leg the press dialled. */
export function offersOfRefusal(refusal: Refusal, sent: Dialled): ConsentOffer[] {
  const offers: ConsentOffer[] = [];
  const plain = plaintextOfferOf(refusal);
  const plainHost = plain === null ? null : sent[plain];
  if (plain !== null && plainHost !== null) offers.push({ kind: "plain", leg: plain, host: plainHost });
  const own = certificateOffered(refusal);
  const ownHost = own === null ? null : sent[own.transport];
  if (own !== null && ownHost !== null)
    offers.push({ kind: "certificate", leg: own.transport, host: ownHost, sha256: own.sha256 });
  return offers;
}

/** What a passed test's sending verdict offers for the outgoing server: no encryption on this network, or its own certificate. */
export function offersOfProbed(ok: ConnectProbed, sent: Dialled): ConsentOffer[] {
  if (sent.smtp === null) return [];
  if (sendingPlaintextOffered(ok.sending)) return [{ kind: "plain", leg: "smtp", host: sent.smtp }];
  const sha256 =
    ok.sending?.state === "refused" && ok.sending.tls?.kind === "self_signed"
      ? ok.sending.tls.certificate?.sha256
      : undefined;
  return typeof sha256 === "string" && FINGERPRINT.test(sha256)
    ? [{ kind: "certificate", leg: "smtp", host: sent.smtp, sha256 }]
    : [];
}

/** New offers take the place of older ones of their kind and leg. A tick is untouched: it stands for what it was given for. */
export function withOffers(consents: Consents, offers: readonly ConsentOffer[]): Consents {
  if (offers.length === 0) return consents;
  const replaced = (o: ConsentOffer): boolean => offers.some((n) => n.kind === o.kind && n.leg === o.leg);
  return { offers: [...consents.offers.filter((o) => !replaced(o)), ...offers], ticks: consents.ticks };
}

/**
 * What stands after a REFUSED press: its own offers, beside older ones of another kind or leg (two servers that both
 * lack encryption are consented to one after the other). A refusal that offers nothing leaves no offer and no tick:
 * no line stays ticked beside a sentence that says otherwise, and the server's next refusal offers it again.
 */
export function afterRefusal(consents: Consents, offers: readonly ConsentOffer[]): Consents {
  return offers.length === 0 ? NO_CONSENTS : withOffers(consents, offers);
}

/** One server on both legs, as the form names them now. A stored server is never said to be the other. */
const oneHost = (now: HostsNow): boolean =>
  now.imap !== "" && !now.imap.startsWith("stored") && now.imap === now.smtp;
const LEGS = ["imap", "smtp"] as const;

/** No encryption, per leg, for the servers the form holds now: offered, and ticked. */
function plainNow(consents: Consents, now: HostsNow): { offer: Protocols; checked: Protocols } {
  const has = (list: readonly ConsentOffer[], leg: Leg): boolean =>
    list.some((o) => o.kind === "plain" && o.leg === leg && o.host === now[leg]);
  return {
    offer: { imap: has(consents.offers, "imap"), smtp: has(consents.offers, "smtp") },
    checked: { imap: has(consents.ticks, "imap"), smtp: has(consents.ticks, "smtp") },
  };
}

/** The fingerprints, per leg, for the servers the form holds now: offered, and ticked. */
function trustNow(consents: Consents, now: HostsNow): { offer: TrustOffer; ticked: TrustOffer } {
  const print = (list: readonly ConsentOffer[], leg: Leg): string | undefined => {
    const found = list.find((o) => o.kind === "certificate" && o.leg === leg && o.host === now[leg]);
    return found?.kind === "certificate" ? found.sha256 : undefined;
  };
  const of = (list: readonly ConsentOffer[]): TrustOffer => {
    const imap = print(list, "imap");
    const smtp = print(list, "smtp");
    return { ...(imap !== undefined ? { imap } : {}), ...(smtp !== undefined ? { smtp } : {}) };
  };
  return { offer: of(consents.offers), ticked: of(consents.ticks) };
}

/** A line the form draws: unticked until pressed. */
export type ConsentLine =
  | { readonly kind: "plain"; readonly legs: Leg | "both"; readonly on: boolean }
  | {
      readonly kind: "certificate";
      readonly legs: Leg | "both";
      readonly on: boolean;
      readonly sha256: string;
    };

/** The lines to draw for the servers the form holds now: one for both legs where they are one server. */
export function linesOf(consents: Consents, now: HostsNow): ConsentLine[] {
  const both = oneHost(now);
  const lines: ConsentLine[] = [];
  const plain = plainNow(consents, now);
  if (both && (plain.offer.imap || plain.offer.smtp))
    lines.push({ kind: "plain", legs: "both", on: plain.checked.imap && plain.checked.smtp });
  else
    for (const leg of LEGS)
      if (plain.offer[leg]) lines.push({ kind: "plain", legs: leg, on: plain.checked[leg] });
  const trust = trustNow(consents, now);
  const one = oneLine(trust.offer, both);
  if (one !== null)
    lines.push({
      kind: "certificate",
      legs: "both",
      sha256: one,
      on: trust.ticked.imap === one && trust.ticked.smtp === one,
    });
  else
    for (const leg of LEGS) {
      const sha256 = trust.offer[leg];
      if (sha256 !== undefined)
        lines.push({ kind: "certificate", legs: leg, sha256, on: trust.ticked[leg] === sha256 });
    }
  return lines;
}

/**
 * A line pressed. Ticking records what the line stands for now: the server, and for a certificate the fingerprint
 * shown. The line for both legs ticks both. A press on a line no standing offer draws records nothing.
 */
export function withTick(
  consents: Consents,
  kind: ConsentOffer["kind"],
  legs: Leg | "both",
  on: boolean,
  now: HostsNow,
): Consents {
  const wanted: readonly Leg[] = legs === "both" ? LEGS : [legs];
  const line = linesOf(consents, now).find((l) => l.kind === kind && l.legs === legs);
  const rest = consents.ticks.filter((t) => !(t.kind === kind && wanted.includes(t.leg)));
  if (!on || line === undefined) return { offers: consents.offers, ticks: rest };
  const records = wanted.map((leg): ConsentOffer =>
    line.kind === "certificate"
      ? { kind: "certificate", leg, host: now[leg], sha256: line.sha256 }
      : { kind: "plain", leg, host: now[leg] },
  );
  return { offers: consents.offers, ticks: [...rest, ...records] };
}

/**
 * WHAT A PRESS MAY CLAIM, derived now: `allowInsecure` and `trustCertificate` for a leg only where an offer and a
 * tick stand for the server the form holds for that leg, and for a certificate the fingerprint ticked is the one
 * offered. One server on both legs claims both, on the moved rules.
 */
export function claimsOf(
  consents: Consents,
  now: HostsNow,
): Record<Leg, { allowInsecure?: true; trustCertificate?: string }> {
  const both = oneHost(now);
  const plain = plainNow(consents, now);
  const trust = trustNow(consents, now);
  const insecure = plaintextClaims(plain.offer, plain.checked, both);
  const trusted = trustClaims(trust.offer, trust.ticked, both);
  const claim = (leg: Leg): { allowInsecure?: true; trustCertificate?: string } => {
    const print = trusted[leg];
    return {
      ...(insecure[leg] ? { allowInsecure: true as const } : {}),
      ...(print !== undefined ? { trustCertificate: print } : {}),
    };
  };
  return { imap: claim("imap"), smtp: claim("smtp") };
}
