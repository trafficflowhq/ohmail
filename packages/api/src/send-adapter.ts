import { eq } from "drizzle-orm";
import { mailboxCredentials } from "@trafficflow/db";
import { ImapAdapter, buildImapAuth, type CredMetaAuth } from "@trafficflow/core/adapters/imap";
import type { SendAdapter } from "@trafficflow/core/mail";
import { ServiceError } from "@trafficflow/services/mail";
import type { ApiDeps } from "./deps.js";

interface CredMeta extends CredMetaAuth {
  host?: string; port?: number; secure?: boolean;
  /** Connect-time plaintext consent for a server the probe proved has no TLS. IMAP leg only. */
  insecureConsent?: boolean;
  /** For oauth2: the SMTP coordinates, since an oauth mailbox stores NO separate smtp row. */
  smtp?: { host?: string; port?: number; secure?: boolean };
}

/**
 * Build the API's send adapter. Unlike `makeOpenAdapter`
 * (attachments) which reads ONLY the `imap` cred row — so `ImapConfig.smtp` is
 * unset and `ImapAdapter.send` would throw "SMTP not configured" — this reads BOTH
 * the `imap` AND the `smtp` `mailbox_credentials` rows (envelope-encrypted at
 * rest), decrypts each via `deps.keyProvider`, and constructs a connected
 * `ImapAdapter` with `smtp` populated so it can SMTP-send AND IMAP-append to
 * Sent. The returned handle
 * exposes the `SendAdapter` seam (`send` / `messageInSent` / `close`) SendService
 * drives; credentials never leave the server.
 *
 * If the mailbox has no dedicated `smtp` row we fall back to the imap host + the
 * imap secret (the single-credential generic-IMAP convention) rather than error —
 * many providers use one password for both transports.
 */
export async function makeSendAdapter(deps: ApiDeps, mailboxId: string): Promise<SendAdapter> {
  const rows = await deps.db.select().from(mailboxCredentials)
    .where(eq(mailboxCredentials.mailboxId, mailboxId));

  const imapRow = rows.find((r) => r.transport === "imap");
  if (!imapRow) throw new ServiceError("upstream_unavailable", 502, "mailbox has no IMAP credentials");
  const smtpRow = rows.find((r) => r.transport === "smtp");

  const imapMeta = (imapRow.meta ?? {}) as CredMeta;
  const imapSecret = await deps.keyProvider.decrypt(imapRow.secretEnc, imapRow.keyVersion);
  // The IMAP auth goes through the SHARED builder — an oauth2 row becomes the token callback here,
  // never a password. `imapSecret` is a REFRESH TOKEN for oauth, a password otherwise.
  const imapAuth = buildImapAuth(imapMeta, imapSecret, deps.oauth?.forMailbox(mailboxId));

  // Resolve the SMTP transport. For OAUTH there is no smtp row and no static SMTP auth: one refresh
  // token covers both transports, so the host/port/secure come from `meta.smtp` and `ImapAdapter.send`
  // fetches a token per message. For PASSWORD, the dedicated smtp row when present, else the imap
  // host/user + imap secret (shared-credential providers, e.g. GreenMail).
  let smtpConfig: { host: string; port: number; secure: boolean; auth?: { user: string; pass: string } };
  if (imapMeta.authType === "oauth2") {
    const s = imapMeta.smtp ?? {};
    smtpConfig = {
      host: s.host ?? "smtp.office365.com",
      port: s.port ?? 587,
      secure: s.secure ?? false,
    };
  } else {
    let smtpMeta: CredMeta;
    let smtpPass: string;
    if (smtpRow) {
      smtpMeta = (smtpRow.meta ?? {}) as CredMeta;
      smtpPass = await deps.keyProvider.decrypt(smtpRow.secretEnc, smtpRow.keyVersion);
    } else {
      smtpMeta = { host: imapMeta.host, port: 587, secure: false, user: imapMeta.user };
      smtpPass = imapSecret;
    }
    const smtpUser = smtpMeta.user ?? imapMeta.user ?? "";
    smtpConfig = {
      host: smtpMeta.host ?? imapMeta.host ?? "",
      port: smtpMeta.port ?? 587,
      secure: smtpMeta.secure ?? false,
      // GreenMail runs with auth disabled; omit auth when there is no user to bind.
      ...(smtpUser ? { auth: { user: smtpUser, pass: smtpPass } } : {}),
    };
  }

  const adapter = new ImapAdapter({
    host: imapMeta.host ?? "",
    port: imapMeta.port ?? 993,
    secure: imapMeta.secure ?? true,
    // The connect-time plaintext consent, threaded like the worker threads it — an IMAP append
    // to the Sent folder of a consented no-TLS mailbox must dial the way the probe proved.
    ...(imapMeta.insecureConsent === true ? { allowInsecure: true } : {}),
    auth: imapAuth,
    smtp: smtpConfig,
    sentDomain: domainOf(imapMeta.user),
  });
  // Same reason as `makeOpenAdapter`: `connect()` logs in and LISTs, so a failure after login
  // leaves an authenticated socket open that the caller has no handle to close. Close it here
  // and rethrow the original error — on the SEND path a leaked socket is worse than elsewhere,
  // because the retry that follows is a retry of a send.
  try {
    await adapter.connect();
  } catch (err) {
    await adapter.close().catch(() => { /* the connection is already broken */ });
    throw err;
  }

  return {
    send: async (msg) => {
      const res = await adapter.send(msg);
      // `appended` carries the Sent-folder APPEND this send just made — the UID the server answered
      // with, and the exact bytes at it. Dropping it here (which this wrapper used to do) is what
      // left the just-sent message discoverable only by the sync worker's next pass over Sent, a
      // poll interval later. `SendService.projectSentCopy` writes the row from it immediately.
      //
      // The bytes are NOT stored: they are fingerprinted and parsed into the same columns any
      // ingested message gets, and the Buffer is garbage after the request. See `SendResult.raw`
      // for why the projection may not use anything else as its content source.
      return { providerMessageId: res.providerMessageId, appended: { locator: res.sentLocator, raw: res.raw } };
    },
    messageInSent: (messageId) => adapter.messageInSent(messageId),
    close: () => adapter.close(),
  };
}

function domainOf(address: string | undefined): string | undefined {
  const at = (address ?? "").lastIndexOf("@");
  return at >= 0 ? address!.slice(at + 1) : undefined;
}
