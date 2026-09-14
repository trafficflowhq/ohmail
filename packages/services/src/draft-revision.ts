import { createHash } from "node:crypto";
import type { EmailAddress } from "@trafficflow/core/mail";

/**
 * WHICH VERSION OF A DRAFT A CLIENT IS LOOKING AT — the token a send names to say which row it was
 * composed against (`SendInput.ifContentRevision`).
 *
 * Derived, not stored: `updated_at` moves when an identical buffer is written back, which is what
 * two windows autosaving one draft do all day, and refusing there is a false alarm about a message
 * nobody changed. Server-minted and opaque — a client carries back what the DTO gave it, so no
 * second implementation can drift into refusing every send. `threadId` is out (a merge repoints
 * the row under the author); `rationale` and the schedule are out, being undelivered.
 */
export function draftContentRevision(row: {
  mailboxId: string;
  inReplyToMessageId: string | null;
  subject: string;
  body: string;
  html: string | null;
  to: unknown;
  cc: unknown;
  bcc: unknown;
}): string {
  // ADDRESSES AS TUPLES, never the stored object: jsonb does not preserve key order, so
  // stringifying the column would make the digest a fact about the storage engine.
  const addrs = (xs: unknown): Array<[string, string | null]> =>
    (Array.isArray(xs) ? (xs as EmailAddress[]) : [])
      .map((a) => [a?.address ?? "", a?.name ?? null] as [string, string | null]);
  const canonical = JSON.stringify([
    row.mailboxId,
    row.inReplyToMessageId ?? null,
    row.subject,
    row.body,
    row.html ?? null,
    addrs(row.to), addrs(row.cc), addrs(row.bcc),
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
