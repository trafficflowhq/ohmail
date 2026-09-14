import { createHash } from "node:crypto";
import type { EmailAddress } from "@trafficflow/core/mail";

/**
 * WHICH VERSION OF A DRAFT A CLIENT IS LOOKING AT — the token a send names to say which row it
 * was composed against (`SendInput.ifContentRevision`).
 *
 * Derived from the row rather than stored, and the derivation is why: `updated_at` moves when an
 * identical buffer is written back, which is what two windows autosaving one draft do all day —
 * refusing on that would be a false alarm about a message nobody changed. A digest over the
 * SENDABLE content moves only when something the author would see moves. Server-minted and opaque
 * to clients: they carry back what the row's DTO gave them, so no second implementation of this
 * canonicalization can drift into false refusals.
 *
 * `threadId` is excluded — a thread merge repoints the row without the author touching anything.
 * `rationale` and the schedule are excluded because neither is delivered.
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
