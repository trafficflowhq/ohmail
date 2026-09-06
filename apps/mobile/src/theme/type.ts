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
 *    Every value below is derived from `typography.size`, half-points
 *    included, and the reading band carries the phone type step: this app is
 *    always a phone, so the 10.5–15.5 roles are the token's number **plus
 *    `PHONE_STEP`**, and nothing at 16 and above moves. `PHONE_STEP` below
 *    states the rule and the reasoning.
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
import { typography } from "@ohmail/tokens";

/** `typography.size` is authored as CSS strings; RN wants points. */
const px = (v: string) => Number(v.replace("px", ""));
const tSize = typography.size;

/**
 * THE PHONE TYPE STEP — the whole rule, stated here because this is the only
 * place it is applied.
 *
 * The type scale is deliberately denser than either platform's default, and it
 * was one notch too dense to read comfortably on a phone: rows set the sender
 * at 13, the subject at 13.5, the preview at 12, and timestamps and addresses
 * at 11, against an Android status-bar clock at 14sp, Material's body-medium at
 * 14 and label-small at 11, and iOS's footnote at 13. So every reading role
 * from 10.5 through 15.5 moves up EXACTLY ONE POINT, and the density is
 * otherwise kept. One point, not two: at 13→14 that is +7.7% and at 11→12 it is
 * +9%, which leaves every size on the half-point ladder this scale is built on
 * and every hierarchy relation (sender over subject over preview) intact.
 *
 * The four rules that bound it:
 *
 *  · **Nothing at 16 and above moves.** Titles, the message subject, the
 *    held-mail title, the reader subject and the protected verification code
 *    are already at or above the platforms' body size; stepping them would be a
 *    redesign of the hierarchy rather than a legibility fix.
 *  · **The floor for information-bearing text is 12.** Timestamps, addresses,
 *    the waterline and notes were the roles sitting under what both platforms
 *    put on text a reader has to take a fact from; after the step they are 12.
 *  · **Text inputs are 16 wherever a page can zoom.** That is a browser rule —
 *    Safari zooms on focus of anything smaller — so it binds the web shell and
 *    not this app, which has no page to zoom. Recorded here so the two surfaces
 *    can be compared without going looking.
 *  · **A mark is not text.** The wordmark sits inside the band and does not
 *    step, because it is artwork at a fixed size rather than something read.
 *
 * The web shell reaches the same numbers from the same tokens through a
 * width-driven custom property, so one phone sets the row sender at 14 in a
 * browser and in this app alike.
 *
 * One constant, one place: set it to 0 and every size below is the token's own
 * number again, which is what `test/theme.test.ts` watches.
 */
export const PHONE_STEP = 1;

/**
 * Px sizes derived from `typography.size`, by role — the reading band plus
 * `PHONE_STEP`, the rest verbatim. The trailing comment on each line is the
 * value this app renders today.
 */
export const size = {
  /** badges, tag chips */ micro: px(tSize.micro) + PHONE_STEP, // 11.5
  /** tab labels, hints, timestamps, waterline */ caption: px(tSize.caption) + PHONE_STEP, // 12
  /** chips, meta labels, small controls */ label: px(tSize.label) + PHONE_STEP, // 12.5
  /** decision buttons, view meta, notes */ bodyS: px(tSize.bodyS) + PHONE_STEP, // 13
  /** buttons, compose CTA, from-line */ control: px(tSize.control) + PHONE_STEP, // 13.5
  /** rows (sender), body copy, settings labels */ body: px(tSize.body) + PHONE_STEP, // 14
  /** subjects, stream/held bodies */ bodyL: px(tSize.bodyL) + PHONE_STEP, // 14.5
  /** root */ base: px(tSize.base) + PHONE_STEP, // 15
  /** reading body, search input */ prose: px(tSize.prose) + PHONE_STEP, // 15.5
  /** wordmark — a mark, not text */ wordmark: px(tSize.wordmark), // 15
  /** reader body — the exhale */ proseReader: px(tSize.proseReader) + PHONE_STEP, // 16.5
  /** focus-reply title, protected code */ h4: px(tSize.h4), // 16
  /** stream-card title */ cardTitle: px(tSize.cardTitle), // 16.5
  /** held-mail title */ heldTitle: px(tSize.heldTitle), // 17
  /** view h1 (mobile — this app's h1) */ h1: px(tSize.h1Mobile), // 22
  /** message subject h2 */ h2: px(tSize.h2), // 24
  /** reader subject */ readerTitle: px(tSize.readerTitle), // 29
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
  /* THE AI'S SUGGESTED DESTINATION IS `decision` IN THE HEAVY GRADE, NOT A SMALLER ROLE.
     The web marks the suggestion by ring, accent and weight 650 at the SAME size as the
     siblings it sits beside (`split-button.css:6,14,16`) — the mark is the emphasis, and the
     size is what keeps the row one row. This site used to reach that emphasis by borrowing
     `pileTitle` and pulling it back down with an inline `fontSize: 12`, which left it one
     point UNDER the neighbouring `decision` at 13 and carried `pileTitle`'s tracking. */
  decisionAi: t({ size: size.bodyS, weight: weight.heavy }),
  /* A HINT IS A CAPTION THAT WRAPS. `caption` carries no leading because the roles it was
     drawn for — a row's timestamp, a tab label — are single lines, and a multi-line caption
     then falls back to the platform's own line box (~1.33 at 12). The web's hints run 1.5
     (`settings.css:65`), so the explanatory captions under a control take that here. */
  hint: t({ size: size.caption, weight: weight.regular, leading: leading.base }),
  pileTitle: t({ size: size.bodyL, weight: weight.heavy, tracking: tracking.heading }),
  settingsLabel: t({ size: size.body, weight: weight.bold }),
  sectionLabel: t({ size: size.bodyS, weight: weight.bold, tracking: tracking.name }),
  protectedCode: t({ size: size.h4, weight: weight.medium, tracking: tracking.code }),
} as const;

export type TypeRole = keyof typeof type;
