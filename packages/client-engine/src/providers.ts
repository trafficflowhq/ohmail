/**
 * The mailbox providers the app offers to connect, and what each needs.
 * Four surfaces ask, and the phone may not carry vendor names in its own
 * sources, so the list lives in the one package every client imports; the
 * web shell re-exports it. It is exactly `messages/en.json` → `providers`,
 * same order plus the generic IMAP entry (a parity check bites both ways).
 * Every `note` is the app-password path, written to be true today. OAuth is
 * Microsoft-only and gated live by `GET …/oauth/microsoft/availability` —
 * no button that cannot work; Gmail stays app-password only.
 */

import { domainOfAddress } from "./consent-cutline.js";

export interface ProviderPreset {
  /** Stable id — also the mailbox's stored `provider`, which adapter selection reads. */
  id: string;
  /**
   * The label, matching the landing's `providers.*` string. For every named provider this is a
   * BRAND NAME and renders verbatim in every language; the generic entry's label is the one piece
   * of prose here, and render sites take it from the catalogue instead — see {@link providerLabel}.
   */
  label: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  /** What to do before coming back with a password. Factual; no reassurance padding. */
  note: string;
  /** Where the provider documents its app passwords. Empty for the generic entry. */
  helpUrl?: string;
  /** The label for {@link ProviderPreset.helpUrl}. */
  helpLabel?: string;
  /** `true` ⇒ the host/port fields are shown and required (the generic IMAP entry). */
  manual?: boolean;
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: "gmail",
    label: "Gmail",
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    note:
      "Gmail requires an App Password, and App Passwords require 2-Step Verification to be on. " +
      "Create one for “Mail”, then paste the 16-character password here — not your Google password.",
    helpUrl: "https://myaccount.google.com/apppasswords",
    helpLabel: "Google App Passwords",
  },
  {
    id: "microsoft",
    label: "Microsoft 365 & Outlook.com",
    imap: { host: "outlook.office365.com", port: 993, secure: true },
    smtp: { host: "smtp.office365.com", port: 587, secure: false },
    /*
     * Every clause here is judged against the code, so each one is pinned to what it describes:
     *  · "over IMAP" stays true for BOTH doors — the Microsoft sign-in authenticates the same IMAP
     *    and SMTP connection with XOAUTH2 (`buildImapAuth`), it does not switch to Graph.
     *  · The sign-in sentence is conditional ("when this deployment has …") because the button is
     *    conditional. It promises nothing about whether it will be there.
     *  · The app-password clauses are unchanged: still exactly true, and still the only path on a
     *    deployment with no registration.
     */
    note:
      "ohmail connects to Microsoft over IMAP, like every other mailbox — native Exchange sync " +
      "over Microsoft Graph is on the roadmap and is not shipped. When this deployment has a " +
      "Microsoft application registration, you can sign in with Microsoft instead and no password " +
      "is stored; that option is offered only where it is actually configured. Otherwise you need " +
      "an app password, which requires security defaults to be off on the account; on some work " +
      "tenants an administrator has disabled IMAP entirely, and then it cannot connect at all.",
    helpUrl: "https://support.microsoft.com/account-billing/manage-app-passwords-for-two-step-verification-d6dc8c6d-4bf7-4851-ad95-6d07799387e9",
    helpLabel: "Microsoft app passwords",
  },
  {
    id: "icloud",
    label: "iCloud Mail",
    imap: { host: "imap.mail.me.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
    note:
      "iCloud needs an app-specific password (Apple ID → Sign-In and Security). Your username is " +
      "usually the full @icloud.com address, even if you sign in to Apple with a different one.",
    helpUrl: "https://account.apple.com/account/manage",
    helpLabel: "Apple ID · app-specific passwords",
  },
  {
    id: "yahoo",
    label: "Yahoo",
    imap: { host: "imap.mail.yahoo.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.yahoo.com", port: 465, secure: true },
    note:
      "Yahoo requires an app password generated under Account Security. The account password " +
      "will not work for IMAP.",
    helpUrl: "https://login.yahoo.com/account/security",
    helpLabel: "Yahoo Account Security",
  },
  {
    id: "fastmail",
    label: "Fastmail",
    imap: { host: "imap.fastmail.com", port: 993, secure: true },
    smtp: { host: "smtp.fastmail.com", port: 465, secure: true },
    note:
      "Create an app password in Settings → Privacy & Security → Integrations, scoped to " +
      "“Mail (IMAP/SMTP)”. Fastmail lets you revoke it on its own later.",
    helpUrl: "https://app.fastmail.com/settings/security/apppasswords",
    helpLabel: "Fastmail app passwords",
  },
  {
    id: "gmx",
    label: "GMX",
    imap: { host: "imap.gmx.net", port: 993, secure: true },
    smtp: { host: "mail.gmx.net", port: 587, secure: false },
    note:
      "GMX ships with IMAP switched OFF. Turn it on first in Settings → POP3 & IMAP, then use " +
      "your ordinary GMX password here.",
    helpUrl: "https://support.gmx.com/pop-imap/imap/index.html",
    helpLabel: "GMX · enabling IMAP",
  },
  {
    id: "infomaniak",
    label: "Infomaniak",
    imap: { host: "mail.infomaniak.com", port: 993, secure: true },
    smtp: { host: "mail.infomaniak.com", port: 587, secure: false },
    note:
      "Use your mailbox address and its password. If the account has two-factor authentication, " +
      "create an application password in the Infomaniak Manager first.",
    helpUrl: "https://www.infomaniak.com/en/support/faq/2224",
    helpLabel: "Infomaniak · mail settings",
  },
  {
    id: "imap",
    label: "Any other IMAP mailbox",
    imap: { host: "", port: 993, secure: true },
    smtp: { host: "", port: 587, secure: false },
    note:
      "Your own domain, your own server, or a provider not listed. You need the IMAP host, the " +
      "SMTP host, and a password for the mailbox. Your provider's help pages call these " +
      "“incoming” and “outgoing” servers.",
    manual: true,
  },
];

export const providerById = (id: string): ProviderPreset =>
  PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[PROVIDERS.length - 1]!;

/**
 * The hosts a newly chosen preset imposes — for the generic entry, neither.
 * Named presets write their hosts into the form; the generic entry's hosts
 * are empty strings, and copying that emptiness deleted what somebody had
 * typed. Reachable without changing your mind: the checked tile is the
 * radiogroup's tab stop, so Space/Enter or a click re-fires the choice —
 * both wiped IMAP and SMTP hosts silently, off screen. A preset with a host
 * imposes it; one without leaves what is there. Empty is not a value here;
 * absence must not overwrite.
 */
/**
 * Provenance is the whole rule; leaving it out was a credential leak: the
 * host field does not record who put the value there. Choose Gmail (form
 * fills `imap.gmail.com`), then "any other IMAP mailbox" (no host) — the
 * Gmail host survived, pre-filled and easy to miss; the person typed their
 * own server's password and the probe dialed Gmail with it. The previous
 * choice is a parameter: values are the person's own exactly when the
 * previous choice was also manual — a preset's value never survives into a
 * different provider's attempt.
 */
export const hostsFor = (
  next: ProviderPreset,
  current: { imapHost: string; smtpHost: string },
  previous: ProviderPreset | null,
): { imapHost: string; smtpHost: string } => {
  // A named preset always imposes its own hosts — they are the fact the app knows.
  if (!next.manual) return { imapHost: next.imap.host, smtpHost: next.smtp.host };
  // The generic entry has nothing to impose. Keep what is there only when it is the person's
  // own typing, which is exactly when they were already on the generic entry.
  return previous?.manual
    ? { imapHost: current.imapHost, smtpHost: current.smtpHost }
    : { imapHost: "", smtpHost: "" };
};

/**
 * THE LABEL A RENDER SITE PUTS ON SCREEN — which is not always {@link ProviderPreset.label}.
 *
 * Seven of the eight labels are brand names and are the same string in every language. The
 * generic entry's is a SENTENCE ("Any other IMAP mailbox"), and it stayed English in a German
 * session because both render sites read it straight off this table. They now go through here
 * with the `providerPicker` translator, so the picker tile and the connected-mailbox row take
 * the translated label from one place — the constant above remains the identity the parity
 * check judges and the fallback nothing renders.
 */
export const providerLabel = (
  p: ProviderPreset,
  t: (key: "otherLabel") => string,
): string => (p.manual ? t("otherLabel") : p.label);

/**
 * `secure` is IMPLICIT TLS (port 993 / 465), not "is this connection encrypted".
 *
 * Port 587 SMTP is `secure: false` here and still upgrades to TLS via STARTTLS — the flag
 * names the socket's initial state, which is the distinction the IMAP/SMTP libraries draw.
 * Written down because "secure: false" on a submission port reads like a downgrade and is
 * not one, and somebody will eventually try to "fix" it.
 */
export const portMeansImplicitTls = (port: number): boolean => port === 993 || port === 465;

/**
 * The domains each named preset actually serves. Only used by {@link presetForAddress}, and only
 * ever to PRE-FILL a form the person can see and correct — never to decide what to dial.
 *
 * The generic entry has no domains by construction: it is the answer when none of these match.
 */
const PRESET_DOMAINS: ReadonlyArray<{ id: string; domains: readonly string[] }> = [
  { id: "gmail", domains: ["gmail.com", "googlemail.com"] },
  {
    id: "microsoft",
    domains: [
      "outlook.com", "outlook.de", "hotmail.com", "hotmail.co.uk", "hotmail.de", "hotmail.fr",
      "live.com", "live.co.uk", "live.de", "msn.com",
    ],
  },
  { id: "icloud", domains: ["icloud.com", "me.com", "mac.com"] },
  {
    id: "yahoo",
    domains: ["yahoo.com", "yahoo.co.uk", "yahoo.de", "yahoo.fr", "ymail.com", "rocketmail.com"],
  },
  { id: "fastmail", domains: ["fastmail.com", "fastmail.fm"] },
  { id: "gmx", domains: ["gmx.net", "gmx.de", "gmx.ch", "gmx.at", "gmx.com"] },
  { id: "infomaniak", domains: ["infomaniak.com", "infomaniak.ch", "ik.me", "ikmail.com"] },
];

/**
 * THE PRESET A TYPED ADDRESS SUGGESTS — `null` when nothing is suggested, never the generic entry.
 *
 * `null` and "the generic entry" are different answers and collapsing them would cost the caller
 * the only thing it needs to know: whether this app has a host to offer. A surface with no provider
 * picker (the phone's standalone door) has the address and nothing else, so this is the whole of
 * its guess — and a guess is all it is. The caller pre-fills the fields it shows and the person can
 * overwrite every one of them, which is the same provenance rule {@link hostsFor} states for the
 * picker: a value this app put there must never survive into a different server's attempt.
 */
export const presetForAddress = (address: string): ProviderPreset | null => {
  const domain = domainOfAddress(address);
  if (domain === null) return null;
  const row = PRESET_DOMAINS.find((entry) => entry.domains.includes(domain));
  return row ? providerById(row.id) : null;
};

/** A form's server fields as strings, which is what every one of these surfaces holds them as. */
export interface ServerGuess {
  readonly imapHost: string;
  readonly imapPort: string;
  readonly imapTls: boolean;
  readonly smtpHost: string;
  readonly smtpPort: string;
  /** The preset this came from, or `null` — the caller says so rather than implying it. */
  readonly from: string | null;
}

/**
 * What to put in the server fields for a typed address. An unrecognised domain answers with the
 * generic entry's PORTS and empty hosts: the ports are the same two numbers for every mailbox
 * worth pre-filling, and an empty host is the absence of a value rather than a wrong one.
 */
export const serverGuessFor = (address: string): ServerGuess => {
  const preset = presetForAddress(address) ?? providerById("imap");
  return {
    imapHost: preset.imap.host,
    imapPort: String(preset.imap.port),
    imapTls: portMeansImplicitTls(preset.imap.port),
    smtpHost: preset.smtp.host,
    smtpPort: String(preset.smtp.port),
    from: preset.manual === true ? null : preset.id,
  };
};
