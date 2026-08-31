/**
 * The mailbox providers the app offers to connect, and what each one needs.
 *
 * ── WHY THIS LIVES IN THE SHARED SHELL ───────────────────────────────────────────────────
 *
 * There are now THREE surfaces that ask somebody which mailbox they have — the hosted
 * client's first-run step, its Settings → Mailboxes pane, and the desktop app's local door —
 * and the third one runs in a build that compiles only the shared shell. A second copy of
 * this table for the desktop would be a second answer to "which providers work and what host
 * do they use", drifting from the first in whichever direction nobody looked. So the table
 * sits beside the rest of the shared client rather than beside one of its callers.
 *
 * ── THE LIST IS NOT INVENTED HERE ────────────────────────────────────────────────────────
 *
 * It is exactly the list `messages/en.json` → `providers` already names, in the
 * same order, plus the generic "any IMAP server" that section's `any` line promises. That
 * matters more than it looks: the landing is a public claim about what works, so a provider
 * offered here that is not on the landing is a claim nobody reviewed, and a provider on the
 * landing that is missing here is a promise the product does not keep. A parity check asserts
 * the two lists are the same set, and it bites in both directions.
 *
 * ── APP PASSWORDS, HONESTLY ──────────────────────────────────────────────────────────────
 *
 * ohmail connects over IMAP with a password. For every provider below that means an APP
 * PASSWORD (a provider-issued, revocable, per-application secret) and not the account
 * password — several of them will not accept the account password at all once 2FA is on,
 * and telling someone to type their real password into a third-party form would be
 * indefensible advice even where it works.
 *
 * `note` is what the user is told, and it is written to be TRUE for that provider today.
 * Microsoft in particular gets the landing's own caveat repeated rather than softened: we
 * connect over IMAP like everything else, native Graph sync is not shipped, and app
 * passwords require security defaults to be off — which for many tenants means it will not
 * work, and saying so before someone types credentials is better than a failed connection.
 *
 * ── NO OAUTH ────────────────────────────────────────────────────────────────────────────
 *
 * An OAuth auth kind is described in the mailbox API and nothing implements it. Gmail's and
 * Microsoft's OAuth apps need verification we have not done, so offering a "Sign in with
 * Google" button that cannot work would be the single most misleading thing this screen
 * could contain. App passwords are the honest path for the beta and are what the landing
 * already describes.
 */

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
    note:
      "ohmail connects to Microsoft over IMAP, like every other mailbox — native Exchange sync " +
      "over Microsoft Graph is on the roadmap and is not shipped. You will need an app password, " +
      "which requires security defaults to be off on the account; on some work tenants an " +
      "administrator has disabled IMAP entirely, and then it cannot connect at all.",
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
 * THE HOSTS A NEWLY CHOSEN PRESET IMPOSES — which, for the generic entry, is NEITHER OF THEM.
 *
 * All three connect surfaces answer a provider choice by writing the preset's hosts into their
 * form state. For the seven NAMED presets that is the whole point: the host is a fact the app
 * knows and the person does not have to type. The generic entry's hosts are the empty string —
 * it has nothing to say about them, which is exactly why it renders the fields — and copying
 * that emptiness over the form DELETED WHAT SOMEBODY HAD ALREADY TYPED.
 *
 * It is reachable without changing your mind about anything. The picker is a radiogroup whose
 * checked tile is the group's tab stop, so Space or Enter on it re-fires the choice; so does
 * clicking the tile you already chose, which is a natural thing to do when a submit has just
 * failed and the error banner sits directly above the provider grid. Both wiped the IMAP and
 * SMTP hosts, silently, from fields far enough down the form to be off screen — and the next
 * submit then failed for a missing host the person could see themselves having typed.
 *
 * So: a preset with a host imposes it, and a preset without one leaves what is there. Empty is
 * not a value here; it is the absence of one, and absence must not overwrite.
 */
/**
 * ── PROVENANCE IS THE WHOLE RULE, AND LEAVING IT OUT WAS A CREDENTIAL LEAK ──────────────────
 *
 * The first version of this took only the current values and kept them whenever the incoming
 * preset had none. That is wrong in a way that is worse than the bug it fixed, and a review
 * caught it: the form's host field does not record WHO put the value there. Choose Gmail (the
 * form fills in `imap.gmail.com`), then choose "any other IMAP mailbox" — the generic preset has
 * no host, so the Gmail host was kept, and the fields now show a host the person never typed,
 * pre-filled and easy to miss. They then enter THEIR OWN server's password and submit, and the
 * probe dials Gmail with it.
 *
 * So the previous choice is a parameter. Values are the person's own exactly when the previous
 * choice was ALSO the manual entry — every other value in that field was put there by a preset,
 * and a preset's value must never survive into a different provider's attempt.
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
