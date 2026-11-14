/** The paint-blocking desktop script also uses these constants and operations. */
/** The one key, unkeyed by owner: a text size is a fact about this screen and these eyes. */
export const TEXT_SIZE_KEY = "ohmail.textSize";

/** The offered sizes, in percent. The shell's `text_scale::SIZES` is the same list. */
export const TEXT_SIZES = [90, 100, 110, 125, 150] as const;

export type TextSize = (typeof TEXT_SIZES)[number];

export const DEFAULT_TEXT_SIZE: TextSize = 100;

/** The custom property the stylesheet divides viewport units by. */
export const UI_ZOOM_VAR = "--ui-zoom";

export function isTextSize(v: unknown): v is TextSize {
  return typeof v === "number" && (TEXT_SIZES as readonly number[]).includes(v);
}

/** Resolve just the stored value. The first-paint script supplies its own storage. */
export function textSizeOf(raw: string | null | undefined): TextSize {
  const size = raw == null ? NaN : Number(raw);
  return isTextSize(size) ? size : DEFAULT_TEXT_SIZE;
}

/** The browser half: `zoom` and `--ui-zoom` on the root, both removed at 100%. */
export function stampTextSize(root: HTMLElement, size: TextSize): void {
  if (size === DEFAULT_TEXT_SIZE) {
    root.style.removeProperty("zoom");
    root.style.removeProperty(UI_ZOOM_VAR);
    return;
  }
  const zoom = String(size / 100);
  root.style.setProperty("zoom", zoom);
  root.style.setProperty(UI_ZOOM_VAR, zoom);
}
