import { attachmentFaultClass, type AttachmentFaultClass } from "../state/live";
import { Copy } from "../copy";

/** What a failed tap on a file carries: the engine item's refusal facts, never its English message. */
export interface AttachmentFault {
  code: string | null;
  retryable: boolean;
  status: number | null;
}

/**
 * THE SENTENCE UNDER A FILE THAT COULD NOT BE FETCHED — the side that failed, from the one class
 * table the web reader renders too, and "Tap to try again." only where the refusal said asking
 * again can help. Resolved at render, so a language switch re-reads the deck.
 */
export function attachmentFaultNote(f: AttachmentFault): string {
  const by: Record<AttachmentFaultClass, string> = {
    ohmail: Copy.attachmentFaultOhmail,
    busy: Copy.attachmentFaultBusy,
    unreachable: Copy.attachmentFaultUnreachable,
    not_secured: Copy.attachmentFaultNotSecured,
    login_refused: Copy.attachmentFaultLoginRefused,
    reconnect: Copy.attachmentFaultReconnect,
    gone: Copy.attachmentFaultGone,
    refused: Copy.attachmentFaultRefused,
    offline: Copy.attachmentFaultOffline,
    signed_out: Copy.attachmentFaultSignedOut,
  };
  const said = by[attachmentFaultClass(f.code, f.status)];
  return f.retryable ? `${said} ${Copy.attachmentTapToRetry}` : said;
}
