/**
 * SETTINGS → TEXT SIZE — one setting, per device, read before the first paint on every surface.
 *
 * The desktop window turns it into the webview's own page zoom (the shell's `set_text_size`), so
 * layout, hit targets and geometry scale as one. A browser has no such door, so the web door and
 * the served host client stamp a CSS `zoom` on `<html>` plus `--ui-zoom` for the stylesheet's
 * viewport units; `@ohmail/ui`'s `uiZoom()` reads that stamp back for the shell's geometry. 100% is
 * the absence of both, byte-identical to the stylesheet without this feature. Phones keep the OS
 * font scale. The desktop's paint-blocking boot stamp uses the import-free values module.
 */

import { localStorageDoor } from "@ohmail/client-engine/durable";
import {
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_KEY,
  TEXT_SIZES,
  UI_ZOOM_VAR,
  stampTextSize,
  textSizeOf,
  type TextSize,
} from "./text-size-values.js";

export {
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_KEY,
  TEXT_SIZES,
  UI_ZOOM_VAR,
  isTextSize,
  stampTextSize,
  type TextSize,
} from "./text-size-values.js";

const sizeStorage = localStorageDoor("ui.textSize");

/** The stored size, or the default for an empty, blocked or foreign value. */
export function readTextSize(storage?: Storage | null): TextSize {
  try {
    return textSizeOf(storage == null ? sizeStorage.get(TEXT_SIZE_KEY) : storage.getItem(TEXT_SIZE_KEY));
  } catch {
    return DEFAULT_TEXT_SIZE;
  }
}

/** How a size reaches the screen on this host. The browser stamp unless a host installs another. */
export type TextSizeApplier = (size: TextSize) => void;

let applier: TextSizeApplier | null = null;

/** The desktop window installs the native zoom here; every other host keeps the stamp. */
export function installTextSizeApplier(next: TextSizeApplier | null): void {
  applier = next;
}

/** Put a size on screen through the installed applier or the root supplied by the browser host. */
export function applyTextSize(size: TextSize, root?: HTMLElement | null): void {
  if (applier) applier(size);
  else if (root) stampTextSize(root, size);
}

/**
 * THE SAME READ AND STAMP AS A STRING, for the web door, which paints from server-rendered HTML
 * before any bundle runs (inlined under the request's nonce beside the theme and column stamps).
 * Hand-written for `columnsBootScript`'s reason; `text-size.test.ts` executes it and requires the
 * stamp {@link stampTextSize} writes.
 */
export function textSizeBootScript(): string {
  const sizes = JSON.stringify(TEXT_SIZES);
  return (
    `(function(){try{var n=Number(localStorage.getItem(${JSON.stringify(TEXT_SIZE_KEY)}));` +
    `if(n===${DEFAULT_TEXT_SIZE}||${sizes}.indexOf(n)<0)return;var z=String(n/100),d=document.documentElement.style;` +
    `d.setProperty("zoom",z);d.setProperty(${JSON.stringify(UI_ZOOM_VAR)},z)}catch(e){}})()`
  );
}
