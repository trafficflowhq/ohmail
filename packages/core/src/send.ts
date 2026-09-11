import { randomUUID } from "node:crypto";
import type { OutboundMessage } from "./adapters/imap-types.js";
import type { NativeLocator } from "./ports.js";

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
  return `<${randomUUID()}@${domain}>`;
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
 * decrypted mailbox creds; tests = a fake/GreenMail spy). `send` performs SMTP + Sent-append and
 * returns the delivered id; `messageInSent` is the verify-by-Sent probe for crash recovery;
 * `close` tears the connection down. `appended` is optional as a statement about the CALLER:
 * every wrapper of a real `ImapAdapter` can supply it, a spy cannot — a consumer treats absence
 * as "nothing to project", never as an error; the Sent-folder watch is the path that always
 * exists.
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

/** Injected factory: open a connected send adapter for a mailbox. */
export type OpenSendAdapter = (mailboxId: string) => Promise<SendAdapter>;
