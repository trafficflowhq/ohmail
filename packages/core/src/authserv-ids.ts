import { NO_TRUSTED_AUTHSERV_IDS } from "./rules.js";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   WHICH `Authentication-Results` POSITION A MAILBOX'S OWN PROVIDER SIGNS WITH
   ══════════════════════════════════════════════════════════════════════════════════════════

   `rules.ts#authVerdictFromHeaders` is demote-only and correct, but it decides from
   `trustedAuthservIds` — and an EMPTY set short-circuits every message to `"unavailable"`, so
   with nothing populating it the forged-`From` demotion can never fire anywhere. The consent
   boundary then rests entirely on the sender's own claim: a stranger who writes a known
   contact's address into `From` inherits that contact's admission to the Ohbox with no user
   action. This module is the population: a static table from the IMAP HOST WE DIAL to the
   authserv-id that provider stamps `Authentication-Results` with.

   ── WHY THE IMAP HOST IS THE KEY, AND WHY THAT IS SOUND ─────────────────────────────────

   The trusted position must be a fact about the provider that HOLDS the mailbox, never a value
   the account's user (or a sender) can name — `pipeline.ts#PlanDeps.trustedAuthservIds` records
   why it is not a `mailboxes` column. The IMAP host is exactly that fact: it is the endpoint
   the sync connection actually dials, attested by TLS certificate verification on connect, so
   "this mailbox is served by Gmail" is as true as the connection itself. A user who writes
   `imap.gmail.com` into a mailbox that Gmail does not serve gets no mail at all, not a
   mis-trusted verdict.

   ── THE TABLE COVERS KNOWN PROVIDERS AND REFUSES TO GUESS ───────────────────────────────

   Gmail and Microsoft — the large majority of real mailboxes — are named. Every other host
   (self-hosted Dovecot, a company server, any IMAP endpoint this table has never heard of)
   resolves to {@link NO_TRUSTED_AUTHSERV_IDS}: verdicts stay `"unavailable"`, nothing is
   demoted, and routing is byte-identical to the pre-population behaviour. That is the correct
   fail-open for a demote-only consumer — inventing a trusted position for an unknown server
   would believe headers nobody vouches for. Extending trust to the self-hosted tail (per-host
   pinning, or an explicit operator setting) is a separate decision and deliberately not made
   here.

   ── THE STRINGS THEMSELVES ────────────────────────────────────────────────────────────────

   · Gmail (consumer and Workspace) stamps `Authentication-Results: mx.google.com; …` on every
     inbound message.
   · Microsoft (Exchange Online / EOP, consumer Outlook.com on the same infrastructure) stamps
     `Authentication-Results: mx.microsoft.com 1; …` — authserv-id plus an RFC 8601 version
     token, which `rules.ts#authservIdOf` already reads correctly. Some Microsoft tenants still
     emit the LEGACY header that opens directly with `spf=…` and carries no authserv-id at all;
     that header is unattributable and is deliberately NOT matched — those messages answer
     `"unavailable"`, which demotes nothing. Do not "fix" that by adding `spf=pass` heuristics:
     a header with no authserv-id is indistinguishable from one a sender typed.

   Both providers strip or displace inbound headers bearing their own authserv-id (RFC 8601 §5;
   Microsoft renames them to `Authentication-Results-Original`), and the verdict reader takes
   the TOPMOST trusted header, so a sender-inserted copy sits below the provider's own and is
   never read on any message the provider stamped. The residual — a forged trusted id on a
   message the provider did not stamp — is stated in `rules.ts` and buys a sender nothing under
   demote-only.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

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
 * the IMAP host that mailbox is served by.
 *
 * An unknown, empty or absent host answers {@link NO_TRUSTED_AUTHSERV_IDS} — every verdict
 * `"unavailable"`, nothing demoted — which is the pre-population behaviour and the only honest
 * answer for a server whose stamping identity nobody has verified. The host is normalized the
 * way `rules.ts#authservIdOf` normalizes the header side: lowercased, one trailing dot dropped,
 * so `IMAP.GMAIL.COM.` and `imap.gmail.com` are one identity rather than two.
 *
 * CALL THIS AT EVERY PRODUCTION SEAM THAT BUILDS PIPELINE OR RE-DERIVATION DEPS. The dangerous
 * state is the DEFAULT one — an empty set admits every claimed sender — so the deps interfaces
 * that carry the set require it rather than defaulting it, and this function is the one
 * sanctioned source of the value where the IMAP host is in hand. Where only a mailbox id is in
 * hand, `adapters/drizzle-repo.ts#mailboxProviderAuthservIds` reads the host off the mailbox's
 * own credential row and ends here.
 */
export function providerAuthservIds(imapHost: string | null | undefined): ReadonlySet<string> {
  if (typeof imapHost !== "string") return NO_TRUSTED_AUTHSERV_IDS;
  const host = imapHost.trim().toLowerCase().replace(/\.$/, "");
  if (host === "") return NO_TRUSTED_AUTHSERV_IDS;
  return PROVIDER_AUTHSERV_IDS.get(host) ?? NO_TRUSTED_AUTHSERV_IDS;
}
