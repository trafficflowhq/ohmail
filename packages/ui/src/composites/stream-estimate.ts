/**
 * Estimates a reading-stream card's height before the browser lays it out.
 * `.scast` carries `content-visibility: auto`, so an unvisited card's box
 * height is this estimate; when the real height replaces it mid-scroll,
 * everything below moves (a flat 200 once moved a visible card 453px).
 * The estimate reads the card's own data and need not be exact — the
 * browser keeps the measured height after the first pass — it must stop
 * being 200 for a card that is 650. Width is a parameter (characters per
 * line depend on the column); constants are stream.css's own numbers.
 */

/** `.sc-head{padding:20px 26px 0}` — the head's top padding, and its side padding. */
const HEAD_PAD_TOP = 20;
const HEAD_PAD_X = 26;
/**
 * `.sc-line`'s own line box. Measured 19px in a 620px card and 21px in a 358px one, so 20 is
 * the middle of the band the product is read at and the error it carries is one pixel.
 */
const LINE_H = 20;
/** `.sc-head h3{font-size:16.5px;line-height:1.3;margin:5px 0 0}` — exact, not an estimate. */
const SUBJECT_LINE_H = 16.5 * 1.3;
const SUBJECT_MARGIN_TOP = 5;
/**
 * The average advance of one subject character, as a fraction of 16.5px.
 *
 * MEASURED, not assumed, and the assumed value was 0.5 which is where a 116px median error came
 * from. Against the fixture's own cards: a 306px column took ~28 characters per line and a 568px
 * one ~56 — `306 / 28 = 10.9px` and `568 / 56 = 10.1px` at 16.5px, i.e. 0.61–0.66em. The subject
 * is set at weight 650 with -0.015em tracking, which is why it is wider than a body character.
 */
const SUBJECT_CHAR_EM = 0.62;
/**
 * The recipients block (`.msg-rcpts`) holds chips that wrap, so its height
 * is a function of the column: measured 60px at a 568px inner width and
 * 142px at 306px; a single constant was 34, the largest error term at 390.
 * A straight line between the two readings, clamped at both ends — an
 * interpolation, not a model of chip wrapping.
 */
const RCPTS_AT = [
  { inner: 306, h: 142 },
  { inner: 568, h: 60 },
] as const;
/** `.sc-rcpts{margin-top:2px}` + `.msg-rcpts{margin-top:6px}` — the air above the block. */
const RCPTS_MARGIN = 6;
/** `.sc-body{padding:9px 26px 18px}`, and its measured line box (13.5px at 1.7, plus the scale). */
const BODY_PAD_Y = 27;
const BODY_LINE_H = 24;
const BODY_SIZE = 13.5;
const BODY_CHAR_EM = 0.5;
/**
 * `.sc-body{max-width:62ch}` — the preview's column is 62 CHARACTERS by declaration, so this one
 * is not an estimate either.
 */
const BODY_CHARS_PER_LINE = 62;
/**
 * `.sc-x`'s drawn height, and it has two: `@media (max-width:640px){.sc-x{min-height:44px}}` is
 * the thumb's target, and above that breakpoint the pill is its own 27px. Measured at both. The
 * margins (`margin:2px auto 20px`) are the same either side of the breakpoint.
 */
const PILL_TOUCH_H = 44;
const PILL_POINTER_H = 27;
const PILL_MARGINS = 22;
/** `.sc-clip{max-height:348px}` — a collapsed preview can never be taller than the clamp. */
const CLAMP = 348;
/** What a card with no width to reason from reserves — the value this file replaces. */
export const STREAM_CARD_FALLBACK_PX = 200;

export interface StreamCardEstimateInput {
  /** The card's own `offsetWidth`. `0` (never laid out, or jsdom) ⇒ the fallback. */
  width: number;
  subject: string;
  /** The preview text on screen while the card is collapsed — the snippet or the body. */
  preview: string;
  /** Whether the head draws the recipients block (two or more recipients). */
  recipients?: boolean;
  /** Whether the expand pill is drawn — a `short`, fully-loaded card has none. */
  pill?: boolean;
  /**
   * Whether the pill is drawn at its 44px touch size — the `max-width: 640px` breakpoint, which
   * is a fact about the WINDOW and not about the card, so the caller reads it.
   */
  touch?: boolean;
  /**
   * True when this card's preview will be the clamped body rather than the
   * snippet — in the reading streams that is every card: `onNear` hydrates
   * a card as it approaches, so the layout the browser performs is the
   * hydrated one. Estimating from the two-line snippet reserved such cards
   * at snippet height (e.g. 353 → 545 before this flag existed).
   */
  clamped?: boolean;
}

/** Lines a run of `chars` characters takes in a column `px` wide at `size` px, at least one. */
function wrap(chars: number, px: number, size: number, em: number, cap = Infinity): number {
  if (px <= 0) return 1;
  const perLine = Math.min(cap, Math.max(1, Math.floor(px / (size * em))));
  return Math.max(1, Math.ceil(chars / perLine));
}

/**
 * Lines a PREVIEW takes, respecting the newlines it carries.
 *
 * `.sc-body{white-space:pre-line}` keeps the sender's own line breaks, so counting characters
 * against a column and ignoring them under-counts every plain-text mail — a four-paragraph body
 * is at least seven lines however short its sentences are.
 */
function previewLines(text: string, px: number): number {
  let n = 0;
  for (const line of text.split("\n")) {
    n += line.length === 0 ? 1 : wrap(line.length, px, BODY_SIZE, BODY_CHAR_EM, BODY_CHARS_PER_LINE);
  }
  return Math.max(1, n);
}

/** The recipients block's height at this column — the two-point line above. */
function recipientsHeight(inner: number): number {
  const [a, b] = RCPTS_AT;
  const slope = (b.h - a.h) / (b.inner - a.inner);
  return Math.min(a.h, Math.max(b.h, a.h + slope * (inner - a.inner)));
}

/**
 * The height to reserve for one collapsed stream card.
 *
 * It is the card's own CONTENT BOX and deliberately excludes `.scast`'s 20px bottom margin: the
 * value is consumed by `contain-intrinsic-size`, which is a content size, and adding the margin
 * put a systematic 20px into every card's estimate.
 *
 * Deterministic: the same inputs give the same answer on every engine, which is what lets the
 * value be written once into a custom property and never re-derived.
 */
export function estimateCardHeight(input: StreamCardEstimateInput): number {
  const { width, subject, preview, recipients = false, pill = true, touch = false, clamped = false } = input;
  if (!(width > 0)) return STREAM_CARD_FALLBACK_PX;
  const inner = Math.max(1, width - HEAD_PAD_X * 2);

  let h = HEAD_PAD_TOP + LINE_H;
  h += SUBJECT_MARGIN_TOP + wrap(subject.length, inner, SUBJECT_LINE_H / 1.3, SUBJECT_CHAR_EM) * SUBJECT_LINE_H;
  if (recipients) h += recipientsHeight(inner) + RCPTS_MARGIN;

  h += clamped ? CLAMP : Math.min(CLAMP, BODY_PAD_Y + previewLines(preview, inner) * BODY_LINE_H);

  if (pill) h += (touch ? PILL_TOUCH_H : PILL_POINTER_H) + PILL_MARGINS;
  return Math.round(h);
}
