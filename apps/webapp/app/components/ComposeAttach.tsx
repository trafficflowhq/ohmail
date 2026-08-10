"use client";

/**
 * COMPOSE ATTACHMENTS — pick files, hold their bytes in memory, send them with the message.
 *
 * ── ZERO AT REST, RESTATED AT THE SURFACE ────────────────────────────────────────────────
 *
 * The bytes a user picks here ride the SEND request and are stored nowhere — not in the account's
 * `drafts` row, not in `attachments`, not in this browser's `localStorage` (the compose scratch
 * buffer strips them; see `compose.ts`). So an attachment lives for exactly as long as the compose
 * form is open. That is why this control keeps the decoded files in React state handed up through
 * `ComposeFields.attachments` rather than persisting them, and why a reload starts with none.
 *
 * ── THE CAP IS A UX PRE-CHECK; THE SERVER IS AUTHORITATIVE ───────────────────────────────
 *
 * Attachment bytes travel base64 on one JSON request, so their total has to clear the hosted API's
 * request-body limit with room for the envelope and the ~1.33× base64 inflation. The server refuses
 * a total over its own ceiling (`SEND_ATTACHMENT_MAX_TOTAL_BYTES`, 3 MB of raw bytes); this states
 * that number up front and refuses to ADD a file that would cross it, so a user learns at pick time
 * instead of at a failed send. The client number is a mirror of the server's, kept here as a
 * constant rather than imported so the webapp pulls in no server module.
 *
 * ── COPY ─────────────────────────────────────────────────────────────────────────────────
 *
 * Strings are inline (a copy-shim), not `en.json` keys — this slice deliberately makes no message
 * edits. A later pass moves them into the catalog; the wording here is plain and final.
 */
import { useCallback, useRef, useState } from "react";
import { Button, Icon } from "@ohmail/ui";
import type { ComposeAttachment } from "@ohmail/client-engine";

/** Raw-byte ceiling for the whole set — the mirror of the server's authoritative cap. */
export const COMPOSE_ATTACH_MAX_TOTAL_BYTES = 3 * 1024 * 1024;

/** Decoded byte length of a base64 string, without decoding it. */
function base64Bytes(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

function totalBytes(items: ComposeAttachment[]): number {
  return items.reduce((n, a) => n + base64Bytes(a.contentBase64), 0);
}

/** "2.3 MB" / "748 KB" / "512 B" — never a trailing ".0". */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let n = bytes / 1024;
  for (const unit of ["KB", "MB", "GB"]) {
    if (n < 1024 || unit === "GB") {
      const s = n < 10 ? n.toFixed(1).replace(/\.0$/, "") : String(Math.round(n));
      return `${s} ${unit}`;
    }
    n /= 1024;
  }
  return `${bytes} B`;
}

/** Read one File to base64 (no `data:` prefix). Rejects on a read error. */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : "");
    };
    reader.readAsDataURL(file);
  });
}

export function ComposeAttach({
  attachments,
  onChange,
  disabled,
}: {
  attachments: ComposeAttachment[];
  onChange: (next: ComposeAttachment[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = useCallback(() => {
    setError(null);
    inputRef.current?.click();
  }, []);

  const onFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      setError(null);
      let running = totalBytes(attachments);
      const next = [...attachments];
      let refused = false;
      for (const file of Array.from(fileList)) {
        if (running + file.size > COMPOSE_ATTACH_MAX_TOTAL_BYTES) {
          refused = true;
          continue;
        }
        try {
          const contentBase64 = await readAsBase64(file);
          next.push({
            filename: file.name || "attachment",
            contentType: file.type || "application/octet-stream",
            contentBase64,
          });
          running += file.size;
        } catch {
          refused = true;
        }
      }
      if (refused) {
        setError(`Some files were not added — the total must stay under ${formatSize(COMPOSE_ATTACH_MAX_TOTAL_BYTES)}.`);
      }
      onChange(next);
      // Clear the native input so re-picking the same file fires `change` again.
      if (inputRef.current) inputRef.current.value = "";
    },
    [attachments, onChange],
  );

  const remove = useCallback(
    (index: number) => {
      setError(null);
      onChange(attachments.filter((_, i) => i !== index));
    },
    [attachments, onChange],
  );

  const used = totalBytes(attachments);

  return (
    <div className="compose-attach">
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        disabled={disabled}
        onChange={(e) => void onFiles(e.target.files)}
      />
      <div className="compose-attach-row">
        <Button variant="ghost" onClick={pick} disabled={disabled}>
          <Icon name="clip" size={14} /> Attach files
        </Button>
        <span className="compose-attach-cap">
          {attachments.length > 0
            ? `${formatSize(used)} of ${formatSize(COMPOSE_ATTACH_MAX_TOTAL_BYTES)}`
            : `Up to ${formatSize(COMPOSE_ATTACH_MAX_TOTAL_BYTES)} total`}
        </span>
      </div>

      {attachments.length > 0 ? (
        <ul className="compose-attach-list">
          {attachments.map((a, i) => (
            <li key={`${a.filename}-${i}`} className="compose-attach-item">
              <Icon name="clip" size={12} />
              <span className="compose-attach-name">{a.filename}</span>
              <span className="compose-attach-size">{formatSize(base64Bytes(a.contentBase64))}</span>
              <button
                type="button"
                className="compose-attach-remove"
                aria-label={`Remove ${a.filename}`}
                disabled={disabled}
                onClick={() => remove(i)}
              >
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {error ? <p className="compose-attach-error" role="alert">{error}</p> : null}
    </div>
  );
}
