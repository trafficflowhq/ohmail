import type { Size } from "../seam.js";

/**
 * WHICH JOURNEYS RUN AT EACH SMALLER SIZE. Every journey runs expanded; at medium and compact only the titles
 * listed here run. A seat adds its place's titles here in its own commit, once its place is drawn at that size.
 */
export const AT_SIZE: Readonly<Record<Exclude<Size, "expanded">, readonly string[]>> = {
  medium: [],
  compact: [],
};
