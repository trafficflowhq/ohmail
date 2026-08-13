import { randomUUID } from "node:crypto";
import type { OutboundMessage } from "./adapters/imap-types.js";
import type { NativeLocator } from "./ports.js";

// Surface `OutboundMessage` on the core entrypoint so the send seam is usable
// without importing the adapter subpath (it otherwise lives only on the
// `@trafficflow/core/adapters/imap` export).
export type { OutboundMessage } from "./adapters/imap-types.js";

/**
 * The crash-safe send seam. SMTP is NOT transactional: a
 * process crash between "SMTP accepted the message" and "we recorded that fact"
 * is indistinguishable, at the DB, from "SMTP never ran". The #1 risk is a
 * double-send to a recipient across such a crash. The defence is to mint the
 * Message-ID (RFC 5322) UP FRONT and make it the correlation key:
 *
 *   1. mint `<uuid@domain>` on the `pending` reservation row (before any network);
 *   2. pass that EXACT id to SMTP as `OutboundMessage.messageId` (the ImapAdapter
 *      honours a supplied id and appends it to Sent), so the delivered mail carries
 *      an id we chose, not one the transport invented;
 *   3. on a same-key retry that finds a stale `pending` row, VERIFY by searching
 *      the Sent folder for that id — FOUND ⇒ it was delivered, reconcile to `sent`
 *      with NO resend; NOT FOUND ⇒ ambiguous, move to `unverified` and surface to
 *      the user. A silent auto-resend on ambiguity is PROHIBITED.
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
 * THE APPEND THE SEND PATH ALREADY MADE TO THE MASTER — a locator and the bytes that are at it.
 *
 * `ImapAdapter.send` does not merely deliver: it `APPEND`s the compiled message into the mailbox's
 * own Sent folder, under `\Seen`, and the server answers with a UID. Both facts used to die at this
 * seam (`{ providerMessageId }` was the whole return), so the copy the server was already holding
 * was rediscovered a poll interval later by the sync worker, from scratch.
 *
 * Carrying them out is what makes RECORD-AT-SEND possible, and it is worth being precise about what
 * it is not: it is **not** a second source of truth. The write to the mailbox has already happened
 * — this is the projection of a write already made to the master, so the IMAP mailbox stays the
 * master by construction and the Sent-folder watch remains the backstop that heals anything this
 * projection gets wrong or never gets to do.
 *
 * The two fields travel together in one object, and that is the type saying "both or neither": a
 * locator without the bytes cannot be fingerprinted (see {@link SendResult.raw}), and the bytes
 * without the locator name no place in the mailbox.
 */
export interface AppendedSent {
  /** Where the append landed. `ref` is `${uidvalidity}:${uid}`; `0:0` when the server gave no APPENDUID. */
  locator: NativeLocator;
  /** The bytes at that locator. The ONLY admissible fingerprint source — see {@link SendResult.raw}. */
  raw: Buffer;
}

/**
 * The minimal send seam SendService drives, INJECTED per-request (prod =
 * `makeSendAdapter` over decrypted mailbox creds; tests = a fake/GreenMail spy).
 * `send` performs SMTP + Sent-append and returns the delivered id; `messageInSent`
 * is the verify-by-Sent probe used for crash recovery; `close` tears the
 * connection down. Mirrors the attachments `AttachmentAdapter` seam.
 *
 * `appended` is OPTIONAL on purpose, and the optionality is a statement about the CALLER rather
 * than about the adapter: every wrapper of a real `ImapAdapter` can supply it (the adapter returns
 * both halves), and a spy or a transport that files sent mail some other way cannot. A consumer
 * must therefore treat its absence as "nothing to project" and never as an error — the
 * Sent-folder watch is the path that always exists.
 */
export interface SendAdapter {
  send(msg: OutboundMessage): Promise<{ providerMessageId: string; appended?: AppendedSent }>;
  /** True iff a message with `messageId` (an `<id@host>` header) exists in Sent. */
  messageInSent(messageId: string): Promise<boolean>;
  close(): Promise<void>;
}

/** Injected factory: open a connected send adapter for a mailbox. */
export type OpenSendAdapter = (mailboxId: string) => Promise<SendAdapter>;
