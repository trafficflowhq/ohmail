/**
 * The thin geometric icon set — path data extracted verbatim from the
 * Blanc prototype's <symbol> defs, inlined so every component is
 * self-contained (no external <use> sheet required).
 */
import type { CSSProperties, ReactElement } from "react";

export const ICON_PATHS: Record<string, ReactElement> = {
  ohbox: (
    <path d="M2 8.5V12a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 12V8.5M2 8.5 4 3.6A1.5 1.5 0 0 1 5.4 2.7h5.2a1.5 1.5 0 0 1 1.4.9L14 8.5M2 8.5h3.4l1 1.8h3.2l1-1.8H14" />
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 4.8V8l2.2 1.4" />
    </>
  ),
  pause: <path d="M5.8 3.8v8.4M10.2 3.8v8.4" />,
  up: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 10.6V5.6M5.8 7.6 8 5.4l2.2 2.2" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.4" />
      <path d="m10.4 10.4 3 3" />
    </>
  ),
  shield: <path d="M8 2.2 13 4.3v3.6c0 3-2 5-5 5.9-3-.9-5-2.9-5-5.9V4.3z" />,
  clip: (
    <path d="M10.6 5.1 6.2 9.5a1.6 1.6 0 0 0 2.3 2.3l4.6-4.6a3 3 0 0 0-4.3-4.3L4.2 7.5a4.4 4.4 0 0 0 6.2 6.2l3.4-3.4" />
  ),
  route: (
    <>
      <circle cx="3.4" cy="12.6" r="1.6" />
      <circle cx="12.6" cy="3.4" r="1.6" />
      <path d="M4.8 11.4c2.6-1 5.6-4 6.6-6.6" />
    </>
  ),
  spark: <path d="M8 2.4 9.3 6.7 13.6 8l-4.3 1.3L8 13.6 6.7 9.3 2.4 8l4.3-1.3z" />,
  door: <path d="M9.5 2.5h3v11h-3M9.5 8h-7M4.9 5.6 2.5 8l2.4 2.4" />,
  sun: (
    <>
      <circle cx="8" cy="8" r="2.6" />
      <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 7.4v3.4M8 5.2v.1" />
    </>
  ),
  x: <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />,
  check: <path d="m3.5 8.5 3 3 6-6.5" />,
  menu: <path d="M3 5.2h10M3 10.8h10" />,
  /** A circular arrow — "check the server now" (the pull-new-mail affordance). */
  refresh: <path d="M12.8 8A4.8 4.8 0 1 1 11 4.3M11.2 1.9l.3 2.6-2.6.3" />,
  open: <path d="M9.5 2.5h4v4M13.5 2.5 8.5 7.5M6.5 13.5h-4v-4M2.5 13.5 7.5 8.5" />,
  tag: (
    <>
      <path d="M2.6 7.4V3.2a.6.6 0 0 1 .6-.6h4.2a1 1 0 0 1 .7.3l5 5a1 1 0 0 1 0 1.4l-4.2 4.2a1 1 0 0 1-1.4 0l-5-5a1 1 0 0 1-.3-.7z" />
      <circle cx="5.6" cy="5.6" r=".9" />
    </>
  ),
  plus: <path d="M8 3.6v8.8M3.6 8h8.8" />,
  /* The folder rows in the rail (FOLDERS-SPEC.md §14) — the prototype's 24-grid folder glyph,
     redrawn on this set's 16 grid so it sits exactly where a tag's dot does. */
  folder: (
    <path d="M2.2 4.6a1.2 1.2 0 0 1 1.2-1.2h2.9l1.3 1.3h5a1.2 1.2 0 0 1 1.2 1.2v5.5a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2z" />
  ),
  chev: <path d="m6 3.8 4.2 4.2L6 12.2" />,
  /* The reader's Delete verb (a move to the provider's own Trash folder, never an expunge) —
     drawn thin on the 16 grid like the rest of the set. */
  trash: (
    <>
      <path d="M3 4.4h10M6.4 4.4V3.2a.8.8 0 0 1 .8-.8h1.6a.8.8 0 0 1 .8.8v1.2" />
      <path d="m4.2 4.4.7 8a1.2 1.2 0 0 0 1.2 1.1h3.8a1.2 1.2 0 0 0 1.2-1.1l.7-8" />
      <path d="M6.6 7v4M9.4 7v4" />
    </>
  ),
  pen: (
    <>
      <path d="m3.2 12.8.7-2.9 7.2-7.2a1.45 1.45 0 0 1 2.05 2.05l-7.2 7.2-2.75.85z" />
      <path d="m9.9 3.9 2.1 2.1" />
    </>
  ),
};

export type IconName = keyof typeof ICON_PATHS & string;

export interface IconProps {
  name: IconName;
  /** Square size in px; defaults to the 15px `.ic` base. */
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export function Icon({ name, size, className, style }: IconProps) {
  const sized = size ? { width: size, height: size, ...style } : style;
  return (
    <svg
      className={className ? `ic ${className}` : "ic"}
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={sized}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}
