import { randomUUID } from "node:crypto";
import type { OutboundMessage } from "./adapters/imap-types.js";
import type { NativeLocator } from "./ports.js";
import { foldMessageIdDomain } from "./identity.js";

// Surface `OutboundMessage` on the core entrypoint so the send seam is usable
// without importing the adapter subpath (it otherwise lives only on the
// `@trafficflow/core/adapters/imap` export).
export type { OutboundMessage } from "./adapters/imap-types.js";

/**
 * The crash-safe send seam. SMTP is not transactional: a crash between "SMTP accepted" and "we
 * recorded that" is indistinguishable, at the DB, from "SMTP never ran", and the #1 risk is a
 * double-send across it. The defence is to mint the Message-ID (RFC 5322) up front as the
 * correlation key: (1) mint `<uuid@domain>` on the `pending` reservation row before any network;
 * (2) pass that exact id to SMTP as `OutboundMessage.messageId`, so the delivered mail carries an
 * id we chose; (3) a same-key retry finding a stale `pending` row VERIFIES by searching Sent for
 * that id — found means reconcile to `sent` with no resend, not found means `unverified`,
 * surfaced to the user. A silent auto-resend on ambiguity is prohibited.
 */

/** The lifecycle of an `outbound_sends` reservation row. */
export type OutboundSendStatus = "pending" | "sent" | "failed" | "unverified";

/**
 * Mint a globally-unique Message-ID (RFC 5322) for a send reservation. The SAME
 * string is stored on the `pending` row AND passed to SMTP, so a crashed attempt
 * is verifiable by an exact Sent-folder header search (never blindly resent).
 * `sentDomain` is the sending identity's domain; it only shapes the id — the
 * uuid guarantees uniqueness regardless of domain.
 */
export function mintMessageId(sentDomain = "trafficflow.ch"): string {
  const domain = sentDomain.trim() || "trafficflow.ch";
  /* THE DOMAIN IS FOLDED HERE, at the one place ids are minted, through the helper the away
     ledger's reader calls on its candidates — see {@link foldMessageIdDomain}. The caller hands
     `mailboxes.address`'s own domain, which is whatever a person typed, and an id minted
     `<uuid@Example.COM>` is a join key nothing that lower-cases can find. `id-left` is the uuid
     and untouched. */
  return foldMessageIdDomain(`<${randomUUID()}@${domain}>`);
}

/**
 * The append the send path already made to the master — a locator and the bytes at it.
 * `ImapAdapter.send` APPENDs the compiled message into the mailbox's own Sent folder and the
 * server answers with a UID; both facts used to die at this seam, so the server's own copy was
 * rediscovered a poll interval later. Carrying them out enables record-at-send, and it is NOT a
 * second source of truth: the write to the mailbox already happened, this is its projection, and
 * the Sent-folder watch remains the backstop. One object means both or neither: a locator without
 * bytes cannot be fingerprinted ({@link SendResult.raw}), and bytes without a locator name no
 * place.
 */
export interface AppendedSent {
  /** Where the append landed. `ref` is `${uidvalidity}:${uid}`; `0:0` when the server gave no APPENDUID. */
  locator: NativeLocator;
  /** The bytes at that locator. The ONLY admissible fingerprint source — see {@link SendResult.raw}. */
  raw: Buffer;
}

/**
 * The minimal send seam SendService drives, injected per-request (prod = `makeSendAdapter` over
 * decrypted mailbox creds; tests = a fake/GreenMail spy). `send` performs SMTP + the Sent copy
 * (appended, or the server's own where it files submissions) and returns the delivered id;
 * `messageInSent` is the verify-by-Sent probe for crash recovery; `close` tears the connection
 * down. `appended` is absent for a spy and for a server's copy not found in time — a consumer
 * treats absence as "nothing to project", never as an error; the Sent-folder watch is the path
 * that always exists.
 */
export interface SendAdapter {
  send(msg: OutboundMessage): Promise<{ providerMessageId: string; appended?: AppendedSent }>;
  /** True iff a message with `messageId` (an `<id@host>` header) exists in Sent. */
  messageInSent(messageId: string): Promise<boolean>;
  close(): Promise<void>;
  /**
   * Tear the connection down NOW, for a caller that has abandoned a timed-out operation. imapflow
   * serialises commands, so a graceful LOGOUT queues behind whatever is hung — awaiting `close`
   * waits exactly as long as the hang being escaped, and destroying the socket is the only thing
   * that ends the hung command (see `ImapAdapter.forceClose`). Optional because a spy has nothing
   * to destroy: a consumer falls back to `close` when it is absent, and should bound that call.
   */
  forceClose?(): void;
}

/**
 * SMTP ACCEPTED THE MESSAGE AND THE SENT-FOLDER APPEND DID NOT — a delivered send with no copy.
 * `ImapAdapter.send` runs `sendMail` and then `append`; one `catch` over both read an append
 * fault as "SMTP threw", probed Sent, missed (nothing was ever appended) and recorded the
 * delivery as `unverified`. Carrying the delivered id lets the send finalize `sent` and say
 * plainly that the copy is missing. `cause` is the append's own error.
 */
export class SentCopyAppendFailed extends Error {
  readonly providerMessageId: string;
  constructor(providerMessageId: string, cause: unknown) {
    super("the message was delivered; the copy to the Sent folder could not be written");
    this.name = "SentCopyAppendFailed";
    this.providerMessageId = providerMessageId;
    (this as { cause?: unknown }).cause = cause;
  }
}

/** Where a submission stopped before the server was offered anything to deliver. */
export type SendNotSubmittedStep = "connect" | "secure" | "login";

/**
 * THE SERVER WAS NEVER OFFERED THE MESSAGE — the socket never connected, the session died while
 * its connection was being secured, or the login was refused. At most the greeting, EHLO and
 * STARTTLS (or a refused AUTH) crossed, so the message provably did not leave: the send is failed,
 * never `unverified`, and it may be sent again. `step` names where it stopped; `cause` is the
 * client's own error.
 */
export class SendNotSubmitted extends Error {
  readonly step: SendNotSubmittedStep;
  readonly code?: string;
  readonly responseCode?: number;
  readonly command?: string;
  constructor(step: SendNotSubmittedStep, cause: unknown) {
    const c = (cause ?? {}) as { message?: unknown; code?: unknown; responseCode?: unknown; command?: unknown };
    super(typeof c.message === "string" && c.message !== "" ? c.message
      : step === "connect" ? "the mail server could not be reached"
        : step === "secure" ? "the connection to the mail server could not be secured" : "the mail server refused the login");
    this.name = "SendNotSubmitted";
    this.step = step;
    (this as { cause?: unknown }).cause = cause;
    // THE CLIENT'S OWN DIAGNOSTICS RIDE ALONG: a caller classifying by code reads what it always read.
    if (typeof c.code === "string") this.code = c.code;
    if (typeof c.responseCode === "number") this.responseCode = c.responseCode;
    if (typeof c.command === "string") this.command = c.command;
  }
}

/**
 * nodemailer's two deadlines that fire before the greeting: the TCP connect and the `220`. Its
 * mid-session one says `Timeout`. Matched by message because nodemailer gives all three one code;
 * `send-not-submitted.test.ts` pins these strings against the pinned nodemailer over real sockets.
 */
const BEFORE_GREETING_TIMEOUTS: ReadonlySet<string> = new Set(["Connection timeout", "Greeting never received"]);

/**
 * Which step a submission error PROVES the envelope never reached, or null when it proves nothing.
 * nodemailer raises `ETLS` only while STARTTLS is asked for or the upgrade runs, and `EAUTH` only
 * during login; `tlsFailed` is the transport's stamp on an error before its handshake was confirmed.
 * `connect`: DNS failed (`EDNS`) or the socket's own connect did (nodemailer overwrites the errno
 * with `ESOCKET`, so the syscall is the evidence), or a deadline fired before the greeting. A
 * timeout, a reset or a close can happen after DATA and stays ambiguous.
 */
export function submissionNeverOffered(err: unknown): SendNotSubmittedStep | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { code?: unknown; tlsFailed?: unknown; syscall?: unknown; message?: unknown };
  if (e.tlsFailed === true || e.code === "ETLS") return "secure";
  if (e.code === "EAUTH") return "login";
  if (e.code === "EDNS" || e.syscall === "connect" || e.syscall === "getaddrinfo") return "connect";
  if (e.code === "ETIMEDOUT" && typeof e.message === "string" && BEFORE_GREETING_TIMEOUTS.has(e.message)) {
    return "connect";
  }
  return null;
}

/** Injected factory: open a connected send adapter for a mailbox. */
export type OpenSendAdapter = (mailboxId: string) => Promise<SendAdapter>;
