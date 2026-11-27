import type { DraftForwardSource } from "@ohmail/wire";
import { MutationRejectedError } from "../types.js";

export function requireDraftSourceEcho(written: DraftForwardSource[] | undefined, echoed: unknown, row: string): void {
  if (written === undefined) return;
  if (Array.isArray(echoed) && written.length === echoed.length && written.every((source, index) => {
    const saved = echoed[index];
    return source.id === saved?.id && source.filename === saved.filename && source.sha256 === saved.sha256;
  })) return;
  throw new MutationRejectedError(
    "The server did not save the original messages with this draft.",
    { code: "draft_unsaved", retryable: false, entityId: row },
  );
}
