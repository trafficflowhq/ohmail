/**
 * What one phone frame may draw: the web frame's two bounds (`MAX_FRAME_ELEMENTS` and
 * `MAX_FRAME_TEXT_CHARS` in the web reader's `MessageBody`), counted over the tree the frame would
 * build, the shell's elements included and `<style>` text excluded. The web's parity test holds these
 * two equal to the web's; this file imports nothing so that test can read it as data.
 */
export const FRAME_BUDGET = { elements: 2_048, textChars: 131_072 } as const;

/** How much of the document one step of the count reads: about 40 ms on a phone. */
export const FRAME_STEP_CHARS = 32_768;
