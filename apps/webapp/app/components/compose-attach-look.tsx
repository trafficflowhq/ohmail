"use client";

/**
 * What an attached file looks like while the message is still being written: a thumbnail in its
 * row, and the reader's Quick Look over the bytes in memory. Nothing here is stored or fetched;
 * nothing here changes the list or sends anything.
 *
 * Pictures are `blob:` URLs of the exact encode the send carries (`contentBase64`), minted only
 * for the overlay's own raster types and revoked when their row leaves or the form goes. A PDF's
 * thumbnail is page 1 drawn through the reader's pdf.js loader, one file at a time, into a
 * `data:` PNG; any failure leaves the type mark. Bytes never become a document (see
 * `AttachmentPreview`'s security rule).
 */

import { useEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ComposeAttachment } from "@ohmail/client-engine";
import { AttachmentPreview, discard, loadPdfjs, previewKind } from "./AttachmentPreview";
import { FileMark, type AttachmentItem } from "./AttachmentStrip";
import type { PdfTask } from "./pdf-port";
import { bytesOf64 } from "../shell/open-attachment";

/** The declared type without its parameters: a Blob is typed with this, never the raw header. */
function essence(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

function typedBlob(att: ComposeAttachment): Blob {
  return new Blob([bytesOf64(att.contentBase64) as BlobPart], { type: essence(att.contentType) });
}

/* ── pictures ────────────────────────────────────────────────────────────────────────── */

function mint(att: ComposeAttachment): string | null {
  try {
    if (typeof URL.createObjectURL !== "function") return null;
    return URL.createObjectURL(typedBlob(att));
  } catch {
    return null;
  }
}

function revoke(url: string | null): void {
  if (url === null) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* nothing left to release */
  }
}

/**
 * One `blob:` URL per raster picture row, keyed by the row object: a re-encode is a new row, so
 * it gets a new URL and the old one is revoked. `null` marks a row that could not get one.
 */
export function useImageUrls(rows: readonly ComposeAttachment[]): ReadonlyMap<ComposeAttachment, string | null> {
  const minted = useRef(new Map<ComposeAttachment, string | null>());
  const [, changed] = useReducer((n: number) => n + 1, 0);
  // No dependency list: callers pass a fresh array per render, so this reconciles by row identity.
  useEffect(() => {
    const have = minted.current;
    const keep = new Set(rows);
    let moved = false;
    for (const [row, url] of have) {
      if (keep.has(row)) continue;
      revoke(url);
      have.delete(row);
      moved = true;
    }
    for (const row of rows) {
      if (have.has(row) || previewKind(row.contentType) !== "image") continue;
      have.set(row, mint(row));
      moved = true;
    }
    if (moved) changed();
  });
  useEffect(() => {
    const have = minted.current;
    return () => {
      for (const url of have.values()) revoke(url);
      have.clear();
    };
  }, []);
  return minted.current;
}

/* ── PDF first pages ─────────────────────────────────────────────────────────────────── */

/** The thumbnail's raster box in CSS px: twice the 32px leaf across, a tall page's top down. */
const THUMB_W = 64;
const THUMB_H = 256;
const PDF_THUMB_TIMEOUT_MS = 8_000;
const PAGE_TYPE = "image/png";

const pdfThumbs = new WeakMap<ComposeAttachment, Promise<string | null>>();
/** How many mounted rows still want a file's thumbnail; a job whose file nobody wants is skipped. */
const pdfWanted = new Map<ComposeAttachment, number>();
/** One pdf.js worker at a time: each job starts when the one before it has settled. */
let pdfQueue: Promise<unknown> = Promise.resolve();

function want(att: ComposeAttachment, delta: number): void {
  const n = (pdfWanted.get(att) ?? 0) + delta;
  if (n > 0) pdfWanted.set(att, n);
  else pdfWanted.delete(att);
}

async function drawFirstPage(att: ComposeAttachment): Promise<string | null> {
  if (typeof Worker !== "function") return null;
  let task: PdfTask | null = null;
  let render: { cancel: () => void } | null = null;
  let over = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async (): Promise<string | null> => {
    const open = await loadPdfjs();
    if (over) return null;
    task = open({ data: bytesOf64(att.contentBase64), disableAutoFetch: true, disableStream: true });
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(THUMB_W / base.width, THUMB_H / base.height);
    if (!Number.isFinite(scale) || scale <= 0) return null;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const canvasContext = canvas.getContext("2d");
    if (!canvasContext || over) return null;
    const job = page.render({ canvas: null, canvasContext, viewport });
    render = job;
    await job.promise;
    return over ? null : canvas.toDataURL(PAGE_TYPE);
  })();
  work.catch(() => {});
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      render?.cancel();
      resolve(null);
    }, PDF_THUMB_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } catch {
    return null;
  } finally {
    over = true;
    clearTimeout(timer);
    discard(task);
  }
}

function pdfThumbOf(att: ComposeAttachment): Promise<string | null> {
  let thumb = pdfThumbs.get(att);
  if (!thumb) {
    const job = pdfQueue.then(() => {
      if (pdfWanted.has(att)) return drawFirstPage(att);
      pdfThumbs.delete(att); // asked again if the row comes back
      return null;
    });
    pdfQueue = job.catch(() => null);
    thumb = job.catch(() => null);
    pdfThumbs.set(att, thumb);
  }
  return thumb;
}

/** Page 1 of an attached PDF as a `data:` PNG, or `null` while it draws or when it cannot. */
export function usePdfThumb(att: ComposeAttachment): string | null {
  const [thumb, setThumb] = useState<{ att: ComposeAttachment; url: string | null } | null>(null);
  useEffect(() => {
    if (previewKind(att.contentType) !== "pdf") return;
    let live = true;
    want(att, 1);
    void pdfThumbOf(att).then((url) => {
      if (live) setThumb({ att, url });
    });
    return () => {
      live = false;
      want(att, -1);
    };
  }, [att]);
  return thumb !== null && thumb.att === att ? thumb.url : null;
}

/* ── the row's leaf ──────────────────────────────────────────────────────────────────── */

export function AttachThumb({ att, url }: { att: ComposeAttachment; url: string | null | undefined }) {
  const page = usePdfThumb(att);
  const src = url ?? page;
  if (!src) return <FileMark filename={att.filename} mimeType={att.contentType} />;
  return (
    <span className="att-leaf" aria-hidden="true">
      <img className={url ? "att-thumb" : "att-thumb att-thumb-page"} src={src} alt=""
        draggable={false} decoding="async" loading="lazy" />
    </span>
  );
}

/* ── the preview ─────────────────────────────────────────────────────────────────────── */

export interface ComposeLookEntry {
  id: string;
  att: ComposeAttachment;
  sizeBytes: number;
  url: string | null;
}

/**
 * The reader's Quick Look over the attached files, without Download. Portalled to the body: in
 * place it would sit under the reader's stacking context and the rail, and the compose surface's
 * paste and drop listeners would take its events. Mount it only while open (it needs the keymap).
 */
export function ComposeAttachPreview({
  entries,
  activeId,
  onActiveIdChange,
  onClose,
  focusOnClose,
}: {
  entries: readonly ComposeLookEntry[];
  activeId: string;
  onActiveIdChange: (id: string) => void;
  onClose: () => void;
  focusOnClose: (id: string) => HTMLElement | null;
}) {
  const blobs = useRef(new Map<ComposeAttachment, Blob>());
  const items: AttachmentItem[] = entries.map((e) => ({
    id: e.id,
    filename: e.att.filename,
    mimeType: e.att.contentType,
    sizeBytes: e.sizeBytes,
    state: "ready",
    ...(e.url ? { objectUrl: e.url } : {}),
  }));
  const blobOf = (id: string): Blob | undefined => {
    const att = entries.find((e) => e.id === id)?.att;
    if (!att) return undefined;
    let blob = blobs.current.get(att);
    if (!blob) {
      try {
        blob = typedBlob(att);
      } catch {
        return undefined;
      }
      blobs.current.set(att, blob);
    }
    return blob;
  };
  return createPortal(
    // A file dropped here would otherwise be the browser's to open, navigating away from the draft.
    <div
      className="compose-attach-preview"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "none";
      }}
      onDrop={(e) => e.preventDefault()}
    >
      <AttachmentPreview
        items={items}
        activeId={activeId}
        onActiveIdChange={onActiveIdChange}
        ensure={() => {}}
        blobOf={blobOf}
        onClose={onClose}
        focusOnClose={focusOnClose}
      />
    </div>,
    document.body,
  );
}
