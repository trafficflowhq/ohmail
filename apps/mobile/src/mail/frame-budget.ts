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
 * How much of the parse's counted work one step does at most. A step ends at whichever bound it reaches
 * first, and the two costs add: characters are the tokenizer's, work is the tree builder's comparisons of
 * formatting elements. One 32,768-character step with no work share had held a crafted 33 KB part for
 * about 0.8 s on a test phone.
 */
export const FRAME_STEP_WORK = 10_000;
