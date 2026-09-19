/**
 * THE CONSENTED REMOTE-IMAGE FETCH — the phone's one road for a sender-named picture, taken
 * only on the reader's own "Show images" press (or the account's pictures-by-default switch).
 * The DOCUMENT never gains network: every fetched image is minted to a gated `data:` URI and
 * substituted app-side, under the engine's own inline-image ceilings, with no credentials and
 * no headers of ours; a tracking-pixel-shaped url never reaches here. The privacy delta
 * against the web's proxy — the image host sees the reader's network address, as in every
 * non-proxying mail client — is a stated trade, and the app's network-seam census names this
 * file for exactly that.
 */

import {
  INLINE_IMAGE_MAX_BYTES,
  INLINE_IMAGE_MAX_PARTS,
  INLINE_IMAGE_MAX_TOTAL_BYTES,
  INLINE_IMAGE_SRC,
  REMOTE_URL,
} from "@ohmail/client-engine";
import { blobToBase64 } from "./blob-base64";

/** The four raster types a fetched image may carry into the document — the mint's own set. */
const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Fetch the message's blocked remote PICTURES and mint each to a `data:` URI, in document
 * order so the budget is spent on what the reader sees first. Never rejects; a part that
 * cannot be fetched, is not a raster, or is over a ceiling is simply absent from the map —
 * a blank box, which is what the message showed before consent.
 */
export async function fetchRemoteImages(urls: readonly string[]): Promise<Map<string, string>> {
  const minted = new Map<string, string>();
  let budget = INLINE_IMAGE_MAX_TOTAL_BYTES;
  for (const url of urls) {
    if (minted.size >= INLINE_IMAGE_MAX_PARTS) break;
    if (minted.has(url) || !REMOTE_URL.test(url)) continue;
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) continue;
      const blob = await res.blob();
      const type = (blob.type || "").toLowerCase().split(";")[0]!.trim();
      if (!RASTER.has(type)) continue;
      if (blob.size === 0 || blob.size > INLINE_IMAGE_MAX_BYTES || blob.size > budget) continue;
      const uri = `data:${type};base64,${await blobToBase64(blob)}`;
      // The same gate the write into the document applies — minted here, asserted there.
      if (!INLINE_IMAGE_SRC.test(uri)) continue;
      budget -= blob.size;
      minted.set(url, uri);
    } catch {
      // An unreachable host is a blank box, never an error screen.
    }
  }
  return minted;
}
