/**
 * Blanc typography for React Native.
 *
 * Blanc's type is one well-tuned system sans at fixed px sizes — product UI,
 * not fluid type. `typography.family.ui` leads with `-apple-system`, so RN's
 * default family (SF Pro on iOS, Roboto on Android) *is* the token; no font is
 * bundled and none should be.
 *
 * TWO THINGS TRANSLATE EXACTLY, ONE DOES NOT.
 *
 *  · **Size** — RN's `fontSize` is density-independent points, CSS px at 1×.
 *    Every value below is the token's own number, half-points included.
 *  · **Leading** — CSS `line-height` is a multiplier of the font size and RN's
 *    `lineHeight` is the absolute line box, so `size × multiplier` is exact.
 *    (The retired macOS port had to subtract SF Pro's intrinsic 1.21× first; RN
 *    does not stack lines that way, so this port is closer to the prototype.)
 *  · **Weight — the one lossy step.** Blanc's signature is a micro-graded
 *    scale, 450 / 500 / 550 / 600 / 650, that never jumps a full hundred where
 *    fifty reads calmer. `TextStyle.fontWeight` in RN accepts whole hundreds
 *    only (100…900); iOS maps them onto `UIFont.Weight`, Android onto the
 *    nearest available Roboto cut. There is no half-step to reach, and no
 *    variable-axis API to reach it with. So the five grades compress onto four
 *    platform steps:
 *
 *        css 450  regular   → '400'   .regular
 *        css 500  medium    → '500'   .medium
 *        css 550  semibold  → '600'   .semibold   ← rounds up
 *        css 600  bold      → '600'   .semibold   ← the collision
 *        css 650  heavy     → '700'   .bold
 *
 *    550 and 600 land together. That is the least damaging place to fold,
 *    because the two roles never meet on one line: 550 is decision buttons and
 *    small controls, 600 is row senders and view headings. Folding 600↔650
 *    instead would flatten the wordmark and the pile titles against ordinary
 *    row text, which is a visible loss; folding 450↔500 would thicken body
 *    copy, which is a legibility change. `test/theme.test.ts` pins the table so
 *    the compromise cannot quietly move.
 */
import type { TextStyle } from "react-native";

/** Exact px sizes from `typography.size`, by role. */
export const size = {
  /** kbd keycaps, badges, footers */ micro: 10.5,
  /** tab labels, hints, timestamps, waterline */ caption: 11,
  /** chips, meta labels, small controls */ label: 11.5,
  /** decision buttons, view meta, notes */ bodyS: 12,
  /** buttons, compose CTA, from-line */ control: 12.5,
  /** rows (sender), body copy, settings labels */ body: 13,
  /** subjects, stream/held bodies */ bodyL: 13.5,
  /** root */ base: 14,
  /** reading body, search input */ prose: 14.5,
  /** wordmark */ wordmark: 15,
  /** reader body — the exhale */ proseReader: 15.5,
  /** focus-reply title, protected code */ h4: 16,
  /** stream-card title */ cardTitle: 16.5,
  /** held-mail title */ heldTitle: 17,
  /** view h1 (mobile — this app's h1) */ h1: 22,
  /** message subject h2 */ h2: 24,
  /** reader subject */ readerTitle: 29,
} as const;

/**
 * The compression table above, as code. Keys are the CSS weights Blanc
 * authored; values are what RN can actually ask the platform for.
 */
export const weight = {
  /** css 450 */ regular: "400",
  /** css 500 */ medium: "500",
  /** css 550 */ semibold: "600",
  /** css 600 */ bold: "600",
  /** css 650 */ heavy: "700",
} as const satisfies Record<string, TextStyle["fontWeight"]>;

/** Letter-spacing, authored in em; RN wants points, so `em × size`. */
export const tracking = {
  /** view h1 / message h2 */ display: -0.025,
  /** wordmark */ wordmark: -0.02,
  /** card titles */ title: -0.015,
  /** pile headings, topbar */ heading: -0.01,
  /** row subjects */ subject: -0.008,
  /** row sender names */ name: -0.005,
  /** protected verification code */ code: 0.18,
} as const;

/** CSS line-height multipliers. */
export const leading = {
  /** message h2 */ tight: 1.25,
  /** card titles */ heading: 1.3,
  /** notes, decision consequence line */ snug: 1.45,
  /** base */ base: 1.5,
  /** hints, small prose */ relaxed: 1.55,
  /** compose editor, inputs */ input: 1.65,
  /** stream / held bodies */ body: 1.7,
  /** reading body */ prose: 1.72,
  /** reader body — the exhale */ reader: 1.78,
} as const;

interface TypeSpec {
  size: number;
  weight: TextStyle["fontWeight"];
  /** em */
  tracking?: number;
  /** multiplier */
  leading?: number;
}

function t({ size: s, weight: w, tracking: tr, leading: le }: TypeSpec): TextStyle {
  const style: TextStyle = { fontSize: s, fontWeight: w };
  if (tr !== undefined) style.letterSpacing = s * tr;
  if (le !== undefined) style.lineHeight = Math.round(s * le * 100) / 100;
  return style;
}

/**
 * Named presets for the roles that recur across screens — the same set the
 * retired macOS port carried, so a role means one thing on every surface.
 */
export const type = {
  wordmark: t({ size: size.wordmark, weight: weight.heavy, tracking: tracking.wordmark }),
  h1: t({ size: size.h1, weight: weight.bold, tracking: tracking.display }),
  h2: t({ size: size.h2, weight: weight.bold, tracking: tracking.display, leading: leading.tight }),
  readerTitle: t({
    size: size.readerTitle,
    weight: weight.bold,
    tracking: tracking.display,
    leading: leading.tight,
  }),
  cardTitle: t({
    size: size.cardTitle,
    weight: weight.bold,
    tracking: tracking.title,
    leading: leading.heading,
  }),
  heldTitle: t({
    size: size.heldTitle,
    weight: weight.bold,
    tracking: tracking.title,
    leading: leading.heading,
  }),
  rowSender: t({ size: size.body, weight: weight.bold, tracking: tracking.name }),
  rowSenderSeen: t({ size: size.body, weight: weight.medium, tracking: tracking.name }),
  rowSubject: t({ size: size.bodyL, weight: weight.medium, tracking: tracking.subject }),
  rowSubjectSeen: t({ size: size.bodyL, weight: weight.regular, tracking: tracking.subject }),
  body: t({ size: size.body, weight: weight.regular, leading: leading.base }),
  msgBody: t({ size: size.prose, weight: weight.regular, leading: leading.prose }),
  readerBody: t({ size: size.proseReader, weight: weight.regular, leading: leading.reader }),
  streamBody: t({ size: size.bodyL, weight: weight.regular, leading: leading.body }),
  meta: t({ size: size.bodyS, weight: weight.regular }),
  note: t({ size: size.bodyS, weight: weight.regular, leading: leading.snug }),
  caption: t({ size: size.caption, weight: weight.regular }),
  tabLabel: t({ size: size.caption, weight: weight.semibold, tracking: tracking.name }),
  navLabel: t({ size: size.body, weight: weight.regular }),
  navLabelOn: t({ size: size.body, weight: weight.bold }),
  chip: t({ size: size.label, weight: weight.regular, leading: leading.relaxed }),
  tagchip: t({ size: size.micro, weight: weight.bold }),
  badge: t({ size: size.micro, weight: weight.medium }),
  button: t({ size: size.control, weight: weight.semibold }),
  decision: t({ size: size.bodyS, weight: weight.semibold }),
  pileTitle: t({ size: size.bodyL, weight: weight.heavy, tracking: tracking.heading }),
  settingsLabel: t({ size: size.body, weight: weight.bold }),
  sectionLabel: t({ size: size.bodyS, weight: weight.bold, tracking: tracking.name }),
  protectedCode: t({ size: size.h4, weight: weight.medium, tracking: tracking.code }),
} as const;

export type TypeRole = keyof typeof type;
