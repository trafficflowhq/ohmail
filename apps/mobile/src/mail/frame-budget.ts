/**
 * What one phone frame may draw: the web frame's two bounds (`MAX_FRAME_ELEMENTS` and
 * `MAX_FRAME_TEXT_CHARS` in the web reader's `MessageBody`), counted over the tree the frame would
 * build, the shell's elements included and `<style>` text excluded. The web's parity test holds these
 * two equal to the web's; this file imports nothing so that test can read it as data.
 */
export const FRAME_BUDGET = { elements: 2_048, textChars: 131_072 } as const;

/** How many characters of the document one step of the count reads at most. */
export const FRAME_STEP_CHARS = 16_384;

/**
 * How much of the parse's counted work one step does before it pauses. A step ends at whichever bound it
 * reaches first, and the two costs add: characters are the tokenizer's, work is the tree builder's
 * comparisons of formatting elements. Not for text that sits directly inside a `<table>`: parse5 holds
 * that text and processes all of it inside the tag that ends it, so one such run is one step whatever its
 * work. One 32,768-character step with no work share had held a crafted 33 KB part for about 0.8 s.
 */
export const FRAME_STEP_WORK = 10_000;

/**
 * The longest document the frame hands the WebView, in characters. Measured on a test phone (a 192 MB
 * Java heap) with one picture named N times: 8.4 million characters drew with a 49 MB heap, 12.5 million
 * with 141 MB, 16.8 million drew an empty page with no error anywhere, and 30.5 million ran the app out
 * of memory. This is under half the first failure. A longer document is refused like a tree past
 * {@link FRAME_BUDGET}, and one its pictures would make longer is refused before they are written.
 */
export const PHONE_FRAME_MAX_CHARS = 8_000_000;
