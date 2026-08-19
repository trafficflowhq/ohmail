/**
 * Blanc's thin geometric icon set, ported to `react-native-svg`.
 *
 * The paths in `PATHS` are copied byte-for-byte from the `<symbol>` defs in
 * `design/proposals/blanc/index.html`, on the same 16×16 grid, drawn with the
 * prototype's own `svg.ic` rule: `stroke:currentColor; fill:none;
 * stroke-width:1.3; linecap/linejoin:round`. No icon here was redrawn.
 *
 * Three glyphs have no prototype twin, because the desktop rail is purely
 * typographic and a phone tab bar is not: `reads`, `receipts` and `more` are
 * new, drawn on the same grid with the same stroke so they sit in the set
 * rather than beside it. They are marked below.
 */
import Svg, { Circle, Path, type SvgProps } from "react-native-svg";

export type IconName = keyof typeof PATHS;

const PATHS = {
  /* — verbatim from the prototype's symbol defs — */
  ohbox: "M2 8.5V12a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 12V8.5M2 8.5 4 3.6A1.5 1.5 0 0 1 5.4 2.7h5.2a1.5 1.5 0 0 1 1.4.9L14 8.5M2 8.5h3.4l1 1.8h3.2l1-1.8H14",
  clock: "M8 4.8V8l2.2 1.4",
  pause: "M5.8 3.8v8.4M10.2 3.8v8.4",
  up: "M8 10.6V5.6M5.8 7.6 8 5.4l2.2 2.2",
  search: "m10.4 10.4 3 3",
  shield: "M8 2.2 13 4.3v3.6c0 3-2 5-5 5.9-3-.9-5-2.9-5-5.9V4.3z",
  clip: "M10.6 5.1 6.2 9.5a1.6 1.6 0 0 0 2.3 2.3l4.6-4.6a3 3 0 0 0-4.3-4.3L4.2 7.5a4.4 4.4 0 0 0 6.2 6.2l3.4-3.4",
  route: "M4.8 11.4c2.6-1 5.6-4 6.6-6.6",
  spark: "M8 2.4 9.3 6.7 13.6 8l-4.3 1.3L8 13.6 6.7 9.3 2.4 8l4.3-1.3z",
  door: "M9.5 2.5h3v11h-3M9.5 8h-7M4.9 5.6 2.5 8l2.4 2.4",
  sun: "M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1",
  info: "M8 7.4v3.4M8 5.2v.1",
  x: "m4.5 4.5 7 7M11.5 4.5l-7 7",
  check: "m3.5 8.5 3 3 6-6.5",
  menu: "M3 5.2h10M3 10.8h10",
  open: "M9.5 2.5h4v4M13.5 2.5 8.5 7.5M6.5 13.5h-4v-4M2.5 13.5 7.5 8.5",
  tag: "M2.6 7.4V3.2a.6.6 0 0 1 .6-.6h4.2a1 1 0 0 1 .7.3l5 5a1 1 0 0 1 0 1.4l-4.2 4.2a1 1 0 0 1-1.4 0l-5-5a1 1 0 0 1-.3-.7z",
  plus: "M8 3.6v8.8M3.6 8h8.8",
  chev: "m6 3.8 4.2 4.2L6 12.2",
  pen: "m3.2 12.8.7-2.9 7.2-7.2a1.45 1.45 0 0 1 2.05 2.05l-7.2 7.2-2.75.85zM9.9 3.9l2.1 2.1",

  /* — new, same grid, same stroke: the tab bar needs marks the rail never did — */
  /** reads: an open issue, two settled lines of text. */
  reads: "M2.4 4.1c1.9-.9 3.7-.9 5.6 0 1.9-.9 3.7-.9 5.6 0v8.2c-1.9-.9-3.7-.9-5.6 0-1.9-.9-3.7-.9-5.6 0zM8 4.1v8.2",
  /** receipts: a slip with a torn foot and a right-aligned total. */
  receipts: "M3.6 13.6V3.1a.6.6 0 0 1 .6-.6h7.6a.6.6 0 0 1 .6.6v10.5l-1.5-1-1.5 1-1.4-1-1.4 1-1.5-1zM6 5.6h4M6 8.2h2.4",
  /** more: the rail itself — three stacked destinations. */
  more: "M3 3.6h10M3 8h10M3 12.4h6",
} as const;

/** Icons that need a circle the path cannot carry — kept beside the path data. */
const CIRCLES: Partial<Record<IconName, { cx: number; cy: number; r: number }[]>> = {
  clock: [{ cx: 8, cy: 8, r: 5.6 }],
  up: [{ cx: 8, cy: 8, r: 5.6 }],
  search: [{ cx: 7, cy: 7, r: 4.4 }],
  route: [
    { cx: 3.4, cy: 12.6, r: 1.6 },
    { cx: 12.6, cy: 3.4, r: 1.6 },
  ],
  sun: [{ cx: 8, cy: 8, r: 2.6 }],
  info: [{ cx: 8, cy: 8, r: 5.8 }],
  tag: [{ cx: 5.6, cy: 5.6, r: 0.9 }],
};

export interface IconProps extends Omit<SvgProps, "color"> {
  name: IconName;
  size?: number;
  color: string;
  /** Stroke weight on the 16-grid; the prototype's own default is 1.3. */
  weight?: number;
}

export function Icon({ name, size = 15, color, weight = 1.3, ...rest }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" {...rest}>
      {(CIRCLES[name] ?? []).map((c, i) => (
        <Circle
          key={i}
          cx={c.cx}
          cy={c.cy}
          r={c.r}
          stroke={color}
          strokeWidth={weight}
          fill="none"
        />
      ))}
      <Path
        d={PATHS[name]}
        stroke={color}
        strokeWidth={weight}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

/**
 * The "oh." wordmark — the product mark, not a redraw of it.
 *
 * The two glyph outlines and the dot are the exact geometry from the product
 * mark's master SVG (letterforms outlined from Inter Bold, optically
 * refined for the mark; the master is a design source and is not published).
 * Only the viewBox differs: it crops the 1024 icon
 * canvas to the mark's own bounding box so the wordmark can sit inline in a
 * top bar without the squircle plate around it.
 */
const OH_O =
  "M306.64 706.00L306.64 706.00Q263.53 706.00 231.96 687.39Q200.40 668.79 183.34 635.56Q166.27 602.33 166.27 558.19L166.27 558.19Q166.27 513.80 183.34 480.44Q200.40 447.08 231.96 428.47Q263.53 409.87 306.64 409.87L306.64 409.87Q349.75 409.87 381.31 428.47Q412.87 447.08 429.94 480.44Q447.00 513.80 447.00 558.19L447.00 558.19Q447.00 602.33 429.94 635.56Q412.87 668.79 381.31 687.39Q349.75 706.00 306.64 706.00ZM306.64 645.44L306.64 645.44Q337.43 645.44 353.08 620.54Q368.73 595.65 368.73 557.93L368.73 557.93Q368.73 519.95 353.08 495.19Q337.43 470.43 306.64 470.43L306.64 470.43Q275.84 470.43 260.32 495.19Q244.79 519.95 244.79 557.93L244.79 557.93Q244.79 595.65 260.32 620.54Q275.84 645.44 306.64 645.44Z";
const OH_H =
  "M566.05 534.32L566.05 534.32L566.05 700.35L489.07 700.35L489.07 318.00L564.51 318.00L564.51 468.38Q577.09 440.41 598.64 425.14Q620.20 409.87 652.01 409.87L652.01 409.87Q696.66 409.87 723.74 438.61Q750.81 467.35 750.81 517.90L750.81 517.90L750.81 700.35L673.57 700.35L673.57 531.25Q673.57 504.56 659.84 489.42Q646.11 474.28 621.74 474.28L621.74 474.28Q597.10 474.28 581.58 490.06Q566.05 505.84 566.05 534.32Z";

export function Wordmark({ color, dot, size = 16 }: { color: string; dot: string; size?: number }) {
  return (
    <Svg width={size * 1.86} height={size} viewBox="156 308 758 408" accessibilityLabel="ohmail">
      <Path d={OH_O} fill={color} />
      <Path d={OH_H} fill={color} />
      <Circle cx={849.39} cy={651.07} r={54.16} fill={dot} />
    </Svg>
  );
}
