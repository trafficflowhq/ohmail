import { createHash } from "node:crypto";
import type { DraftForwardSource } from "@ohmail/wire";
import { SEND_MAX_ATTACHMENT_PARTS } from "@trafficflow/core/attachment-limits";
import { ServiceError } from "./errors.js";
import { isUuid } from "./ids.js";

export function readDraftForwardSources(input: unknown): DraftForwardSource[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > SEND_MAX_ATTACHMENT_PARTS) {
    throw new ServiceError("validation_failed", 400, `Select at most ${SEND_MAX_ATTACHMENT_PARTS} messages to forward.`);
  }
  const ids = new Set<string>();
  return input.map((entry: Partial<DraftForwardSource> | null) => {
    if (typeof entry?.id !== "string" || !isUuid(entry.id) || ids.has(entry.id)
      || typeof entry.filename !== "string" || !entry.filename.endsWith(".eml") || entry.filename.length > 255
      || /[\u0000-\u001f\u007f/\\]/.test(entry.filename)
      || typeof entry.sender !== "string" || entry.sender.length > 255
      || typeof entry.subject !== "string" || entry.subject.length > 255
      || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new ServiceError("validation_failed", 400, "Invalid message attachment reference.");
    }
    const { id, filename, sender, subject, sha256 } = entry;
    ids.add(id);
    return { id, filename, sender, subject, sha256 };
  });
}

type ForwardAttachment = { filename?: string | null; contentType?: string | null }
  & ({ content: Uint8Array } | { contentSha256: string });

export function forwardAttachmentsUnavailable(): ServiceError {
  return new ServiceError("forward_original_unavailable", 409, "Some original messages couldn't be read. Retry or remove them to send.");
}

export function requireDraftForwardAttachments(
  sources: readonly DraftForwardSource[] | null,
  files: readonly ForwardAttachment[],
): void {
  for (const [index, source] of (sources ?? []).entries()) {
    const file = files[index];
    if (!file || file.filename !== source.filename || file.contentType !== "message/rfc822"
      || ("content" in file ? createHash("sha256").update(file.content).digest("hex") : file.contentSha256) !== source.sha256) {
      throw forwardAttachmentsUnavailable();
    }
  }
}
