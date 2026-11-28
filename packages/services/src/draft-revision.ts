import { draftRevisionInput } from "@trafficflow/core/outbound-text";
import { createHash } from "node:crypto";
import { ServiceError } from "./errors.js";

type DraftContent = Parameters<typeof draftRevisionInput>[0];

/**
 * WHICH VERSION OF A DRAFT A CLIENT IS LOOKING AT — the token a send names to say which row it was
 * composed against (`SendInput.ifContentRevision`).
 *
 * Derived, not stored: `updated_at` moves when an identical buffer is written back, which is what
 * two windows autosaving one draft do all day, and refusing there is a false alarm about a message
 * nobody changed. A client carries back what the DTO gave it as a write precondition. Recovery
 * can also match that same revision to a saved copy. `threadId` is out (a merge repoints
 * the row under the author); `rationale` and the schedule are out, being undelivered.
 */
export function draftContentRevision(row: DraftContent): string {
  return createHash("sha256").update(draftRevisionInput(row), "utf8").digest("hex");
}

export function requireDraftContentRevision(row: DraftContent, ifContentRevision: string | undefined): void {
  if (ifContentRevision && ifContentRevision !== draftContentRevision(row)) {
    throw new ServiceError("draft_changed", 409, "This draft changed in another window. Review it before sending.");
  }
}
