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
 * The longest document the frame hands the WebView on any phone, in characters. Measured on a test phone
 * (a 192 MB Java heap) with one picture named N times: 8.4 million characters drew, 16.8 million drew an
 * empty page with no error, 30.5 million ran the app out of memory. A smaller heap fails sooner (the
 * WebView copies the document into the Java heap), so each phone's own ceiling is
 * `phoneFrameMaxChars` in `frame-ceiling.ts`, which never exceeds this.
 */
export const PHONE_FRAME_MAX_CHARS = 8_000_000;

/**
 * Characters per MB of the app's memory class. Measured on one AVD with one non-ASCII character in the
 * text (a document of ASCII alone is held at one byte a character and fails later): at 64 MB 6.41 million
 * drew and 7.02 million ran out of memory, at 96 MB 10.99 and 12.06. 50,000 per MB is under half of the
 * longest that drew at each heap, so under half of its first failure.
 */
export const PHONE_FRAME_CHARS_PER_HEAP_MB = 50_000;

/** The ceiling of a low-RAM phone, and of one whose memory class cannot be read. */
export const PHONE_FRAME_FLOOR_CHARS = 4_000_000;
