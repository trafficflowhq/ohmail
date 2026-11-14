import type { CSSProperties } from "react";
import { v } from "../tokens.js";

/* The eight hues a person can wear. They have no token yet. */
const HUES = [25, 42, 78, 112, 150, 196, 250, 318] as const;

/** The hue a person wears: a pure function of the address, so one person has one colour in every list. */
export function avatarHue(address: string): number {
  let h = 0x811c9dc5;
  const key = address.trim().toLowerCase();
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return HUES[h % HUES.length]!;
}

/**
 * A hue in the colours the parts wear it in. How light and how strong each is comes from the tokens;
 * the hue is the person's or the tag's own, so the colour is put together here and not in a stylesheet.
 */
export const hueStyle = (hue: number): CSSProperties =>
  ({
    "--oh-hue-bg": `oklch(${v("av-bg")} ${hue})`,
    "--oh-hue-fg": `oklch(${v("av-fg")} ${hue})`,
    "--oh-hue-dot": `oklch(${v("tag-dot")} ${hue})`,
    /* The tint ohmarchy mixes into a circle: no token carries it yet. */
    "--oh-hue-tint": `oklch(0.62 0.13 ${hue})`,
  }) as CSSProperties;
