/**
 * SHRINKING A PICTURE BEFORE IT IS ATTACHED — the transform, the level table, and where the level
 * is kept. No React here on purpose: the only thing this file needs from a browser is a decoder and
 * a canvas, both read off `globalThis` at call time, so the whole of it is reachable from a test.
 *
 * ── WHY THE CLIENT AND NOT THE SERVER ────────────────────────────────────────────────────────
 *
 * Attachment bytes ride the SEND request base64-encoded, so a 6 MB photo is ~8 MB on the wire and
 * over the hosted API's body limit before it has been looked at. Shrinking after the upload would
 * save the mailbox and nothing else; shrinking here is what decides whether the send happens at
 * all. That is also why the call sits BEFORE the cap check in `ComposeAttach.onFiles` rather than
 * after it — see the note there. A photo that only fits once it has been shrunk must attach, and it
 * cannot if the cap has already refused it.
 *
 * ── FORMATS ARE KEPT. THE COMPRESSION IS LOSSY WITHIN THE FORMAT ─────────────────────────────
 *
 * A JPEG comes back a JPEG and a PNG comes back a PNG. Nothing here converts anything, which is why
 * the filename is never rewritten — an extension that stopped matching its bytes is a worse problem
 * than the one this file solves, and a recipient whose viewer only opens what the name promises is
 * not a hypothetical.
 *
 * The consequence is that the two formats get different amounts of help, and honestly so:
 *
 *  · JPEG — re-encoded at the level's quality AND fitted to the level's longest edge. This is where
 *    the saving is, because a phone photo is a JPEG and the quality dial is the whole lever.
 *  · PNG — DIMENSION DOWNSCALE ONLY. Canvas PNG encoding is lossless and ignores `quality`, so an
 *    already-small PNG re-encodes to something the same size or bigger and is kept as it was by the
 *    guard below. Palette quantisation (the pngquant class of tool, which is what would actually
 *    shrink a screenshot) is a NAMED FOLLOW-UP behind this same seam: it changes only what `encode`
 *    does for `image/png`, and every caller, guard and setting stays as it is.
 *  · GIF, SVG, anything else, and anything with no type — UNTOUCHED, always, at every level. An
 *    animated GIF through a canvas comes out as its first frame, and an SVG comes out a raster; both
 *    are silent data loss dressed as an optimisation.
 *
 * ── THE GUARD THAT IS NOT NEGOTIABLE ─────────────────────────────────────────────────────────
 *
 * IF THE RE-ENCODE IS NOT SMALLER, THE ORIGINAL BYTES ARE SENT. Re-encoding can enlarge a file —
 * routinely for PNG, and for a JPEG that was already saved at a lower quality than ours — and a
 * feature called "shrink" that makes a file bigger while losing fidelity is worse than not running.
 * The comparison is `>=`, so a re-encode that saves nothing is discarded too.
 *
 * ── EXIF, AND THE ONE PLACE THE PROMISE HAS A HOLE ───────────────────────────────────────────
 *
 * A canvas has no metadata. Drawing an image into one and reading it back drops EVERY EXIF tag the
 * source carried — the camera and lens, the timestamps, and the GPS position a phone writes by
 * default. That is a privacy improvement the user did not have to ask for, and it is the reason
 * the default level is `high` rather than `none`.
 *
 * The hole is the guard above: a picture whose re-encode came out bigger is sent AS IT WAS, EXIF
 * included. It is the honest trade — the alternative is shipping a bigger, worse file to strip a
 * tag — and the setting's copy says so rather than promising a strip that has an exception.
 * Level `none` sends the original bytes always, EXIF intact, and its copy says that too.
 *
 * Orientation is the other half of the metadata story and it goes the other way: the decode asks
 * for `imageOrientation: "from-image"`, so the bitmap arrives already rotated and the pixels we
 * write are upright. Without it, dropping the EXIF would drop the `Orientation` tag that was the
 * only thing keeping the picture the right way up, and every photo shot in portrait would arrive
 * on its side. This is why the output dimensions are taken from the BITMAP and never from anything
 * read ahead of the decode.
 */

/** The four levels, in the order the settings control shows them. */
export const IMAGE_SHRINK_LEVELS = ["none", "low", "medium", "high"] as const;

export type ImageShrinkLevel = (typeof IMAGE_SHRINK_LEVELS)[number];

/**
 * HIGH BY DEFAULT — a decision, not an omission.
 *
 * Mail is not a photo library. The overwhelmingly common attachment is a phone photo sent so that
 * somebody can look at it, and 1600px at quality 0.72 is indistinguishable from the original in a
 * mail reader while being roughly a tenth of the bytes. The rarer case — sending an original for
 * printing or editing — is a person who knows they are doing it and can set the dial to None.
 * Defaulting to None instead would mean the common case silently fails the size cap.
 */
export const DEFAULT_IMAGE_SHRINK_LEVEL: ImageShrinkLevel = "high";

export interface ImageShrinkRule {
  /** The longest side the output may have, in pixels. A smaller picture is never enlarged. */
  readonly maxEdge: number;
  /** JPEG encoder quality, 0–1. Ignored by the PNG encoder, which is lossless. */
  readonly quality: number;
}

/**
 * THE ONE TABLE. Every number this feature applies is here and nowhere else — no second copy in the
 * component, none in the settings row, none in the tests, which assert against these values rather
 * than restating them.
 *
 * The edges are chosen against what the picture is FOR, not against a device: 1600px is larger than
 * any mail reader's column and still sharp full-screen on a laptop; 2048 covers a 4K viewer;
 * 3200 keeps enough for a modest crop or print. The qualities are the usual JPEG knee — visible
 * artefacts start below about 0.6, and above about 0.9 the file grows fast for nothing.
 */
export const IMAGE_SHRINK_RULES: Readonly<Record<ImageShrinkLevel, ImageShrinkRule | null>> = {
  /** Ship the file exactly as it was picked. No decode, no canvas, no metadata stripped. */
  none: null,
  low: { maxEdge: 3200, quality: 0.92 },
  medium: { maxEdge: 2048, quality: 0.82 },
  high: { maxEdge: 1600, quality: 0.72 },
};

/**
 * WHERE THE LEVEL LIVES — this browser, not the account.
 *
 * It is the same class of preference as the theme: per-machine, about how this install behaves
 * rather than about anybody's mail, and worth neither a column nor a request on every change. It
 * also has a per-machine reading that a synced value would get wrong — the laptop on a hotel
 * connection and the desktop on fibre want different answers.
 *
 * Namespaced under `ohmail.ui.` like everything else this app stores (`shell/persisted-ui.ts`), and
 * kept HERE rather than in that file's `UI_KEYS` so the level's table, storage and transform are one
 * unit: the follow-up that adds PNG quantisation touches this file and no other.
 */
export const IMAGE_SHRINK_STORAGE_KEY = "ohmail.ui.compose.imageShrink";

export function isImageShrinkLevel(value: unknown): value is ImageShrinkLevel {
  return typeof value === "string" && (IMAGE_SHRINK_LEVELS as readonly string[]).includes(value);
}

/**
 * The stored level, or the default.
 *
 * NEVER CALL THIS DURING A RENDER. There is no `localStorage` on the server, so a component that
 * read it while rendering would draw the default on the server, the stored value on the client, and
 * React would resolve the mismatch by keeping the SERVER's — silently discarding the setting. The
 * settings row reads it in an effect; the attach control reads it inside the click, which is after
 * mount by construction.
 *
 * A blocked or throwing storage (Safari private mode, site data blocked) resolves to the default
 * rather than propagating: a preference is never worth breaking an attach over.
 */
export function readImageShrinkLevel(): ImageShrinkLevel {
  try {
    const raw = (globalThis as { localStorage?: Storage }).localStorage?.getItem(
      IMAGE_SHRINK_STORAGE_KEY,
    );
    return isImageShrinkLevel(raw) ? raw : DEFAULT_IMAGE_SHRINK_LEVEL;
  } catch {
    return DEFAULT_IMAGE_SHRINK_LEVEL;
  }
}

export function writeImageShrinkLevel(level: ImageShrinkLevel): void {
  try {
    (globalThis as { localStorage?: Storage }).localStorage?.setItem(
      IMAGE_SHRINK_STORAGE_KEY,
      level,
    );
  } catch {
    /* private mode refuses writes; the choice still holds for this session */
  }
}

export interface ShrunkFile {
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
  readonly shrunk: boolean;
}

/** The subset of `ImageBitmap` this file uses. Named so a test can supply one. */
interface BitmapLike {
  readonly width: number;
  readonly height: number;
  close?: () => void;
}

/**
 * The MIME types this file will re-encode, normalised to what a canvas actually accepts.
 *
 * `image/jpg` and `image/pjpeg` are real values from real pickers and neither is a canvas type: a
 * canvas handed an unknown type silently encodes PNG instead, which would turn a JPEG into a
 * PNG — a format change, in the file whose first rule is that formats are kept. Normalising is not
 * a conversion; it is the same format under the name the spec gave it.
 */
function encodableType(mime: string | undefined): "image/jpeg" | "image/png" | null {
  const m = (mime ?? "").toLowerCase().split(";")[0]!.trim();
  if (m === "image/jpeg" || m === "image/jpg" || m === "image/pjpeg") return "image/jpeg";
  if (m === "image/png") return "image/png";
  return null;
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
 * Draw the bitmap at the target size and read the bytes back.
 *
 * TWO PATHS, AND THE SECOND IS NOT DEAD CODE. `OffscreenCanvas.convertToBlob` is the good path —
 * it needs no document and never touches the DOM — but Safari and WKWebView only got it in 16.4,
 * and the desktop shell runs on the system WebView. So the element's `toBlob` is the fallback, and
 * it is reached in two ways: no `OffscreenCanvas` at all, and an `OffscreenCanvas` whose
 * `convertToBlob` throws or is missing (the shape a partial implementation has). The first path
 * therefore falls THROUGH on failure rather than returning null.
 *
 * Every failure here ends at `null`, which the caller reads as "send the original".
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
 * ORIGINAL file with `shrunk: false`. Attaching a picture must not become less reliable because the
 * product tries to make it smaller.
 */
export async function shrinkImage(file: Blob, level: ImageShrinkLevel): Promise<ShrunkFile> {
  const originalBytes = file.size;
  const original: ShrunkFile = {
    blob: file,
    contentType: file.type || "application/octet-stream",
    bytes: originalBytes,
    originalBytes,
    shrunk: false,
  };

  const rule = IMAGE_SHRINK_RULES[level];
  if (rule === null) return original;

  const type = encodableType(file.type);
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
      shrunk: true,
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
