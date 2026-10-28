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
  /** What must be on before the help page offers anything (Google: 2-Step Verification). */
  prereqUrl?: string;
  /** The label for {@link ProviderPreset.prereqUrl}. */
  prereqLabel?: string;
  /** The account the person signs in to the provider with, as its sentences name it ("Google"). */
  account?: string;
  /** `true` ⇒ the provider takes an app password, never the account's own: see {@link passwordLabelKey}. */
  appPassword?: true;
  /**
   * `true` ⇒ a refused sign-in on this provider's hosts arrives with an `authHint` ({@link AUTH_HINTS}),
   * and the surfaces say its own sentence and links rather than the generic one.
   */
  authHints?: true;
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
      "Gmail signs in only with an App Password, not your Google password. Turn on 2-Step " +
      "Verification first, or the App Passwords page says it is not available. Give the App Password " +
      "any name, then paste its 16 letters here, with or without the spaces. Some work, school and " +
      "Advanced Protection accounts, and accounts that sign in with security keys only, cannot create App " +
      "Passwords; ohmail cannot connect those yet: ask your administrator to allow App Passwords, or " +
      "connect another address.",
    helpUrl: "https://myaccount.google.com/apppasswords",
    helpLabel: "Google App Passwords",
    prereqUrl: "https://myaccount.google.com/signinoptions/twosv",
    prereqLabel: "Turn on 2-Step Verification",
    account: "Google",
    appPassword: true,
    authHints: true,
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
    appPassword: true,
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
    appPassword: true,
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
    appPassword: true,
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
    appPassword: true,
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
    id: "webde",
    label: "WEB.DE",
    imap: { host: "imap.web.de", port: 993, secure: true },
    smtp: { host: "smtp.web.de", port: 587, secure: false },
    // WEB.DE's settings exist only in German, so the English names its menu as it reads there.
    note:
      "WEB.DE ships with IMAP switched off. Turn it on first under Einstellungen → POP3/IMAP " +
      "Abruf, then use your ordinary WEB.DE password here. If the account has two-factor " +
      "authentication, create an application-specific password for it instead.",
    helpUrl: "https://hilfe.web.de/pop-imap/einschalten.html",
    helpLabel: "WEB.DE · enabling IMAP",
  },
  {
    id: "tonline",
    label: "t-online",
    imap: { host: "secureimap.t-online.de", port: 993, secure: true },
    smtp: { host: "securesmtp.t-online.de", port: 465, secure: true },
    note:
      "Telekom Mail signs mail apps in with its own e-mail password, not your Telekom login " +
      "password. Set one in the Telekom E-Mail Center first, then use it here with your full " +
      "t-online.de address.",
    helpUrl: "https://www.telekom.de/hilfe/festnetz-internet-tv/e-mail/e-mail-server-e-mail-protokolle-und-e-mail-einrichtung/imap/einrichtung-imap",
    helpLabel: "Telekom help · setting up IMAP",
  },
  {
    id: "bluewin",
    label: "bluewin",
    imap: { host: "imaps.bluewin.ch", port: 993, secure: true },
    smtp: { host: "smtpauths.bluewin.ch", port: 465, secure: true },
    note: "Use your full bluewin address and its e-mail password, the password of the mailbox itself.",
  },
  {
    id: "imap",
    label: "Any other IMAP mailbox",
    imap: { host: "", port: 993, secure: true },
    smtp: { host: "", port: 587, secure: false },
    note:
      "A provider not listed here, or your own server. You need the IMAP host, the SMTP host, and " +
      "a password for the mailbox; your provider's help pages call these “incoming” and " +
      "“outgoing” servers. If your domain's mail is hosted by Google Workspace or Microsoft 365, " +
      "choose Gmail or Microsoft instead.",
    manual: true,
  },
];

/**
 * PROTON MAIL IS NOT A PRESET. It reaches other mail apps only through Proton Bridge, which runs
 * on the person's own computer, and ohmail does not connect through Bridge — so it is a note the
 * picker shows (`providerPicker.protonNote`), never a choice, and never on the parity list.
 */
export const PROTON = {
  label: "Proton Mail",
  domains: ["proton.me", "protonmail.com", "protonmail.ch", "pm.me"],
} as const;

/** Is this a Proton Mail address? Its own domains only; a custom domain on Proton is the lookup's to say. */
export const isProtonAddress = (address: string): boolean => {
  const domain = domainOfAddress(address);
  return domain !== null && (PROTON.domains as readonly string[]).includes(domain);
};

/** The `providerPicker` key of the password field's label: "App password" only where that is what it takes. */
export const passwordLabelKey = (p: ProviderPreset): "passwordApp" | "passwordPlain" =>
  p.appPassword ? "passwordApp" : "passwordPlain";

/**
 * WHY A PROVIDER REFUSED A SIGN-IN — the engine's closed set (`googleAuthHint`, core), mirrored here
 * because this package may not import core. A root census holds the two lists equal.
 */
export const AUTH_HINTS = ["app_password_required", "web_login", "imap_disabled", "invalid"] as const;
export type AuthHint = (typeof AUTH_HINTS)[number];

/** A refusal's `authHint`, if it is one of {@link AUTH_HINTS}; anything else is no hint. */
export const asAuthHint = (value: unknown): AuthHint | null =>
  typeof value === "string" && (AUTH_HINTS as readonly string[]).includes(value) ? value as AuthHint : null;

/** The kinds that are about the password, and so show the App Password links. */
export const authHintWantsLinks = (hint: AuthHint): boolean =>
  hint === "app_password_required" || hint === "invalid";

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
 * Every label but one is a brand name and the same string in every language. The
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
  { id: "webde", domains: ["web.de"] },
  { id: "tonline", domains: ["t-online.de"] },
  { id: "bluewin", domains: ["bluewin.ch"] },
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

/** The one preset whose refused sign-ins carry an `authHint`. */
export const authHintPreset = (): ProviderPreset => PROVIDERS.find((p) => p.authHints === true)!;

/**
 * THE APP-PASSWORD PRESET A MAILBOX IS ON, by where it dials first: an exact match on a preset's
 * IMAP host (a Google Workspace address on its own domain dials imap.gmail.com), else the address.
 * `null` for the generic entry and for no match. For the note and the re-entry hint only.
 */
export const appPasswordPresetFor = (address: string, imapHost?: string | null): ProviderPreset | null => {
  const host = (imapHost ?? "").trim().toLowerCase().replace(/\.$/, "");
  const byHost = host === "" ? undefined : PROVIDERS.find((p) => !p.manual && p.imap.host === host);
  return byHost ?? presetForAddress(address);
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

/**
 * WHAT `POST /mailboxes/discover` IS SENT: the domain of a typed address, and never the part
 * before the @ — the server refuses a body that carries anything else. `null` for no domain.
 */
export const discoveryRequestFor = (address: string): { domain: string } | null => {
  const domain = domainOfAddress(address.trim());
  return domain ? { domain } : null;
};

/** A server the lookup found: where to pre-fill, never what is dialled. */
export interface DiscoveredServer {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
}

/** The lookup's answer as a form reads it. */
export interface Discovery {
  /** The named preset whose provider hosts the domain's mail, or `null`. */
  readonly preset: ProviderPreset | null;
  /** Proton hosts it: show {@link PROTON}'s note, not a form. */
  readonly proton: boolean;
  readonly imap: DiscoveredServer | null;
  readonly smtp: DiscoveredServer | null;
}

const discoveredServer = (value: unknown): DiscoveredServer | null => {
  if (typeof value !== "object" || value === null) return null;
  const { host, port, secure } = value as Record<string, unknown>;
  return typeof host === "string" && host !== "" && typeof port === "number" && Number.isInteger(port)
    && port > 0 && port < 65_536 && typeof secure === "boolean"
    ? { host, port, secure } : null;
};

/**
 * The lookup's answer, read field by field: a preset id this table does not name (a newer server's)
 * is no preset, and a server missing any part is no server. `null` for a body that is not an object.
 */
export function readDiscovery(wire: unknown): Discovery | null {
  if (typeof wire !== "object" || wire === null || Array.isArray(wire)) return null;
  const w = wire as Record<string, unknown>;
  const preset = PROVIDERS.find((p) => !p.manual && p.id === w.preset) ?? null;
  return { preset, proton: w.proton === true, imap: discoveredServer(w.imap), smtp: discoveredServer(w.smtp) };
}
