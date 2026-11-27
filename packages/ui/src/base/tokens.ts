/**
 * The kit's one door to the design's values in TypeScript. Every other file of the kit imports
 * from here, so the package border is one line long.
 */
export { design, v } from "@ohmail/tokens/design";
export { pullMark, pullMarkStyle } from "@ohmail/tokens";
import { motion } from "@ohmail/tokens/design";
export type { MotionRole, TokenName } from "@ohmail/tokens/design";

export const openingReloadDelay = Number.parseInt(motion.slick["d-opening-reload"], 10);
