/**
 * What the letter's body takes of this kit, from the files that hold it: no stylesheet of the kit's ground (the base
 * sheet, the token sheets) comes with them, so a page of the next design that draws a letter keeps its own.
 */
export { useOptionalTheme } from "./theme/ThemeProvider.js";
export { Gloss } from "./primitives/Gloss.js";
export { BODY_PAGE_CHARS, pageEnd, pageEnds } from "./format/long-text.js";
export type { TagHueName } from "./primitives/Chip.js";
