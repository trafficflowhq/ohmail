"use client";

/**
 * THE BLOCKING DISCLOSURE, WORN AS A GLYPH — one component for every sentence the sanitizer has
 * to say about what it refused.
 *
 * `MessageBody` renders a mail and, above it, a bar: "A tracking pixel was blocked." — or "3
 * remote images blocked. One of them is a tracking pixel." or "A remote stylesheet was blocked, so
 * this message may look plain." In the reading pane that bar is right: one message, one strip,
 * and the "Show images" button beside the sentence is the thing a reader came for. In the reading
 * STREAM it was wrong: a full-width boxed line above every such card, spending a line of a surface
 * built for skimming on a fact that is true, rarely wanted, and identical from card to card.
 *
 * So the stream's card states it in its own head — the sender · address · time line — as a
 * two-word caption and the (i) glyph, with the whole sentence in the glyph's card (`Gloss`, the
 * shared detail-on-demand primitive: hover, focus and a press open it; Escape and a press outside
 * close it; it is reachable by keyboard and by a finger, and its sentence is the trigger's
 * accessible description while the card is closed, so a screen reader announces the caption and
 * then the sentence). The fact does not get quieter than that: it is in the DOM and in the
 * accessibility tree for every affected message, and "blocked" stays true of the document — this
 * file changes where the sentence stands, never whether the block happens.
 *
 * ── ONE COMPONENT, ONE CAPTION SLOT, THREE SIBLINGS ─────────────────────────────────────────
 *
 * The bar composes its sentence from eight catalogue keys in `mailBody`; every one of them is a
 * NOTICE (a statement that something was refused) and every one headlines one of three captions:
 *
 *   pixel    a tracking pixel was among what was refused — the privacy fact this product is named
 *            for leads even when pictures were refused beside it ("Tracker blocked")
 *   images   remote pictures were refused and none of them was a beacon ("Images blocked")
 *   sheet    only a remote stylesheet was refused ("Stylesheet blocked")
 *
 * The table below is that mapping and it is the CENSUS: `test/tracking-notice.test.tsx` holds
 * every `mailBody` sentence that says something was blocked against it, and every caption it names
 * against both catalogues. A sibling added to the bar without a row here is red before it ships,
 * which is the point — the treatment is one shape, never a fourth.
 *
 * The caption is a NAME, not the sentence shortened, and never a colour that reads as an error:
 * a block is the product doing what it says, not a fault. There is no warning sibling among these
 * eight — a failed block or a phishing signal would keep a visible line, and none exists in the
 * namespace today.
 *
 * COPY-FREE, deliberately. `MessageBody` owns the `mailBody` namespace (its `COPY` table is the
 * parity oracle, `test/locale-shim-parity.test.ts`), so the resolved caption and sentence arrive
 * here already read; this file only knows the shape and the key names. That is also what keeps
 * the import graph a tree: `MessageBody` imports the table from here, never the other way round.
 */

import { Gloss } from "@ohmail/ui";

/** Which of the three captions a notice headlines. */
export type NoticeKind = "pixel" | "images" | "sheet";

/** The caption key each kind reads out of `mailBody`. */
export const CAPTION_KEY = {
  pixel: "pixelCaption",
  images: "imagesCaption",
  sheet: "sheetCaption",
} as const satisfies Record<NoticeKind, string>;

export type CaptionKey = (typeof CAPTION_KEY)[NoticeKind];

/**
 * EVERY NOTICE SENTENCE IN `mailBody`, AND THE CAPTION IT HEADLINES.
 *
 * `pixelOne`/`pixelMany` are said INSIDE an images sentence ("3 remote images blocked. One of them
 * is a tracking pixel.") and headline the pixel caption all the same: when a beacon was among the
 * refused pictures, the beacon is the fact.
 */
export const NOTICE_CAPTION = {
  blockedOne: "images",
  blockedMany: "images",
  pixelOne: "pixel",
  pixelMany: "pixel",
  pixelOnly: "pixel",
  pixelsRefusedMany: "pixel",
  sheetOne: "sheet",
  sheetMany: "sheet",
} as const satisfies Record<string, NoticeKind>;

export type NoticeKey = keyof typeof NOTICE_CAPTION;

/** What `MessageBody` hands its host: which caption, and both strings already resolved. */
export interface BlockNotice {
  kind: NoticeKind;
  /** The two-word caption, in the active locale — what the trigger is CALLED. */
  caption: string;
  /** The whole sentence (or sentences, space-joined), as the bar would have said it — what the
   *  trigger DESCRIBES. */
  text: string;
}

/**
 * The glyph, in a meta line. `placement="meta"` sizes the (i) to an 11–12px line; `mb-notice` is
 * the hook the stream's stylesheet and the tests read. Everything about opening, closing, focus
 * and placement is the primitive's — nothing is re-decided here.
 */
export function BlockNoticeGloss({ notice }: { notice: BlockNotice }) {
  return <Gloss placement="meta" caption={notice.caption} text={notice.text} className="mb-notice" />;
}
