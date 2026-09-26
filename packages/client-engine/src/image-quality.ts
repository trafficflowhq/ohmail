/**
 * PICTURE QUALITY — the one level table every composer shrinks a picture by, so a photo the web
 * attaches at a level is the photo the phone attaches at it. It lived in the webapp's
 * `image-quality.ts` and the phone could not reach it there; the webapp re-exports these names,
 * and how each surface re-encodes (a canvas, a native manipulator) stays its own.
 */

/** Ascending by quality, `original` last — the order both surfaces render. */
export const IMAGE_QUALITY_LEVELS = ["low", "medium", "high", "original"] as const;

export type ImageQualityLevel = (typeof IMAGE_QUALITY_LEVELS)[number];

/** Medium by default — a product decision (mail is not a photo library), pinned by a guard. */
export const DEFAULT_IMAGE_QUALITY_LEVEL: ImageQualityLevel = "medium";

export interface ImageQualityRule {
  /** The longest side the output may have, in pixels. A smaller picture is never enlarged. */
  readonly maxEdge: number;
  /** JPEG encoder quality, 0–1. A PNG encoder is lossless and ignores it. */
  readonly quality: number;
}

/** The one table. `original` ships the file exactly as it was picked. */
export const IMAGE_QUALITY_RULES: Readonly<Record<ImageQualityLevel, ImageQualityRule | null>> = {
  low: { maxEdge: 1600, quality: 0.72 },
  medium: { maxEdge: 2048, quality: 0.82 },
  high: { maxEdge: 3200, quality: 0.92 },
  original: null,
};

export function isImageQualityLevel(value: unknown): value is ImageQualityLevel {
  return typeof value === "string" && (IMAGE_QUALITY_LEVELS as readonly string[]).includes(value);
}

/** The output box: the source scaled to fit `maxEdge`, never enlarged, never below 1px. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * The formats a picture may be re-encoded in, normalised: `image/jpg` and `image/pjpeg` are real
 * picker values and the same format. Anything else (GIF, SVG, HEIC, untyped) is never touched —
 * formats are kept, so a filename never stops matching its bytes.
 */
export function encodableImageType(mime: string | null | undefined): "image/jpeg" | "image/png" | null {
  const m = (mime ?? "").toLowerCase().split(";")[0]!.trim();
  if (m === "image/jpeg" || m === "image/jpg" || m === "image/pjpeg") return "image/jpeg";
  if (m === "image/png") return "image/png";
  return null;
}
