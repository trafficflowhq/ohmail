import { NO_TRUSTED_AUTHSERV_IDS } from "./rules.js";

/**
 * Which `Authentication-Results` position a mailbox's own provider signs with. The verdict reader
 * is demote-only and decides from `trustedAuthservIds` — an EMPTY set short-circuits every
 * message to `"unavailable"`, so without this the forged-`From` demotion can never fire. The IMAP
 * host is the key: a fact about the provider that HOLDS the mailbox, attested by TLS. Gmail
 * (`mx.google.com`) and Microsoft (`mx.microsoft.com`) are named; every other host resolves to
 * {@link NO_TRUSTED_AUTHSERV_IDS} — nothing demoted, the correct fail-open. Microsoft's LEGACY
 * no-authserv-id header is not matched: indistinguishable from one a sender typed. Both providers
 * displace inbound headers bearing their own id; the reader takes the topmost trusted one.
 */

/** Gmail's authserv-id — consumer Gmail and Google Workspace both sign with it. */
const GMAIL_AUTHSERV_IDS: ReadonlySet<string> = new Set(["mx.google.com"]);

/** Microsoft's authserv-id — Exchange Online, Microsoft 365 and consumer Outlook.com. */
const MICROSOFT_AUTHSERV_IDS: ReadonlySet<string> = new Set(["mx.microsoft.com"]);

/**
 * IMAP host → the authserv-id set that provider signs with. Hosts are the ones our own
 * connection code and the provider presets dial (`apps/webapp/app/shell/providers.ts`), plus
 * each provider's documented legacy alias, all lowercased.
 */
const PROVIDER_AUTHSERV_IDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // Gmail. `imap.googlemail.com` is Google's own legacy alias for the same service.
  ["imap.gmail.com", GMAIL_AUTHSERV_IDS],
  ["imap.googlemail.com", GMAIL_AUTHSERV_IDS],
  // Microsoft. `outlook.office365.com` is the canonical IMAP host (see
  // `oauth/microsoft.ts` for why it is NOT `outlook.office.com`, which is a resource
  // identifier and not a hostname); `imap-mail.outlook.com` is the older consumer
  // Outlook.com host that still resolves onto the same service.
  ["outlook.office365.com", MICROSOFT_AUTHSERV_IDS],
  ["imap-mail.outlook.com", MICROSOFT_AUTHSERV_IDS],
]);

/**
 * The authserv-ids a mailbox's own provider signs `Authentication-Results` with, resolved from
 * the IMAP host that serves it. An unknown, empty or absent host answers {@link
 * NO_TRUSTED_AUTHSERV_IDS} — every verdict `"unavailable"`, nothing demoted — the only honest
 * answer for a server nobody has verified. The host is normalized as `rules.ts#authservIdOf`
 * normalizes the header side: lowercased, one trailing dot dropped. Call this at every production
 * seam that builds pipeline or re-derivation deps — the dangerous state is the DEFAULT one, so
 * the deps interfaces require the set rather than defaulting it. Where only a mailbox id is in
 * hand, `mailboxProviderAuthservIds` reads the host off the credential row and ends here.
 */
export function providerAuthservIds(imapHost: string | null | undefined): ReadonlySet<string> {
  if (typeof imapHost !== "string") return NO_TRUSTED_AUTHSERV_IDS;
  const host = imapHost.trim().toLowerCase().replace(/\.$/, "");
  if (host === "") return NO_TRUSTED_AUTHSERV_IDS;
  return PROVIDER_AUTHSERV_IDS.get(host) ?? NO_TRUSTED_AUTHSERV_IDS;
}
