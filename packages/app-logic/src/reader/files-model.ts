/**
 * A FILE'S TILE, as data: what it is, what its line says and what a press does. Drawn from the list the engine
 * holds; nothing here fetches. A file's kind comes from its declared type, never its name.
 */
import { attachmentFaultClass, type AttachmentFaultClass } from "@ohmail/client-engine";

export type FileLook = "image" | "pdf" | "text" | "other";

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** What can be looked at, and what only saves (the essence of the declared type). */
export function fileLookOf(mimeType: string): FileLook {
  const m = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  if (IMAGE_MIME.has(m)) return "image";
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("text/")) return "text";
  return "other";
}

/** Bytes this window already holds: the only source a thumbnail is drawn from. */
export const isHeldUrl = (url: string): boolean => url.startsWith("blob:") || url.startsWith("data:");

export interface FileOfList {
  readonly mimeType: string;
  readonly state: "idle" | "loading" | "ready" | "failed" | "too_large";
  readonly objectUrl?: string;
  readonly code?: string | null;
  readonly status?: number | null;
  readonly retryable?: boolean;
}

/** A thumbnail's address, only for a ready raster picture whose bytes are held here. */
export function thumbnailOf(item: FileOfList): string | null {
  return item.state === "ready" &&
    fileLookOf(item.mimeType) === "image" &&
    item.objectUrl != null &&
    isHeldUrl(item.objectUrl)
    ? item.objectUrl
    : null;
}

/** The sentence key of a file that did not arrive (`attachments.fault*`), from the fault's class alone. */
export const FAULT_KEY: Readonly<Record<AttachmentFaultClass, string>> = {
  ohmail: "faultOhmail",
  busy: "faultBusy",
  unreachable: "faultUnreachable",
  server_busy: "faultServerBusy",
  not_secured: "faultNotSecured",
  login_refused: "faultLoginRefused",
  reconnect: "faultReconnect",
  not_signed_in: "faultNotSignedIn",
  gone: "faultGone",
  refused: "faultRefused",
  offline: "faultOffline",
  signed_out: "faultSignedOut",
};

/**
 * What helps a file that did not arrive: asking again where that could work, signing in where the session ended,
 * nothing where nothing helps (the server refuses it here or reports a file gone without offering another try).
 */
export function faultOf(item: FileOfList): { key: string; way: "retry" | "signIn" | null } {
  const cls = attachmentFaultClass(item.code ?? null, item.status ?? null);
  const way =
    cls === "signed_out"
      ? "signIn"
      : cls === "refused" || item.retryable === false || (cls === "gone" && item.retryable !== true)
        ? null
        : "retry";
  return { key: FAULT_KEY[cls], way };
}
