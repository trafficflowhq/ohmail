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
 * The server refuses a total over its own ceiling; this control states that number up front and
 * refuses to ADD a file that would cross it, so a user learns at pick time instead of at a failed
 * send. **The number is a PROP, not a constant** — see {@link composeAttachCap} for what goes into
 * it and why this component no longer knows.
 *
 * ── PICTURES ARE SHRUNK FIRST, AND THE ORDER IS THE POINT ────────────────────────────────
 *
 * Every picked file goes through {@link shrinkImage} BEFORE the cap above is applied to it, and the
 * cap is then applied to the SHRUNK size. Written the other way round the feature would be nearly
 * pointless: the common attachment is a phone photo of six megabytes, the cap is three, and a
 * compressor that only runs on files which already fit never runs on the file that needed it. So
 * the sequence is decode → re-encode → measure → admit or refuse, and a photo that fits only
 * because it was shrunk attaches.
 *
 * The transform is in `./image-shrink`, which is where the level table, the format rules and the
 * keep-the-original guard are documented. This file's only job is to run it in the right place and
 * to say what happened.
 *
 * ── COPY ─────────────────────────────────────────────────────────────────────────────────
 *
 * The two strings that state the cap are catalog keys (`compose.attach*`) taking the rendered size
 * as a parameter, so the sentence on screen and the number the send will enforce come from one
 * value. They were inline literals holding a hard-coded "3 MB" — which was exactly the drift this
 * slice removes, in the one place a user reads a promise.
 */
import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@ohmail/ui";
import type { ComposeAttachment } from "@ohmail/client-engine";
import { readImageShrinkLevel, shrinkImage } from "./image-shrink";

/**
 * THE HOSTED SURFACE'S OWN CEILING on total attachment bytes — the mirror of the constant the
 * hosted send handler enforces, kept as a literal rather than imported so this bundle pulls in no
 * server module.
 *
 * It is a fact about the REQUEST PIPELINE and not about mail: attachment bytes travel base64 on one
 * JSON request, so their total has to clear the hosted API's serverless body limit (~4.5 MB) with
 * room for the envelope and the ~1.33× base64 inflation. 3 MB of raw bytes encodes to about 4 MB.
 */
export const COMPOSE_ATTACH_MAX_TOTAL_BYTES = 3 * 1024 * 1024;

/**
 * THE CEILING THIS FORM MAY PROMISE — the smaller of what the request can carry and what the
 * sending mailbox's own server said it will accept.
 *
 * It is a MIRROR of the rule the send itself applies, and it has to be: a number stated here that
 * the send would refuse is a claim the product cannot keep, which is the whole reason the copy
 * renders this value instead of a literal.
 *
 * `mailboxMax` is the submission server's own RFC 1870 `SIZE` announcement, forwarded from
 * `GET /mailboxes` through the resolved From. The interesting case is the STINGY provider, not the
 * generous one: a server that caps at 2 MB binds this form to 2 MB even though the request pipeline
 * would have carried 3 — without the `min` the user picks a file, waits for a send, and has it
 * bounced by their own provider.
 *
 * `null`, absent, `0` and anything non-finite all mean "no measured ceiling for this mailbox" and
 * resolve to the surface constant. A server advertising `SIZE 0` means "no fixed maximum"
 * (RFC 1870 §6), so reading it as a ceiling of nothing would refuse every file.
 */
export function composeAttachCap(mailboxMax: number | null | undefined): number {
  return typeof mailboxMax === "number" && Number.isFinite(mailboxMax) && mailboxMax > 0
    ? Math.min(COMPOSE_ATTACH_MAX_TOTAL_BYTES, mailboxMax)
    : COMPOSE_ATTACH_MAX_TOTAL_BYTES;
}

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

/**
 * Read bytes to base64 (no `data:` prefix). Rejects on a read error.
 *
 * Takes a `Blob` rather than a `File` because what gets read is often no longer the picked file —
 * a shrunk picture is a fresh blob off a canvas, with no name and no `lastModified`. The filename
 * comes from the original in every case, which is safe precisely because the shrink keeps formats.
 */
function readAsBase64(file: Blob): Promise<string> {
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
  maxTotalBytes = COMPOSE_ATTACH_MAX_TOTAL_BYTES,
}: {
  attachments: ComposeAttachment[];
  onChange: (next: ComposeAttachment[]) => void;
  disabled?: boolean;
  /**
   * The ceiling this form enforces and states, in raw bytes. Callers pass
   * {@link composeAttachCap} of the sending mailbox's announced `SIZE`.
   *
   * DEFAULTED rather than required, and to the STRICT value: a surface that has not been taught to
   * resolve a mailbox must not thereby acquire a bigger allowance than the hosted request pipeline
   * can carry. The default is what this component hard-coded before it took a prop, so an
   * un-updated caller behaves exactly as it did.
   */
  maxTotalBytes?: number;
}) {
  const t = useTranslations("compose");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * WHAT THE SHRINK SAVED on the most recent pick — `null` when nothing was re-encoded, which is
   * every pick containing no picture and every pick at level None. Held as the two totals rather
   * than as a rendered sentence so the copy stays in the catalog.
   */
  const [shrunk, setShrunk] = useState<{ from: number; to: number } | null>(null);

  const pick = useCallback(() => {
    setError(null);
    setShrunk(null);
    inputRef.current?.click();
  }, []);

  const onFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      setError(null);
      setShrunk(null);
      // READ ONCE PER PICK, and inside the handler — never during a render. There is no
      // `localStorage` on the server; see the note on `readImageShrinkLevel`.
      const level = readImageShrinkLevel();
      let running = totalBytes(attachments);
      const next = [...attachments];
      let refused = false;
      let savedFrom = 0;
      let savedTo = 0;
      for (const file of Array.from(fileList)) {
        try {
          // BEFORE THE CAP CHECK. The whole value of compressing on the client is that it changes
          // which files are admissible, and it cannot do that from behind the check that refuses
          // them. See the header note.
          const picture = await shrinkImage(file, level);
          if (running + picture.bytes > maxTotalBytes) {
            refused = true;
            continue;
          }
          const contentBase64 = await readAsBase64(picture.blob);
          next.push({
            filename: file.name || "attachment",
            contentType: picture.contentType,
            contentBase64,
          });
          running += picture.bytes;
          if (picture.shrunk) {
            savedFrom += picture.originalBytes;
            savedTo += picture.bytes;
          }
        } catch {
          refused = true;
        }
      }
      if (refused) {
        setError(t("attachRefused", { size: formatSize(maxTotalBytes) }));
      }
      // The totals of this pick, not of the list: the sentence explains what just happened to the
      // files being added, and for the single-picture case — which is nearly all of them — the two
      // numbers are that picture's own.
      if (savedFrom > 0) setShrunk({ from: savedFrom, to: savedTo });
      onChange(next);
      // Clear the native input so re-picking the same file fires `change` again.
      if (inputRef.current) inputRef.current.value = "";
    },
    [attachments, onChange, maxTotalBytes, t],
  );

  const remove = useCallback(
    (index: number) => {
      setError(null);
      // The note described a pick that no longer stands once one of its files is gone. Dropping it
      // is the honest move; recomputing it would mean claiming a saving for bytes still in the list.
      setShrunk(null);
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
          <Icon name="clip" size={14} /> {t("attach")}
        </Button>
        {/* THE CLAIM, RENDERED FROM THE NUMBER THAT WILL BE ENFORCED. Both branches take
            `maxTotalBytes` — the same value `onFiles` refuses against — so the sentence and the
            rule cannot drift. It used to read a hard-coded 3 MB while the server's answer depended
            on the mailbox. */}
        <span className="compose-attach-cap">
          {attachments.length > 0
            ? t("attachUsed", { used: formatSize(used), total: formatSize(maxTotalBytes) })
            : t("attachCap", { size: formatSize(maxTotalBytes) })}
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
                aria-label={t("attachRemove", { filename: a.filename })}
                disabled={disabled}
                onClick={() => remove(i)}
              >
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* WHAT WAS DONE TO THE FILES, said quietly and only when it happened. Plain muted text and
          not the refusal's tinted panel: nothing went wrong, and a picture that got smaller is not
          news the way a file that was turned away is. No `role="alert"` for the same reason — this
          must not interrupt a screen reader mid-sentence; it is read when the region is reached. */}
      {shrunk ? (
        <p className="compose-attach-shrunk">
          {t("attachShrunk", { from: formatSize(shrunk.from), to: formatSize(shrunk.to) })}
        </p>
      ) : null}

      {error ? <p className="compose-attach-error" role="alert">{error}</p> : null}
    </div>
  );
}
