import { eq } from "drizzle-orm";
import { mailboxes } from "@trafficflow/db";
import { ImapAdapter, buildImapAuth, type CredMetaAuth } from "@trafficflow/core/adapters/imap";
import type { NetTimeouts } from "@trafficflow/core/adapters/imap";
import { SendConnections, type SendAdapter, type WarmSendAdapter } from "@trafficflow/core/mail";
import { MailboxSideRefusal } from "@trafficflow/services/mail";
import { dialFieldsFor, dialPort } from "./dial-host-guard.js";
import { requireImapCredential } from "./attachments-adapter.js";
import type { ApiDeps } from "./deps.js";

interface CredMeta extends CredMetaAuth {
  host?: string; port?: number; secure?: boolean;
  /** Connect-time plaintext consent for a server the probe proved has no TLS, per row: the imap
   * row's for the IMAP leg, the smtp row's for submission. Never borrowed across rows. */
  insecureConsent?: boolean;
  /** For oauth2: the SMTP coordinates, since an oauth mailbox stores NO separate smtp row. */
  smtp?: { host?: string; port?: number; secure?: boolean };
  /**
   * WHY THE SUBMISSION SERVER IS NOT SETTLED — the probe's own reason, or absent/`""` when it is.
   * Written by the door that stored this credential; see the refusal below for what it costs.
   */
  smtpUnsettled?: string;
}

/**
 * THE PROCESS-WIDE KEEPER every production send door dials through — the hosted API, the
 * self-host server and the desktop engine all reach `makeSendAdapter`, so one instance here is
 * one instance everywhere. The hosts close it at shutdown; tests hand the factory their own.
 */
export const sendConnections = new SendConnections();

/** `mailboxes.sent_folder` (mail 0132), or null when no attach has decided one yet. */
async function storedSentFolder(deps: ApiDeps, mailboxId: string): Promise<string | null> {
  const [row] = await deps.db.select({ sentFolder: mailboxes.sentFolder })
    .from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
  return row?.sentFolder ?? null;
}

/**
 * Build the API's send adapter. Unlike `makeOpenAdapter` (attachments), this reads both
 * credential rows, decrypts each, and constructs a connected `ImapAdapter` with `smtp` populated
 * so it can SMTP-send and IMAP-append to Sent; credentials never leave the server. No dedicated
 * `smtp` row falls back to the imap host + secret. `newAdapter` is the one test seam, a
 * parameter: the guarded failure is a send from the second mailbox going out through the first
 * one's submission server, and against a server that accepts every login the only tell is the
 * configuration the transport was constructed with. Not on `ApiDeps`: a bag field is reachable
 * from every host and route, and this is a seam for one function.
 */
export async function makeSendAdapter(
  deps: ApiDeps,
  mailboxId: string,
  opts: { timeouts?: Partial<NetTimeouts> } = {},
  /* FOURTH, not third, so every existing caller keeps the position it passes `opts` in. */
  newAdapter: (cfg: ConstructorParameters<typeof ImapAdapter>[0]) => ImapAdapter =
    (cfg) => new ImapAdapter(cfg),
  /* FIFTH: the keeper. Production dials through the process-wide one; a test hands in its own. */
  keep: SendConnections = sendConnections,
): Promise<SendAdapter> {
  const { rows, imap: imapRow } = await requireImapCredential(deps, mailboxId);
  const smtpRow = rows.find((r) => r.transport === "smtp");

  // AFTER the credential read and BEFORE anything else: a live connection kept from an earlier
  // press serves this one with no decrypt, no host check and no socket. A mailbox whose rows are
  // gone still refuses above, so nothing is sent through a connection its owner has removed.
  return keep.open(mailboxId, async (): Promise<WarmSendAdapter> => {

    const imapMeta = (imapRow.meta ?? {}) as CredMeta;
    const imapPort = dialPort(imapMeta.port) ?? 993;
    // BEFORE the secret is decrypted, and before any transport exists: a server this deployment
    // will not dial should cost no key material, and a refusal that arrives after the adapter is
    // built is a refusal that arrives after a socket may have opened. See {@link dialFieldsFor}.
    const imapDial = await dialFieldsFor(deps, {
      host: imapMeta.host ?? "", port: imapPort, secure: imapMeta.secure ?? true,
      consent: imapMeta.insecureConsent === true,
    }, "imap");
    const imapSecret = await deps.keyProvider.decrypt(imapRow.secretEnc, imapRow.keyVersion);
    // The IMAP auth goes through the SHARED builder — an oauth2 row becomes the token callback here,
    // never a password. `imapSecret` is a REFRESH TOKEN for oauth, a password otherwise.
    const imapAuth = buildImapAuth(imapMeta, imapSecret, deps.oauth?.forMailbox(mailboxId));

    // Resolve the SMTP transport. For OAUTH there is no smtp row and no static SMTP auth: one refresh
    // token covers both transports, so the host/port/secure come from `meta.smtp` and `ImapAdapter.send`
    // fetches a token per message. For PASSWORD, the dedicated smtp row when present, else the imap
    // host/user + imap secret (shared-credential providers, e.g. GreenMail).
    let smtpConfig: { host: string; port: number; secure: boolean; auth?: { user: string; pass: string } };
    // The smtp ROW's consent only: the no-row fallback guessed its server, and a guess was never
    // probed, so it has nothing to consent to.
    let smtpConsent = false;
    if (imapMeta.authType === "oauth2") {
      const s = imapMeta.smtp ?? {};
      smtpConfig = {
        host: s.host ?? "smtp.office365.com",
        port: dialPort(s.port) ?? 587,
        secure: s.secure ?? false,
      };
    } else {
      let smtpMeta: CredMeta;
      let smtpPass: string;
      if (smtpRow) {
        smtpMeta = (smtpRow.meta ?? {}) as CredMeta;
        smtpPass = await deps.keyProvider.decrypt(smtpRow.secretEnc, smtpRow.keyVersion);
      } else {
        /**
         * No `smtp` row: the guess, and the one case where guessing is dishonest. `imap host:587`
         * with the imap secret is the convention and right for most providers. Not when the
         * submission server was tried and refused: the local door marks the outgoing half
         * unsettled so a working mailbox is not held hostage to a blocked port, and the fallback
         * would dial a server somebody was already told does not work. No marker, guess; a marker,
         * refuse with its reason. A 502 without `retryable` reads as retryable to every client,
         * which is why it stays; `MailboxSideRefusal` keeps it out of the fault rows.
         */
        if (imapMeta.smtpUnsettled) {
          throw new MailboxSideRefusal(
            "smtp_not_settled", 502,
            "Sending is not set up for this mailbox: its outgoing (SMTP) server has not been "
              + "settled. Receiving works. Set the outgoing server in Settings → Mailboxes.",
          );
        }
        smtpMeta = { host: imapMeta.host, port: 587, secure: false, user: imapMeta.user };
        smtpPass = imapSecret;
      }
      const smtpUser = smtpMeta.user ?? imapMeta.user ?? "";
      smtpConfig = {
        host: smtpMeta.host ?? imapMeta.host ?? "",
        port: dialPort(smtpMeta.port) ?? 587,
        secure: smtpMeta.secure ?? false,
        // GreenMail runs with auth disabled; omit auth when there is no user to bind.
        ...(smtpUser ? { auth: { user: smtpUser, pass: smtpPass } } : {}),
      };
      smtpConsent = smtpRow !== undefined && smtpMeta.insecureConsent === true;
    }

    // The submission server is its own name on its own transport — its own check, its own pin. The
    // no-smtp-row fallback dials the IMAP host on 587, which is a second transport on one name and
    // is checked as one rather than borrowing the IMAP leg's verdict.
    const smtpDial = await dialFieldsFor(deps, {
      host: smtpConfig.host, port: smtpConfig.port, secure: smtpConfig.secure, consent: smtpConsent,
    }, "smtp");

    const adapter = newAdapter({
      host: imapMeta.host ?? "",
      port: imapPort,
      secure: imapMeta.secure ?? true,
      // The cleared addresses, so the socket goes where the check went, and the plaintext consent
      // only as re-asked there. `host` above is untouched: the pin narrows the ADDRESS alone.
      ...imapDial,
      // SHORTER DEADLINES FOR A CALLER THAT HAS LESS TIME, threaded rather than raced.
      //
      // The reconciling pass runs three dials inside the same 60-second invocation the default
      // 15 s connect + 15 s greeting were chosen for ONE send to fit in. Racing them from outside
      // was tried and is worse than useless: an abandoned operation still owns imapflow's command
      // queue, so the caller learns nothing and the socket lives on. Handing the ADAPTER a shorter
      // deadline means a breach is the adapter's own honest "this mailbox did not answer" — which
      // is a fact the caller can act on, and which its give-up may legitimately act on after a day.
      ...(opts.timeouts ? { timeouts: opts.timeouts } : {}),
      auth: imapAuth,
      smtp: { ...smtpConfig, ...smtpDial },
      sentDomain: domainOf(imapMeta.user),
      // The Sent folder the sync's last attach decided, so this copy is filed where the scan reads.
      storedFolders: { sent: await storedSentFolder(deps, mailboxId) },
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
        // `appended` carries the Sent copy this send appended, or found where the server files its
        // own — the UID and the exact bytes at it. Dropping it here (which this wrapper used to do) is what
        // left the just-sent message discoverable only by the sync worker's next pass over Sent, a
        // poll interval later. `SendService.projectSentCopy` writes the row from it immediately.
        //
        // The bytes are NOT stored: they are fingerprinted and parsed into the same columns any
        // ingested message gets, and the Buffer is garbage after the request. See `SendResult.raw`
        // for why the projection may not use anything else as its content source. No locator
        // (a server that files its own copy, not found in time) is nothing to project.
        if (res.sentLocator === null) return { providerMessageId: res.providerMessageId };
        return { providerMessageId: res.providerMessageId, appended: { locator: res.sentLocator, raw: res.raw } };
      },
      messageInSent: (messageId) => adapter.messageInSent(messageId),
      close: () => adapter.close(),
      // FORWARDED, and without it the seam is decorative. `SendAdapter.forceClose` exists for a
      // caller that has abandoned a timed-out operation: imapflow serialises commands, so a
      // graceful LOGOUT queues behind the hung one and the polite path waits out the very hang it
      // is escaping. This wrapper is a hand-written literal, so an `ImapAdapter` method that is not
      // named here simply does not exist to the caller — which is how the reconciler's abandonment
      // path was silently taking the fallback in production while its test passed against a spy
      // that did define it.
      forceClose: () => { adapter.forceClose(); },
      // THE KEEPER'S ADMISSION. Only a real adapter can say whether its socket is still there;
      // the hand-written doubles have no `isLive`, so they are handed back uncached and dialled
      // fresh every time, exactly as before.
      ...(typeof adapter.isLive === "function" ? { isLive: (): boolean => adapter.isLive() } : {}),
    };
  });
}

function domainOf(address: string | undefined): string | undefined {
  const at = (address ?? "").lastIndexOf("@");
  return at >= 0 ? address!.slice(at + 1) : undefined;
}
