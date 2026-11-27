/**
 * Blanc's thin geometric icon set, ported to `react-native-svg`. The paths in `PATHS` are copied
 * byte-for-byte from the `<symbol>` defs in `design/proposals/blanc/index.html`, on the same
 * 16×16 grid, with the prototype's own `svg.ic` rule (`stroke:currentColor; fill:none;
 * stroke-width:1.3; linecap/linejoin:round`). No icon was redrawn. Three glyphs have no
 * prototype twin, because the desktop rail is purely typographic and a phone tab bar is not:
 * `reads`, `receipts` and `more` are new, drawn on the same grid with the same stroke so they
 * sit in the set rather than beside it. They are marked below.
 */
import Svg, { Circle, Path, Rect, type SvgProps } from "react-native-svg";

export type IconName = keyof typeof PATHS;

const PATHS = {
  /* — verbatim from the prototype's symbol defs — */
  ohbox: "M2 8.5V12a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 12V8.5M2 8.5 4 3.6A1.5 1.5 0 0 1 5.4 2.7h5.2a1.5 1.5 0 0 1 1.4.9L14 8.5M2 8.5h3.4l1 1.8h3.2l1-1.8H14",
  calendar: "M3 4.2h10v9H3zM5.5 2.8v2.6M10.5 2.8v2.6M3 7h10M5.5 9.7h1",
  clock: "M8 4.8V8l2.2 1.4",
  pause: "M5.8 3.8v8.4M10.2 3.8v8.4",
  up: "M8 10.6V5.6M5.8 7.6 8 5.4l2.2 2.2",
  search: "m10.4 10.4 3 3",
  shield: "M8 2.2 13 4.3v3.6c0 3-2 5-5 5.9-3-.9-5-2.9-5-5.9V4.3z",
  clip: "M10.6 5.1 6.2 9.5a1.6 1.6 0 0 0 2.3 2.3l4.6-4.6a3 3 0 0 0-4.3-4.3L4.2 7.5a4.4 4.4 0 0 0 6.2 6.2l3.4-3.4",
  route: "M4.8 11.4c2.6-1 5.6-4 6.6-6.6",
  spark: "M8 2.4 9.3 6.7 13.6 8l-4.3 1.3L8 13.6 6.7 9.3 2.4 8l4.3-1.3z",
  screener: "M2.5 13.1h3V5.5L8 3.4h4.7v9.7h1.5M7.2 13.1h5.5M10.2 8.8h.1",
  hourglass: "M4.6 2.8h6.8M4.6 13.2h6.8M5.3 3c0 2.4 1 3.4 2.7 5-1.7 1.6-2.7 2.6-2.7 5m5.4-10c0 2.4-1 3.4-2.7 5 1.7 1.6 2.7 2.6 2.7 5",
  attachmentDownload: "M8 2.6v7.1m-2.6-2.6L8 9.7l2.6-2.6M3.4 11.4v1.9h9.2v-1.9",
  person: "M3.5 13c.4-2.6 2.1-4 4.5-4s4.1 1.4 4.5 4M8 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4",
  send: "M2.5 4 13.5 8 2.5 12l1.6-4L2.5 4ZM4.4 8h8.9",
  format: "M2.2 11.7 5 4.2l2.8 7.5M3.1 9h3.8m6.9 2.7V8.4a1.7 1.7 0 0 0-1.9-1.8c-.7 0-1.3.2-1.7.6m3.6 2.1h-2.3a1.3 1.3 0 0 0 0 2.6c1.1 0 2.3-.6 2.3-1.7",
  smile: "M13.4 8a5.4 5.4 0 1 1-10.8 0 5.4 5.4 0 0 1 10.8 0ZM5.7 9.3c.9 1.7 3.7 1.7 4.6 0M6 6.6h.1m3.8 0h.1",
  door: "M9.5 2.5h3v11h-3M9.5 8h-7M4.9 5.6 2.5 8l2.4 2.4",
  sun: "M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1",
  info: "M8 7.4v3.4M8 5.2v.1",
  x: "m4.5 4.5 7 7M11.5 4.5l-7 7",
  check: "m3.5 8.5 3 3 6-6.5",
  menu: "M3 5.2h10M3 10.8h10",
  diagonal: "M7 3.3h5.7V9M12.7 3.3 3.6 12.4",
  open: "M9.5 2.5h4v4M13.5 2.5 8.5 7.5M6.5 13.5h-4v-4M2.5 13.5 7.5 8.5",
  tag: "M2.6 7.4V3.2a.6.6 0 0 1 .6-.6h4.2a1 1 0 0 1 .7.3l5 5a1 1 0 0 1 0 1.4l-4.2 4.2a1 1 0 0 1-1.4 0l-5-5a1 1 0 0 1-.3-.7z",
  plus: "M8 3.6v8.8M3.6 8h8.8",
  chev: "m6 3.8 4.2 4.2L6 12.2",
  back: "M10 3.8 5.8 8l4.2 4.2",
  pen: "m3.2 12.8.7-2.9 7.2-7.2a1.45 1.45 0 0 1 2.05 2.05l-7.2 7.2-2.75.85zM9.9 3.9l2.1 2.1",

  /* — new, same grid, same stroke: the tab bar needs marks the rail never did — */
  /** reads: an open issue, two settled lines of text. */
  reads: "M2.4 4.1c1.9-.9 3.7-.9 5.6 0 1.9-.9 3.7-.9 5.6 0v8.2c-1.9-.9-3.7-.9-5.6 0-1.9-.9-3.7-.9-5.6 0zM8 4.1v8.2",
  /** receipts: a slip with a torn foot and a right-aligned total. */
  receipts: "M3.6 13.6V3.1a.6.6 0 0 1 .6-.6h7.6a.6.6 0 0 1 .6.6v10.5l-1.5-1-1.5 1-1.4-1-1.4 1-1.5-1zM6 5.6h4M6 8.2h2.4",
  /** more: the rail itself — three stacked destinations. */
  more: "M3 3.6h10M3 8h10M3 12.4h6",

  /* — the delete + folders wave, same grid, same stroke — */
  /** trash: the bin the delete verb names — a lid, a body, two staves. */
  trash: "M3.4 4.6h9.2M6.4 4.6V3.4a.7.7 0 0 1 .7-.7h1.8a.7.7 0 0 1 .7.7v1.2M4.6 4.6l.6 8a.8.8 0 0 0 .8.7h4a.8.8 0 0 0 .8-.7l.6-8M6.7 7.2v3.6M9.3 7.2v3.6",
  /** folder: one of the mailbox's own folders — the tab carries the identity. */
  folder: "M2.5 12.6V4.1a.7.7 0 0 1 .7-.7h3l1.4 1.7h5.2a.7.7 0 0 1 .7.7v6.8a.7.7 0 0 1-.7.7H3.2a.7.7 0 0 1-.7-.7z",
  download: "M8 2v8m-3-3 3 3 3-3M3 13h10",
  down: "m4 6 4 4 4-4",
  computer: "M2 3.5h12v8H2zM8 11.5v2.5m-2.5 0h5",
  phone: "M5 2h6v12H5zM7 12h2",

  /* — the glass rail's verbs, verbatim from the foldable prototype's ICONS table — */
  reply: "M6.2 4.2 2.6 7.6l3.6 3.4M3 7.6h6.2a3.6 3.6 0 0 1 3.6 3.6v1.2",
  replyall: "M8.4 4.6 5.4 7.6l3 2.8M5.2 4.6l-3 3 3 2.8M5.8 7.6h4.2a3.4 3.4 0 0 1 3.4 3.4v1",
  fwd: "M9.8 4.2l3.6 3.4-3.6 3.4M13 7.6H6.8a3.6 3.6 0 0 0-3.6 3.6v1.2",
  junk: "M4.1 4.1l7.8 7.8",
  filter: "M3 4.6h10M4.8 8h6.4M6.6 11.4h2.8",
  sidebar: "M6.5 3.2v9.6",
  mic: "M4 8.2a4 4 0 0 0 8 0M8 12.2v1.4",

  // Settings signs, from the web icon set on the native 16-point grid.
  settings: "M2.67 5.33h6m2.66 0h2M2.67 10.67h2m2.66 0h6",
  bell: "M4.33 11V7.33a3.67 3.67 0 0 1 7.34 0V11M3 11h10m-6.33 2a1.33 1.33 0 0 0 2.66 0",
  mail: "m2.67 4.67 5.33 4.33 5.33-4.33",
  disk: "M3.33 4.33a4.67 1.87 0 1 0 9.34 0 4.67 1.87 0 1 0-9.34 0zm0 0v7.34c0 2.5 9.34 2.5 9.34 0V4.33m-9.34 3.67c0 2.5 9.34 2.5 9.34 0",
  key: "M7.67 8h5.66m-2 0v2",
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
  junk: [{ cx: 8, cy: 8, r: 5.6 }],
  settings: [{ cx: 10, cy: 5.33, r: 1.33 }, { cx: 6, cy: 10.67, r: 1.33 }],
  key: [{ cx: 5.33, cy: 8, r: 2.33 }],
};

/** Icons that need a rounded rect beside their path — the prototype's `<rect>` halves. */
const RECTS: Partial<Record<IconName, { x: number; y: number; w: number; h: number; rx: number }[]>> = {
  sidebar: [{ x: 2.4, y: 3.2, w: 11.2, h: 9.6, rx: 1.8 }],
  mic: [{ x: 6.2, y: 2.4, w: 3.6, h: 7, rx: 1.8 }],
  mail: [{ x: 2.33, y: 3.67, w: 11.34, h: 8.66, rx: 1.33 }],
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
      {(RECTS[name] ?? []).map((r, i) => (
        <Rect
          key={i}
          x={r.x}
          y={r.y}
          width={r.w}
          height={r.h}
          rx={r.rx}
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


/** The compact web mail navigation signs, drawn on the same 24-point grid. */
const NAVIGATION_PATHS = {
  ohbox: "M4 13.5 6.2 6h11.6L20 13.5V18a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z M4 13.5h4.5a3.5 3.5 0 0 0 7 0H20",
  screener: "M7 20V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15 M4 20h16 M13.7 12.2v.6",
  reads: "M12 6.5C10.3 5.2 8 4.8 4 5v13c4-.2 6.3.2 8 1.5 1.7-1.3 4-1.7 8-1.5V5c-4-.2-6.3.2-8 1.5z M12 6.5v13",
  receipts: "M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z M9 8.5h6 M9 12.5h6",
  more: "M6 11.8v.4 M12 11.8v.4 M18 11.8v.4",
  search: "m16 16 4 4",
  down: "M6 9.5l6 6 6-6",
  pen: "M5 19l1-4.5L16.8 3.7a2 2 0 0 1 2.9 2.8L8.9 17.4z M14.5 6l3.5 3.5",
  calendar: "M4 10.5h16 M8.5 3.5v4 M15.5 3.5v4",
  later: "M7 4h10 M7 20h10 M8 4c0 4 4 5 4 8s-4 4-4 8 M16 4c0 4-4 5-4 8s4 4 4 8",
  parked: "M10 9v6 M14 9v6",
  resurface: "M4 19h16 M12 15V5 M7.5 9.5 12 5l4.5 4.5",
  move: "M4 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h7A1.5 1.5 0 0 1 20 9.5V17a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17z M9 13.5h6 M12.8 11.2l2.3 2.3-2.3 2.3",
  unread: "M14.6 6.5H5.5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-5.2 M4 8.2l8 5.6 3.4-2.4",
  history: "M4.5 12A7.5 7.5 0 1 0 12 4.5c-2.1 0-4.1.85-5.6 2.3L4.5 8.5 M4.5 4.5v4h4 M12 8v4.2l2.8 1.8",
  drafts: "M7.5 3.5H14l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1.5-1.5z M14 3.5V8h4 M9 13h6 M9 16.5h4",
  trash: "M5 7h14 M9.5 7V4.5h5V7 M7 7l.8 12a1.5 1.5 0 0 0 1.5 1.5h5.4a1.5 1.5 0 0 0 1.5-1.5L17 7",
  settings: "M4 8h9 M17 8h3 M4 16h3 M11 16h9",
  pull: "M19.5 12A7.5 7.5 0 1 1 12 4.5c2.1 0 4.1.85 5.6 2.3l1.9 1.7 M19.5 4.5v4h-4",
  moon: "M19.5 14.2A7.8 7.8 0 0 1 9.8 4.5a7.8 7.8 0 1 0 9.7 9.7z",
  sun: "M12 3.5v2 M12 18.5v2 M3.5 12h2 M18.5 12h2 M6 6l1.4 1.4 M16.6 16.6 18 18 M18 6l-1.4 1.4 M7.4 16.6 6 18",
} as const;

export type NavigationIconName = keyof typeof NAVIGATION_PATHS;

export function NavigationIcon({ name, color, size = 20 }: { name: NavigationIconName; color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {name === "search" ? <Circle cx={11} cy={11} r={6.5} /> : null}
      {name === "settings" ? <><Circle cx={15} cy={8} r={2} /><Circle cx={9} cy={16} r={2} /></> : null}
      {name === "sun" ? <Circle cx={12} cy={12} r={3.6} /> : null}
      {name === "unread" ? <Circle cx={19} cy={6} r={2.6} fill={color} stroke="none" /> : null}
      {name === "parked" ? <Rect x={4.5} y={4.5} width={15} height={15} rx={3} /> : null}
      {name === "calendar" ? <Rect x={4} y={5.5} width={16} height={14.5} rx={2.5} /> : null}
      {name === "calendar" ? <Path d="M8.6 15v.4" strokeWidth={2.6} /> : null}
      <Path d={NAVIGATION_PATHS[name]} strokeWidth={name === "more" ? 2.8 : undefined} />
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

/** Welcome uses the shared type mark. Its two outlines are from the admitted Bricolage Grotesque
 * 96pt ExtraBold font (OFL-1.1 in packages/tokens/fonts). The app icon keeps its own artwork. */
export function WelcomeWordmark({ color, dot, em }: { color: string; dot: string; em: number }) {
  return (
    <Svg width={1.32 * em} height={0.825 * em} viewBox="0 -700 1320 825" accessibilityLabel="ohmail">
      <Path fill={color} d="M282 14Q206 14 147 -16Q88 -47 55 -108Q22 -170 22 -263Q22 -360 56 -421Q91 -483 150 -512Q210 -542 285 -542Q363 -542 421 -511Q480 -481 512 -419Q545 -358 545 -264Q545 -167 510 -105Q476 -44 416 -15Q357 14 282 14ZM286 -105Q317 -105 338 -122Q359 -140 370 -174Q381 -208 381 -255Q381 -307 369 -342Q357 -378 334 -397Q312 -416 280 -416Q250 -416 229 -398Q208 -381 197 -347Q186 -313 186 -265Q186 -189 212 -147Q239 -105 286 -105Z" />
      <Path fill={color} transform="translate(517 0)" d="M36 0L36 -700L198 -700L198 -568Q198 -547 195 -512Q193 -478 188 -439Q184 -400 179 -364Q175 -329 172 -305L181 -305Q190 -388 212 -440Q234 -493 272 -517Q310 -542 364 -542Q449 -542 490 -481Q531 -421 531 -299L531 0L369 0L369 -292Q369 -348 354 -374Q339 -400 305 -400Q275 -400 251 -377Q227 -355 212 -306Q198 -257 198 -179L198 0Z" />
      <Circle cx={1195} cy={0} r={125} fill={dot} />
    </Svg>
  );
}
