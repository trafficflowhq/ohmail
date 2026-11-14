import type { CSSProperties } from "react";
import { v } from "../base/tokens.js";
import "./tone.css";

/**
 * Whose a calendar part is. A number is the calendar's hue on the ring, in degrees; `"neutral"` is a
 * calendar without a hue; `null` is a thing that is on no calendar yet.
 *
 * The hue is an input because a calendar is data. The lightness and the chroma it is drawn with are
 * tokens, so one hue reads right on both faces and in both schemes.
 */
export type CalendarTone = number | "neutral" | null;

/** The class and the attribute a part in a calendar's colour carries; nothing for a thing on no calendar. */
export function toneOf(tone: CalendarTone): { className: string; "data-tone"?: "hue" | "neutral" } {
  if (tone === null) return { className: "" };
  return { className: "oh-cal-tone", "data-tone": tone === "neutral" ? "neutral" : "hue" };
}

/** The two colours of a hue, mixed from the calendar's tokens: the square's, and what an event stands on. */
export function toneStyle(tone: CalendarTone): CSSProperties | undefined {
  if (typeof tone !== "number") return undefined;
  return {
    "--oh-cal-mark": `oklch(${v("cal-mark")} ${tone})`,
    "--oh-cal-tint": `oklch(${v("cal-tint")} ${tone})`,
  } as CSSProperties;
}

/** Class names joined, the empty ones left out. */
export const cx = (...names: (string | false | null | undefined)[]): string =>
  names.filter(Boolean).join(" ");
