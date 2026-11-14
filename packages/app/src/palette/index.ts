/**
 * THE COMMAND PALETTE's door: an over of the frame. It lists every product's offers (`usePaletteOffers`), the
 * product on screen first, narrows them word by word and runs the one chosen; a row prints its keys only while the
 * keyboard registry holds a binding with its chord. Its own key (`mod+k`) is declared in the registry.
 */
import type { OverEntry } from "../frame/contract.js";
import { Palette } from "./Palette.js";

export const paletteOver: OverEntry = { id: "palette", Body: Palette };
export { narrow } from "./narrow.js";
