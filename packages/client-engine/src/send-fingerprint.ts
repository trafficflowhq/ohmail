/**
 * WHICH MESSAGE A SEND IS — one function for every surface that tells two presses apart. Door-free
 * (type imports only): the web's send lock, the adapter's resume decision and the desktop bundle reach
 * it. FNV-1a over the fields that say what is sent, attachments BY CONTENT; not a security control.
 * Three keys stay out, named in `send-fingerprint.test.ts`: `draftId` (the container), `forwardClock`
 * (stamped at every press) and `forwardConfirmed` (an answer, not content). Shipped locks were hashed
 * without them, so adding any one strands every stored lock.
 */
import type { EngineMutation } from "./types.js";

type MailSend = Extract<EngineMutation, { kind: "mail_send" }>;

/** FNV-1a, 32-bit, unsigned, base36 — one copy, for the envelope and each attachment alike. */
export function fnv1a(s: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * The display name is part of the recipient (the wire carries the whole address); the address is
 * lowercased, so a retyped case is the same message. Both bodies are hashed — the plain half is what
 * a client refusing HTML reads — and an attachment folds its content hash beside its length, because
 * a re-picked correction can keep name, type and size.
 */
export function sendFingerprint(m: MailSend): string {
  const addrs = (xs: ReadonlyArray<{ name?: string | null; address: string }> | undefined): string =>
    JSON.stringify((xs ?? []).map((a) => [a.name ?? null, a.address.toLowerCase()]));
  const parts = [
    m.inReplyTo ?? "", m.forwardOf ?? "", m.mailboxId ?? "",
    m.threadId ?? "",
    addrs(m.to), addrs(m.cc), addrs(m.bcc),
    m.subject ?? "", m.body ?? "", m.html ?? "", m.sendAt ?? "",
    JSON.stringify((m.attachments ?? []).map((a) => [
      a.filename, a.contentType, a.contentBase64.length, fnv1a(a.contentBase64),
    ])),
  ].join("\u0000");
  return fnv1a(parts);
}
