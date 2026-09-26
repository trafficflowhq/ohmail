/**
 * Picture quality — the compression applied before an image is attached, the level table, and where
 * the level is kept. No React: the only browser things needed are a decoder and a canvas, read off
 * `globalThis` at call time, so all of it is reachable from a test. The dial is QUALITY, not effort
 * — Low, Medium, High, Original, ascending — which runs OPPOSITE to the old "Shrink pictures"
 * scale, so the stored preference is migrated, not reinterpreted ({@link IMAGE_QUALITY_STORAGE_KEY}).
 * Client-side, not server: base64 bytes on the send request put a 6 MB photo at ~8 MB, over a
 * serverless body limit before it is looked at — also why the call sits BEFORE the cap check in
 * `ComposeAttach.onFiles`: a photo that only fits once compressed must attach.
 */

/**
 * Formats are kept; the compression is lossy within the format. A JPEG comes back a JPEG, a PNG a
 * PNG — nothing converts, so the filename is never rewritten (an extension that stopped matching
 * its bytes is a worse problem than the one this solves). JPEG is re-encoded at the level's quality
 * and fitted to its longest edge. PNG gets dimension downscale only: canvas PNG encoding is
 * lossless and ignores `quality` (palette quantisation is a named follow-up behind this seam). GIF,
 * SVG and anything untyped are untouched at every level — an animated GIF through a canvas is its
 * first frame. The non-negotiable guard: if the re-encode is not smaller (`>=`), the ORIGINAL
 * bytes are sent — a bigger, worse file is worse than not running.
 */

/**
 * EXIF, and the one hole in the promise. A canvas has no metadata: drawing and reading back drops
 * every EXIF tag — camera, timestamps, the GPS position a phone writes by default — a privacy
 * improvement, and part of why the default is `medium`. The hole is the guard above: a picture
 * whose re-encode came out bigger is sent AS IT WAS, EXIF included — the honest trade, and the
 * setting's copy says so. Orientation goes the other way: the decode asks
 * `imageOrientation: "from-image"`, so the bitmap arrives already rotated — without it, dropping
 * EXIF would drop the `Orientation` tag and every portrait photo would arrive on its side. Output
 * dimensions come from the BITMAP, never from anything read ahead of the decode.
 */

import { durableSet } from "../shell/durable";

/*
 * THE LEVEL TABLE LIVES IN `@ohmail/client-engine` (`image-quality.ts` there) — the phone composer
 * shrinks by the same numbers, so a picture attaches the same at the same level on both. Re-exported
 * under the names every caller here already used; the storage and the canvas below stay this file's.
 */
export {
  DEFAULT_IMAGE_QUALITY_LEVEL,
  IMAGE_QUALITY_LEVELS,
  IMAGE_QUALITY_RULES,
  fitWithin,
  isImageQualityLevel,
  type ImageQualityLevel,
  type ImageQualityRule,
} from "@ohmail/client-engine";
import {
  DEFAULT_IMAGE_QUALITY_LEVEL,
  IMAGE_QUALITY_RULES,
  encodableImageType,
  fitWithin,
  isImageQualityLevel,
  type ImageQualityLevel,
} from "@ohmail/client-engine";

/**
 * Where the level lives — this browser, per account. `localStorage` like the theme (per-machine, worth neither a
 * column nor a request), keyed by account because a browser is not a person: one account's "send my photos at full
 * size" must not become another's default. The id is `storageOwner` — so the standalone desktop keeps one preference
 * per MAILBOX; the demo passes `null` and gets the account-less key, which also holds every pre-scoping value,
 * honored as the fallback. A NEW key, because the old values mean the opposite: the previous key held an EFFORT axis
 * (old `high` = squeeze hardest = new `low`), so reading it as this one would invert everyone's choice — the old key
 * is a migration source only ({@link LEGACY_LEVEL_MIGRATION}, write-once; only the new key is ever written). Kept
 * here rather than in `UI_KEYS` so the table, storage and transform stay one unit.
 */
export const IMAGE_QUALITY_STORAGE_KEY = "ohmail.ui.compose.imageQuality";

/** The key this preference used while the dial was called "shrink". Read, never written. */
export const LEGACY_IMAGE_SHRINK_STORAGE_KEY = "ohmail.ui.compose.imageShrink";

/**
 * OLD EFFORT LEVEL → NEW QUALITY LEVEL. The reversal, written out once.
 *
 * `none` (never touch the file) is `original`. `high` (squeeze hardest) is `low`. `low` (squeeze
 * least) is `high`. `medium` is the only string that means the same thing under both names, which
 * is exactly what makes the other three dangerous to read without this table.
 */
export const LEGACY_LEVEL_MIGRATION: Readonly<Record<string, ImageQualityLevel>> = {
  none: "original",
  low: "high",
  medium: "medium",
  high: "low",
};

/** The storage key for one account's level — the bare key for a surface with no account. */
export function imageQualityKeyFor(accountId: string | null): string {
  return accountId ? `${IMAGE_QUALITY_STORAGE_KEY}:${accountId}` : IMAGE_QUALITY_STORAGE_KEY;
}

/** The legacy key for one account — the same scoping the new key uses. */
export function legacyImageShrinkKeyFor(accountId: string | null): string {
  return accountId
    ? `${LEGACY_IMAGE_SHRINK_STORAGE_KEY}:${accountId}`
    : LEGACY_IMAGE_SHRINK_STORAGE_KEY;
}

/**
 * The stored level for this account, or the default. FOUR READS, IN ONE ORDER, AND THE ORDER IS THE MIGRATION. The
 * account-scoped NEW key wins; then the account-less new key (the desktop's store, and where a pre-scoping choice
 * lives); then the same two positions on the LEGACY key, each mapped through {@link LEGACY_LEVEL_MIGRATION}. A new
 * value always beats an old one, so a person who has touched the dial since the rename is never pulled back to what
 * they chose before it. NEVER CALL THIS DURING A RENDER. There is no `localStorage` on the server, so a component
 * that read it while rendering would draw the default on the server, the stored value on the client, and React would
 * resolve the mismatch by keeping the SERVER's — silently discarding the setting. The settings row reads it in an
 * effect; the attach control reads it in an effect and inside the pick, both after mount by construction.
 */

/**
 * A blocked or throwing storage (Safari private mode, site data blocked) resolves to the default rather than
 * propagating: a preference is never worth breaking an attach over.
 */
export function readImageQualityLevel(accountId: string | null = null): ImageQualityLevel {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return DEFAULT_IMAGE_QUALITY_LEVEL;
    if (accountId) {
      const scoped = ls.getItem(imageQualityKeyFor(accountId));
      if (isImageQualityLevel(scoped)) return scoped;
    }
    const bare = ls.getItem(IMAGE_QUALITY_STORAGE_KEY);
    if (isImageQualityLevel(bare)) return bare;

    // Nothing on the new key. Fall back to the pre-rename one, MAPPED — see the header.
    if (accountId) {
      const legacyScoped = LEGACY_LEVEL_MIGRATION[ls.getItem(legacyImageShrinkKeyFor(accountId)) ?? ""];
      if (legacyScoped) return legacyScoped;
    }
    const legacyBare = LEGACY_LEVEL_MIGRATION[ls.getItem(LEGACY_IMAGE_SHRINK_STORAGE_KEY) ?? ""];
    if (legacyBare) return legacyBare;

    return DEFAULT_IMAGE_QUALITY_LEVEL;
  } catch {
    return DEFAULT_IMAGE_QUALITY_LEVEL;
  }
}

export function writeImageQualityLevel(
  level: ImageQualityLevel,
  accountId: string | null = null,
): void {
  // The choice still holds for this session; a jar that refused it says so once.
  durableSet(imageQualityKeyFor(accountId), level, "compose.imageQuality");
}

export interface CompressedFile {
  /**
   * The bytes to attach. **Identically the input object** when nothing was replaced, which is what
   * makes "untouched" checkable by identity rather than by comparing two byte arrays.
   */
  readonly blob: Blob;
  /** The MIME type to send. Same format as the input, always. */
  readonly contentType: string;
  readonly bytes: number;
  readonly originalBytes: number;
  /** True only when `blob` is a re-encode that came out smaller than the original. */
  readonly compressed: boolean;
}

/** The subset of `ImageBitmap` this file uses. Named so a test can supply one. */
interface BitmapLike {
  readonly width: number;
  readonly height: number;
  close?: () => void;
}

/**
 * Decode to a bitmap that is ALREADY ROTATED. See the orientation note in the file header — this
 * option is the reason stripping the metadata does not put photos on their side.
 *
 * `createImageBitmap` is absent on WKWebView before iOS 15 and can reject on a corrupt file. Both
 * resolve to `null`, and `null` means "send the original", never "fail the attach".
 */
async function decode(blob: Blob): Promise<BitmapLike | null> {
  const create = (globalThis as {
    createImageBitmap?: (b: Blob, o?: { imageOrientation?: string }) => Promise<BitmapLike>;
  }).createImageBitmap;
  if (typeof create !== "function") return null;
  try {
    const bitmap = await create(blob, { imageOrientation: "from-image" });
    return bitmap && bitmap.width > 0 && bitmap.height > 0 ? bitmap : null;
  } catch {
    return null;
  }
}

interface CanvasContextLike {
  drawImage: (image: never, dx: number, dy: number, dw: number, dh: number) => void;
}

interface OffscreenCanvasLike {
  getContext: (id: "2d") => CanvasContextLike | null;
  convertToBlob: (options?: { type?: string; quality?: number }) => Promise<Blob>;
}

/**
 * Draw the bitmap at the target size and read the bytes back. TWO PATHS, AND THE SECOND IS NOT DEAD CODE.
 * `OffscreenCanvas.convertToBlob` is the good path — it needs no document and never touches the DOM — but Safari and
 * WKWebView only got it in 16.4, and the desktop shell runs on the system WebView. So the element's `toBlob` is the
 * fallback, and it is reached in two ways: no `OffscreenCanvas` at all, and an `OffscreenCanvas` whose
 * `convertToBlob` throws or is missing (the shape a partial implementation has). The first path therefore falls
 * THROUGH on failure rather than returning null. Every failure here ends at `null`, which the caller reads as "send
 * the original".
 */
async function encode(
  bitmap: BitmapLike,
  width: number,
  height: number,
  type: "image/jpeg" | "image/png",
  quality: number,
): Promise<Blob | null> {
  const Offscreen = (globalThis as {
    OffscreenCanvas?: new (w: number, h: number) => OffscreenCanvasLike;
  }).OffscreenCanvas;
  if (typeof Offscreen === "function") {
    try {
      const canvas = new Offscreen(width, height);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(bitmap as never, 0, 0, width, height);
        const blob = await canvas.convertToBlob({ type, quality });
        if (blob) return blob;
      }
    } catch {
      /* fall through to the element — see the note above */
    }
  }

  const doc = (globalThis as { document?: Document }).document;
  if (!doc || typeof doc.createElement !== "function") return null;
  try {
    const canvas = doc.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d") as unknown as CanvasContextLike | null;
    if (!ctx || typeof canvas.toBlob !== "function") return null;
    ctx.drawImage(bitmap as never, 0, 0, width, height);
    return await new Promise<Blob | null>((resolve) => {
      try {
        canvas.toBlob((blob) => resolve(blob), type, quality);
      } catch {
        resolve(null);
      }
    });
  } catch {
    return null;
  }
}

/**
 * THE ENTRY POINT. Give it a picked file and a level; get back the bytes to attach.
 *
 * It never throws and never rejects: every way this can fail — an unsupported type, a browser with
 * no decoder, a corrupt file, a canvas that refuses, a re-encode that came out bigger — returns the
 * ORIGINAL file with `compressed: false`. Attaching a picture must not become less reliable because
 * the product tries to make it smaller.
 */
export async function compressImage(file: Blob, level: ImageQualityLevel): Promise<CompressedFile> {
  const originalBytes = file.size;
  const original: CompressedFile = {
    blob: file,
    contentType: file.type || "application/octet-stream",
    bytes: originalBytes,
    originalBytes,
    compressed: false,
  };

  const rule = IMAGE_QUALITY_RULES[level];
  if (rule === null) return original;

  const type = encodableImageType(file.type);
  if (type === null || originalBytes === 0) return original;

  const bitmap = await decode(file);
  if (bitmap === null) return original;

  try {
    // FROM THE BITMAP, never from a dimension read before the decode: `from-image` has already
    // applied the EXIF rotation, so a portrait photo tagged Orientation 6 arrives 3000×4000 and the
    // box we fit must be that one. Sizing from the stored 4000×3000 would write a landscape canvas
    // and squash the picture into it.
    const box = fitWithin(bitmap.width, bitmap.height, rule.maxEdge);
    const out = await encode(bitmap, box.width, box.height, type, rule.quality);

    // THE NON-NEGOTIABLE GUARD. `>=` and not `>`: a re-encode that saves nothing has still thrown
    // away fidelity, so there is no size at which taking it is the better trade.
    if (out === null || out.size === 0 || out.size >= originalBytes) return original;

    return {
      blob: out,
      contentType: type,
      bytes: out.size,
      originalBytes,
      compressed: true,
    };
  } finally {
    // Bitmaps hold decoded pixels — 48 MB for a 12-megapixel photo. Releasing is not optional when
    // somebody attaches ten of them.
    try {
      bitmap.close?.();
    } catch {
      /* not every implementation has it; nothing here depends on the release succeeding */
    }
  }
}
