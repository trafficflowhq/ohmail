"use client";

/**
 * The blocking disclosure, worn as a glyph — one component for every sentence the sanitizer has to say about what it
 * refused. The full-width bar above every affected card spent a line of a skimming surface on a fact that is true,
 * rarely wanted, and identical from card to card; every surface now states it in its own meta line as a two-word
 * caption plus the (i) glyph, with the whole sentence in the glyph's `Gloss` card (hover, focus and press open;
 * keyboard and finger reachable; the sentence is the trigger's accessible description).
 */

/**
 * Where the header has a "details" disclosure it prints the sentence in full as well. The fact gets no quieter: it is
 * in the DOM and the accessibility tree for every affected message, and "blocked" stays true of the document — this
 * changes where the sentence stands, never whether the block happens (`test/block-notice-surfaces.test.tsx` holds
 * every mounting surface).
 */

/**
 * One component, one caption slot, three siblings: `pixel` — a tracking pixel was among what was refused (the privacy
 * fact leads even when pictures were refused beside it); `images` — remote pictures, none a beacon; `sheet` — only a
 * remote stylesheet. The table below is the CENSUS: `test/tracking-notice.test.tsx` holds every `mailBody`
 * blocked-sentence against it and every caption against both catalogues, so a sibling added without a row here is red
 * before it ships.
 */

/**
 * The caption is a NAME, never a colour that reads as an error — a block is the product doing what it says; no
 * warning sibling exists in the namespace today. Copy-free, deliberately: `MessageBody` owns the `mailBody`
 * namespace, so caption and sentence arrive resolved — which also keeps the import graph a tree (`MessageBody`
 * imports the table from here, never the other way).
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
