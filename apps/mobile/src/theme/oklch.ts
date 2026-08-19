/**
 * OKLCH → sRGB — the same conversion the retired native macOS client performed,
 * kept as this port's reference twin.
 *
 * Every Blanc token is authored in OKLCH (`packages/tokens/src/tokens.ts`).
 * React Native's style engine has no `oklch()` colour function, so the values
 * have to land as sRGB somewhere. They land *here*, once, with the authored
 * L/C/H kept verbatim — never re-typed as a hand-picked hex — so the phone and
 * the web client paint the same pixels from the same numbers.
 *
 * Conversion is Björn Ottosson's reference OKLab⇄linear-sRGB matrix followed by
 * the sRGB transfer function; out-of-gamut channels clamp to [0,1] (every Blanc
 * token is low-chroma enough that clamping is a no-op or a sub-LSB nudge).
 *
 * `test/theme.test.ts` asserts this module reproduces, to the byte, the hexes
 * recorded beside every token in `palette.ts` — hexes two independent ports
 * arrived at separately, which is the fidelity gate; a drifting one fails the
 * suite.
 */

/** An authored token colour: perceptual lightness, chroma, hue°, alpha. */
export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
  readonly a: number;
}

export function oklch(l: number, c: number, h: number, a = 1): Oklch {
  return { l, c, h, a };
}

/** Linear-sRGB components (pre-gamma, unclamped) — exposed for testing. */
export function linearSrgb({ l, c, h }: Oklch): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  // OKLab -> LMS' -> LMS
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ * l_ * l_;
  const M = m_ * m_ * m_;
  const S = s_ * s_ * s_;
  return [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
}

function encode(x: number): number {
  const v = Math.min(Math.max(x, 0), 1);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** Gamma-encoded, gamut-clamped 8-bit sRGB channels. */
export function srgb255(color: Oklch): [number, number, number] {
  const lin = linearSrgb(color);
  return [
    Math.round(encode(lin[0]) * 255),
    Math.round(encode(lin[1]) * 255),
    Math.round(encode(lin[2]) * 255),
  ];
}

/** `#rrggbb` — ignores alpha. Used to cross-check against the hexes recorded in palette.ts. */
export function hex(color: Oklch): string {
  const [r, g, b] = srgb255(color);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The string React Native consumes. Opaque tokens render as `#rrggbb` so they
 * read like the documented hex in review; translucent ones keep their alpha.
 */
export function css(color: Oklch): string {
  const [r, g, b] = srgb255(color);
  if (color.a >= 1) return hex(color);
  return `rgba(${r}, ${g}, ${b}, ${round(color.a)})`;
}

/** Same colour at a new alpha (a few tokens reuse a hue at new opacity). */
export function withAlpha(color: Oklch, a: number): Oklch {
  return { ...color, a };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
