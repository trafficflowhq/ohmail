/**
 * The blocked-content notice's one sentence run — which of the web reader's sentences this
 * blocking pass earns. Pure over the sanitizer's output so the suite drives it directly; the
 * sheet sentence stays LAST (the web's rule: the first number in the bar is the images').
 */

import { Copy } from "../copy";
import type { PhoneBlockedAsset } from "./sanitize";

export function blockedNotice(
  blocked: readonly PhoneBlockedAsset[],
  sheets: readonly string[],
  imagesShown: boolean,
): string | null {
  const imgs = blocked.filter((b) => b.via === "img" || b.via === "css" || b.via === "attr");
  const pixels = imgs.filter((b) => b.pixel);
  const sheetSaid =
    sheets.length === 0
      ? null
      : sheets.length === 1
        ? Copy.mailSheetBlockedOne
        : Copy.mailSheetBlockedMany(sheets.length);
  if (imagesShown) {
    // The pictures are on screen and the beacons alone were refused — said whole.
    const pixelSaid =
      pixels.length === 0
        ? null
        : pixels.length === 1
          ? Copy.mailPixelOnly
          : Copy.mailPixelsRefused(pixels.length);
    return [pixelSaid, sheetSaid].filter((s) => s !== null).join(" ") || null;
  }
  if (imgs.length === 0) return sheetSaid;
  if (imgs.length === 1 && pixels.length === 1) {
    return [Copy.mailPixelOnly, sheetSaid].filter((s) => s !== null).join(" ");
  }
  const lead = imgs.length === 1 ? Copy.mailImagesBlockedOne : Copy.mailImagesBlockedMany(imgs.length);
  const pixelSaid =
    pixels.length === 0 ? null : pixels.length === 1 ? Copy.mailPixelOne : Copy.mailPixelMany(pixels.length);
  // The sheet sentence stays LAST — the web's rule: the first number in the bar is the images'.
  return [lead, pixelSaid, sheetSaid].filter((s) => s !== null).join(" ");
}

